"""Elpis backend: one continuous conversation with a CBT companion, voice, breathing and Rest World."""

import json
import logging
import os
import re
import time
from datetime import datetime
from pathlib import Path

import anthropic
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
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


# ---------- context building ----------

def _ago(seconds):
    if seconds < 3600:
        return "a few minutes"
    if seconds < 86400:
        return f"about {int(seconds // 3600)} hours"
    return f"about {int(seconds // 86400)} days"


def _about_her(mode, local_time=None):
    name = db.get_name()
    lines = [f"Her name is {name}." if name else "You don't know her name yet."]
    now = local_time or datetime.now().strftime("%A, %-I:%M %p")
    lines.append(f"It is {now} where she is.")
    last = db.last_message_time()
    if last and time.time() - last > 3 * 3600:
        lines.append(f"It has been {_ago(time.time() - last)} since you last talked.")
    kept = db.moments()
    if kept:
        titles = "; ".join(f'"{m["title"]}"' for m in kept[:8])
        lines.append(f"Moments she has kept in her Rest World ({len(kept)}): {titles}.")
    else:
        lines.append("She hasn't kept any moments in her Rest World yet.")
    if mode == "call":
        lines.append("RIGHT NOW YOU ARE ON A VOICE CALL with her: follow the Voice Calls guidance.")
    summary = db.get_summary()
    if summary:
        lines.append(f"\nWhat you remember from earlier in your conversation:\n{summary}")
    return "\n".join(lines)


def _api_messages(final_user_content):
    turns = []
    for m in db.active_messages():
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


def _sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


# ---------- API ----------

class ChatIn(BaseModel):
    text: str | None = None
    event: str | None = None   # 'onboard' | 'call_start'
    mode: str = "chat"
    local_time: str | None = None   # from her device, e.g. "Thursday, 9:41 PM"


EVENT_NOTES = {
    "onboard": "She just told you her name for the first time — this is the very start. Welcome her warmly in "
               "2-3 short sentences: who you are, that this is a private space with no pressure, and one gentle "
               "opening question. Offer easy suggestions.",
    "call_start": "She just started a voice call with you. Greet her the way a friend picks up the phone — one or "
                  "two short sentences, using what you know about her.",
}


@app.post("/api/chat")
def chat(body: ChatIn):
    mode = "call" if body.mode == "call" else "chat"
    text = (body.text or "").strip()
    if not text and body.event not in EVENT_NOTES:
        raise HTTPException(400, "Empty message")

    crisis = safety.detect(text) if text else None
    if text:
        db.add_message("user", text, mode)
        final = text if mode == "chat" else f"(said on a call) {text}"
        if crisis:
            final += (f"\n\n[App note: the safety guardrail detected possible {crisis} risk and is showing her "
                      "crisis resources on screen. Respond per the Safety section.]")
    else:
        final = f"[App note: {EVENT_NOTES[body.event]}]"
    messages = _api_messages(final)

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
                    {"type": "text", "text": _about_her(mode, (body.local_time or "")[:40] or None)},
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
        if crisis or meta.get("action") == "crisis":
            meta["safety"] = card or safety.card("suicide")
            meta["suggestions"] = []
        if meta.get("safety") and not card:
            yield _sse("safety", meta["safety"])
        msg_id = db.add_message("assistant", visible, mode, meta)
        yield _sse("done", {"id": msg_id, "text": visible, **meta})
        memory.compact_in_background(client, MODEL)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class NameIn(BaseModel):
    name: str


@app.post("/api/onboard")
def onboard(body: NameIn):
    name = body.name.strip()[:40]
    if not name:
        raise HTTPException(400, "Name required")
    db.set_name(name)
    return {"name": name}


@app.get("/api/state")
def state():
    msgs = [{"id": m["id"], "role": m["role"], "content": m["content"], "mode": m["mode"],
             "meta": m["meta"], "created_at": m["created_at"]} for m in db.all_messages()]
    return {"name": db.get_name(), "messages": msgs, "moments": len(db.moments()),
            "voice": bool(ELEVEN_KEY)}


class EventIn(BaseModel):
    text: str


@app.post("/api/event")
def event(body: EventIn):
    """Things that happen outside the chat (breathing, calls, Rest World) so Elpis knows about them."""
    return {"id": db.add_message("event", body.text.strip()[:300])}


# ---------- Rest World ----------

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


@app.post("/api/moments")
def keep_moment(body: MomentIn):
    text = body.text.strip()[:1000]
    if not text:
        raise HTTPException(400, "Write a little something first")
    title, svg = "A moment I kept", None
    try:
        response = client.messages.create(
            model=MODEL, max_tokens=4000, system=load("sketch"),
            messages=[{"role": "user", "content": f"Question: {body.prompt or ''}\nWhat she wrote: {text}"}],
        )
        raw = "".join(b.text for b in response.content if b.type == "text")
        data = json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
        title = (data.get("title") or title).strip()[:60]
        svg = _safe_svg(data.get("svg"))
    except Exception:
        log.exception("Sketch generation failed; using fallback sketch")
    moment_id = db.add_moment(title, body.prompt, text, svg or FALLBACK_SVG)
    db.add_message("event", f'She kept a moment in her Rest World: "{title}" — "{text[:200]}"')
    return next(m for m in db.moments() if m["id"] == moment_id)


@app.get("/api/moments")
def list_moments():
    return db.moments()


@app.delete("/api/moments/{moment_id}")
def remove_moment(moment_id: int):
    db.delete_moment(moment_id)
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
def reset():
    db.reset()
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
