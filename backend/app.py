"""Elpis backend: one continuous conversation with a CBT companion, voice, breathing and Restworld."""

import hashlib
import hmac
import json
import logging
import os
import re
import time
import unicodedata
import uuid
from datetime import datetime
from pathlib import Path

import anthropic
import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

import db  # noqa: E402
import memory  # noqa: E402
import safety  # noqa: E402
from prompts import load  # noqa: E402

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("elpis")

MODEL = os.getenv("ELPIS_MODEL", "claude-sonnet-4-6")
ELEVEN_KEY = os.getenv("ELEVENLABS_API_KEY")
ELEVEN_VOICE = os.getenv("ELEVENLABS_VOICE_ID", "sBvsMygZdQhmlWowjJb0")
TAG_OPEN, TAG_CLOSE = "<elpis>", "</elpis>"

client = anthropic.Anthropic()
db.init()
app = FastAPI(title="Elpis")


# ---------- access: passcode + one private space per browser ----------
# With ELPIS_PASSCODE unset (running on your own machine) there's no gate and one user, "local".
# With it set (hosted), each browser that enters the passcode gets its own conversation and Restworld.

PASSCODE = os.getenv("ELPIS_PASSCODE", "").strip()
PASS_TOKEN = hmac.new(PASSCODE.encode(), b"elpis-access", hashlib.sha256).hexdigest() if PASSCODE else ""
YEAR = 365 * 24 * 3600
OPEN_PATHS = {"/api/unlock", "/api/access"}


@app.middleware("http")
async def passcode_gate(request: Request, call_next):
    path = request.url.path
    if PASSCODE and path.startswith("/api/") and path not in OPEN_PATHS:
        if not hmac.compare_digest(request.cookies.get("elpis_pass", ""), PASS_TOKEN):
            return JSONResponse({"detail": "locked"}, status_code=401)
    return await call_next(request)


def current_uid(request: Request) -> str:
    if not PASSCODE:
        return db.LOCAL
    uid = request.cookies.get("elpis_uid", "")
    if not re.fullmatch(r"[0-9a-f]{32}", uid):
        raise HTTPException(401, "locked")
    return uid


@app.get("/api/access")
def access(request: Request):
    return {"locked": bool(PASSCODE) and not hmac.compare_digest(request.cookies.get("elpis_pass", ""), PASS_TOKEN)}


class UnlockIn(BaseModel):
    passcode: str


@app.post("/api/unlock")
def unlock(body: UnlockIn, request: Request):
    if not PASSCODE:
        return {"ok": True}
    if not hmac.compare_digest(body.passcode.strip().lower(), PASSCODE.lower()):
        time.sleep(1)   # slow down guessing
        raise HTTPException(403, "That passcode doesn't match.")
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    res = JSONResponse({"ok": True})
    res.set_cookie("elpis_pass", PASS_TOKEN, max_age=YEAR, httponly=True, samesite="lax", secure=secure)
    uid = request.cookies.get("elpis_uid", "")
    if not re.fullmatch(r"[0-9a-f]{32}", uid):
        res.set_cookie("elpis_uid", uuid.uuid4().hex, max_age=YEAR, httponly=True, samesite="lax", secure=secure)
    return res


@app.get("/healthz")
def healthz():
    return {"ok": True}


# ---------- context building ----------

def _ago(seconds):
    if seconds < 3600:
        return "a few minutes"
    if seconds < 86400:
        return f"about {int(seconds // 3600)} hours"
    return f"about {int(seconds // 86400)} days"


def _about_her(uid, mode, local_time=None):
    name = db.get_name(uid)
    lines = [f"Her name is {name}." if name else "You don't know her name yet."]
    now = local_time or datetime.now().strftime("%A, %-I:%M %p")
    lines.append(f"It is {now} where she is.")
    last = db.last_message_time(uid)
    if last and time.time() - last > 3 * 3600:
        lines.append(f"It has been {_ago(time.time() - last)} since you last talked.")
    kept = db.moments(uid)
    if kept:
        titles = "; ".join(f'"{m["title"]}"' for m in kept[:8])
        lines.append(f"Moments she has kept in her Restworld ({len(kept)}): {titles}.")
    else:
        lines.append("She hasn't kept any moments in her Restworld yet.")
    if mode == "call":
        lines.append("RIGHT NOW YOU ARE ON A VOICE CALL with her: follow the Voice Calls guidance.")
    summary = db.get_summary(uid)
    if summary:
        lines.append(f"\nWhat you remember from earlier in your conversation:\n{summary}")
    return "\n".join(lines)


def _api_messages(uid, final_user_content):
    turns = []
    for m in db.active_messages(uid):
        if m["role"] == "event":
            role, text = "user", f"[App note: {m['content']}]"
        else:
            role, text = m["role"], m["content"]
            if m["mode"] == "call" and role == "user":
                text = f"(said on a call) {text}"
        if not text.strip():
            continue
        if turns and turns[-1]["role"] == role:
            turns[-1]["content"] += "\n\n" + text
        else:
            turns.append({"role": role, "content": text})
    if turns and turns[-1]["role"] == "user":
        turns[-1]["content"] += "\n\n" + final_user_content
    else:
        turns.append({"role": "user", "content": final_user_content})
    if turns[0]["role"] != "user":
        turns.insert(0, {"role": "user", "content": "[App note: she opened Elpis.]"})
    return turns


def _held_back(text):
    """Length of a trailing partial '<elpis>' so it never flashes in the UI."""
    for k in range(len(TAG_OPEN) - 1, 0, -1):
        if text.endswith(TAG_OPEN[:k]):
            return k
    return 0


def _split_reply(full):
    idx = full.find(TAG_OPEN)
    if idx < 0:
        return full.strip(), {}
    visible = full[:idx].strip()
    raw = full[idx + len(TAG_OPEN):].split(TAG_CLOSE)[0].strip()
    try:
        meta = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("Unparseable metadata block: %r", raw[:200])
        meta = {}
    sugg = [s for s in meta.get("suggestions") or [] if isinstance(s, str) and s.strip()][:3]
    action = meta.get("action") if meta.get("action") in ("journal", "rest_world", "breathe", "crisis") else None
    return visible, {"suggestions": sugg, "action": action,
                     "journal_prompt": meta.get("journal_prompt") if action == "journal" else None}


# Safety net for glimmers: if she shares a clearly good moment and Elpis forgot to offer journaling,
# offer it anyway (never in a crisis, never when the good word is negated: "not great").
GLIMMER = re.compile(r"\b(happy|happier|great|good|lovely|nice|amazing|wonderful|fun|excited|love|loved|enjoy(?:ed)?|"
                     r"beautiful|glad|grateful|proud|laugh(?:ed)?|smil(?:e|ed)|sunny|coffee|paint(?:ing)?|best)\b", re.I)
NEGATED = re.compile(r"\b(not|no|never|isn't|wasn't|don't|didn't|can't|couldn't|hardly|nothing)\W+(?:\w+\W+){0,2}?$", re.I)


HEAVY = re.compile(r"\b(hard|awful|sad|cry|crying|cried|tired|exhausted|lonely|alone|miss|missing|lost|loss|grief|"
                   r"grieving|hurt|hurts|pain|anxious|scared|worst|terrible|bad|miscarriage|baby|empty|numb)\b", re.I)


def _is_glimmer(text):
    if HEAVY.search(text):   # mixed or sarcastic ("great, another hard day"): leave it to Elpis
        return False
    for m in GLIMMER.finditer(text):
        if not NEGATED.search(text[:m.start()]):
            return True
    return False


def _journal_question(reply):
    questions = re.findall(r"[^.!?\n]*\?", reply)
    q = questions[-1].strip() if questions else ""
    return q if 8 <= len(q) <= 120 else "What made it so good?"


def _sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


# ---------- API ----------

class ChatIn(BaseModel):
    text: str | None = None
    event: str | None = None   # 'onboard' | 'call_start'
    mode: str = "chat"
    local_time: str | None = None   # from her device, e.g. "Thursday, 9:41 PM"


EVENT_NOTES = {
    "onboard": "She just opened Elpis for the first time and told you her name — this is the very start. "
               "Welcome her sweetly and warmly in 2-3 sentences and ask one gentle question about how she's doing. "
               "Offer easy suggestions.",
    "call_start": "She just started a voice call with you. Greet her the way a close friend picks up the phone — "
                  "one or two warm, casual sentences, using what you know about her.",
}


@app.post("/api/chat")
def chat(body: ChatIn, uid: str = Depends(current_uid)):
    mode = "call" if body.mode == "call" else "chat"
    text = (body.text or "").strip()[:4000]
    if not text and body.event not in EVENT_NOTES:
        raise HTTPException(400, "Empty message")

    crisis = safety.detect(text) if text else None
    if text:
        db.add_message(uid, "user", text, mode)
        final = text if mode == "chat" else f"(said on a call) {text}"
        if body.event in EVENT_NOTES:
            final += f"\n\n[App note: {EVENT_NOTES[body.event]}]"
        if crisis:
            final += (f"\n\n[App note: the safety guardrail detected possible {crisis} risk and is showing her "
                      "crisis resources on screen. Respond per the Safety section.]")
    else:
        final = f"[App note: {EVENT_NOTES[body.event]}]"
    messages = _api_messages(uid, final)

    def stream():
        card = safety.card(crisis)
        if card:
            yield _sse("safety", card)
        full, sent = "", 0
        try:
            with client.messages.stream(
                model=MODEL,
                max_tokens=2000,
                system=[
                    {"type": "text", "text": load("system"), "cache_control": {"type": "ephemeral"}},
                    {"type": "text", "text": _about_her(uid, mode, (body.local_time or "")[:40] or None)},
                ],
                messages=messages,
            ) as s:
                for chunk in s.text_stream:
                    full += chunk
                    idx = full.find(TAG_OPEN)
                    safe = idx if idx >= 0 else len(full) - _held_back(full)
                    if safe > sent:
                        yield _sse("delta", {"text": full[sent:safe]})
                        sent = safe
        except anthropic.APIError as e:
            log.exception("Claude API error")
            yield _sse("error", {"message": getattr(e, "message", str(e))})
            return
        visible, meta = _split_reply(full)
        if not crisis and meta.get("action") is None and text and _is_glimmer(text):
            meta["action"], meta["journal_prompt"] = "journal", _journal_question(visible)
        if crisis or meta.get("action") == "crisis":
            meta["safety"] = card or safety.card("suicide")
            meta["suggestions"] = []
        if meta.get("safety") and not card:
            yield _sse("safety", meta["safety"])
        msg_id = db.add_message(uid, "assistant", visible, mode, meta)
        yield _sse("done", {"id": msg_id, "text": visible, **meta})
        memory.compact_in_background(client, MODEL, uid)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------- onboarding: Elpis opens the chat by asking her name ----------

INTRO = "Hi, hello! I'm Elpis, your companion on this journey. What would you like me to call you?"
WELCOME = [
    "Nice to meet you, {name}!",
    "Your privacy matters here. What we discuss here is safe and secure. "
    "Feel free to call me whenever you'd like. I'm here as a friend.",
    "Whenever you want, tap the **+** at the top for little tools: mood check-ins, journaling, breathing and more. "
    "So tell me, how are you feeling right now?",
]
WELCOME_SUGGESTIONS = ["Pretty good today", "A little better", "Not sure yet"]
NAME_LEAD = re.compile(r"^(?:(?:hi|hello|hey|hiya)[\s,!.]*)*(?:you can |please )?(?:call me|i'?m|i am|my name is|my name's|it'?s|name'?s|this is)?\s*", re.I)


def _parse_name(reply):
    """'Call me, W' -> 'W'; 'hey I'm sarah!' -> 'Sarah'. Falls back to the reply itself."""
    rest = NAME_LEAD.sub("", reply.strip())
    keep = lambda ch: unicodedata.category(ch)[0] in "LMN" or ch in "'-"   # letters (any script), marks, digits
    words = ["".join(ch for ch in w if keep(ch)) for w in rest.split()]
    name = " ".join(w for w in words if w)[:24]
    name = " ".join(name.split()[:2])
    if not name:
        return "friend"   # she didn't give one; Elpis still greets her warmly
    return name[:1].upper() + name[1:]


class NameIn(BaseModel):
    text: str


@app.post("/api/onboard")
def onboard(body: NameIn, uid: str = Depends(current_uid)):
    reply = body.text.strip()[:200]
    if not reply:
        raise HTTPException(400, "Name required")
    name = _parse_name(reply)
    db.set_name(uid, name)
    db.add_message(uid, "user", reply)
    out = []
    for i, line in enumerate(WELCOME):
        last = i == len(WELCOME) - 1
        meta = {"suggestions": WELCOME_SUGGESTIONS} if last else None
        text = line.format(name=name)
        out.append({"id": db.add_message(uid, "assistant", text, meta=meta), "text": text, **(meta or {})})
    return {"name": name, "messages": out}


@app.get("/api/state")
def state(uid: str = Depends(current_uid)):
    if not db.get_name(uid) and not db.all_messages(uid, limit=1):
        db.add_message(uid, "assistant", INTRO)   # the very first thing she sees
    msgs = [{"id": m["id"], "role": m["role"], "content": m["content"], "mode": m["mode"],
             "meta": m["meta"], "created_at": m["created_at"]} for m in db.all_messages(uid)]
    return {"name": db.get_name(uid), "messages": msgs, "moments": len(db.moments(uid)),
            "voice": bool(ELEVEN_KEY)}


class EventIn(BaseModel):
    text: str


@app.post("/api/event")
def event(body: EventIn, uid: str = Depends(current_uid)):
    """Things that happen outside the chat (breathing, calls, Restworld) so Elpis knows about them."""
    return {"id": db.add_message(uid, "event", body.text.strip()[:300])}


# ---------- Restworld ----------

ALLOWED_TAGS = {"svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect"}
FALLBACK_SVG = ('<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="white" '
                'stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><circle cx="100" cy="90" r="34" '
                'fill="white" fill-opacity="0.15"/><path d="M100 36v-14M100 158v-14M46 90H32M168 90h-14M62 52 52 42'
                'M148 138l-10-10M62 128l-10 10M148 42l-10 10"/><path d="M86 96q14 12 28 0"/><circle cx="88" cy="82" '
                'r="2"/><circle cx="112" cy="82" r="2"/></svg>')


def _safe_svg(svg):
    if not isinstance(svg, str) or not svg.strip().startswith("<svg"):
        return None
    tags = {t.lower() for t in re.findall(r"<\s*/?\s*([a-zA-Z:]+)", svg)}
    banned = re.search(r"\bon\w+\s*=|href|url\(|style|<!|<\?|javascript", svg, re.I)
    if not tags <= ALLOWED_TAGS or banned or len(svg) > 20000:
        return None
    if "xmlns=" not in svg:
        svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"', 1)
    return svg


class MomentIn(BaseModel):
    prompt: str | None = None
    text: str


# A sketch streams in shape by shape so the app can draw each one with a crayon as Claude makes it.
# Every shape is rebuilt from an allowlist of tags and attribute values before it leaves the server.
SHAPE_RE = re.compile(r"<(path|circle|ellipse|line|polyline|polygon|rect)\b([^<>]*?)/?>", re.I)
ATTR_RE = re.compile(r'([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*"([^"]*)"')   # names like x1, y2 have digits
NUM = r"-?\d+(?:\.\d+)?"
ATTR_OK = {
    "d": re.compile(r"[MmLlHhVvCcSsQqTtAaZz0-9\s,.\-eE]{1,4000}"),
    "points": re.compile(r"[0-9\s,.\-eE]{1,2000}"),
    **{k: re.compile(NUM) for k in ("cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2",
                                     "width", "height", "stroke-width", "fill-opacity", "opacity")},
    "fill": re.compile(r"none|white|#[0-9a-fA-F]{3,6}"),
    "stroke-linecap": re.compile(r"round|butt|square"),
    "stroke-linejoin": re.compile(r"round|miter|bevel"),
}
SVG_OPEN = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" fill="none" stroke="white" '
            'stroke-width="4" stroke-linecap="round" stroke-linejoin="round">')


def _clean_shape(tag, attrs):
    kept = [f'{k}="{v}"' for k, v in ATTR_RE.findall(attrs) if k in ATTR_OK and ATTR_OK[k].fullmatch(v.strip())]
    return f"<{tag.lower()} {' '.join(kept)}/>" if kept else None


@app.post("/api/moments")
def keep_moment(body: MomentIn, uid: str = Depends(current_uid)):
    text = body.text.strip()[:1000]
    if not text:
        raise HTTPException(400, "Write a little something first")

    def stream():
        title, shapes, buf, pos = None, [], "", 0
        try:
            with client.messages.stream(
                model=MODEL, max_tokens=4000, system=load("sketch"),
                messages=[{"role": "user", "content": f"Question: {body.prompt or ''}\nWhat she wrote: {text}"}],
            ) as s:
                for chunk in s.text_stream:
                    buf += chunk
                    if title is None and "\n" in buf:
                        m = re.search(r"TITLE:\s*(.+)", buf)
                        if m:
                            title = m.group(1).strip().strip('"').lower()[:60]
                            yield _sse("title", {"title": title})
                    for m in SHAPE_RE.finditer(buf, pos):
                        if not m.group(0).endswith(">"):
                            break
                        pos = m.end()
                        shape = _clean_shape(m.group(1), m.group(2))
                        if shape and len(shapes) < 40:
                            shapes.append(shape)
                            yield _sse("shape", {"svg": shape})
        except Exception:
            log.exception("Sketch generation failed; using fallback sketch")
        if not shapes:   # nothing usable came back: draw the little sun instead
            shapes = [_clean_shape(m.group(1), m.group(2)) for m in SHAPE_RE.finditer(FALLBACK_SVG)]
            shapes = [x for x in shapes if x]
            for shape in shapes:
                yield _sse("shape", {"svg": shape})
        title = title or "a moment i kept"
        svg = SVG_OPEN + "".join(shapes) + "</svg>"
        moment_id = db.add_moment(uid, title, body.prompt, text, svg)
        db.add_message(uid, "event", f'She kept a moment in her Restworld: "{title}" — "{text[:200]}"',
                       meta={"moment_id": moment_id})
        yield _sse("done", next(m for m in db.moments(uid) if m["id"] == moment_id))

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/moments")
def list_moments(uid: str = Depends(current_uid)):
    return db.moments(uid)


@app.delete("/api/moments/{moment_id}")
def remove_moment(moment_id: int, uid: str = Depends(current_uid)):
    db.delete_moment(uid, moment_id)
    return {"ok": True}


# ---------- voice ----------

class TTSIn(BaseModel):
    text: str


@app.post("/api/tts")
def tts(body: TTSIn):
    if not ELEVEN_KEY:
        raise HTTPException(503, "ElevenLabs is not configured")
    text = re.sub(r"\*\*?(.+?)\*\*?", r"\1", body.text)[:2500]
    try:
        r = httpx.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVEN_VOICE}/stream",
            params={"optimize_streaming_latency": 3},
            headers={"xi-api-key": ELEVEN_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg"},
            json={"text": text, "model_id": "eleven_turbo_v2_5",
                  "voice_settings": {"stability": 0.45, "similarity_boost": 0.8, "style": 0.35, "use_speaker_boost": True}},
            timeout=60,
        )
    except httpx.HTTPError as e:
        log.error("ElevenLabs unreachable: %s", e)
        raise HTTPException(502, "Voice is unavailable right now")
    if r.status_code != 200:
        log.error("ElevenLabs %s: %s", r.status_code, r.text[:300])
        raise HTTPException(502, "Voice is unavailable right now")
    return Response(content=r.content, media_type="audio/mpeg")


@app.post("/api/reset")
def reset(uid: str = Depends(current_uid)):
    db.reset(uid)
    return {"ok": True}


# ---------- frontend ----------

FRONTEND = ROOT / "frontend"
app.mount("/assets", StaticFiles(directory=FRONTEND / "assets"), name="assets")


@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


@app.get("/{name}.{ext}")
def static_file(name: str, ext: str):
    path = FRONTEND / f"{name}.{ext}"
    if ext not in ("js", "css") or not path.is_file():
        raise HTTPException(404)
    return FileResponse(path)
