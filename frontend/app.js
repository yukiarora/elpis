// Elpis frontend — vanilla JS. One continuous conversation; call, breathe and Restworld all flow back into it.

const $ = (id) => document.getElementById(id);
const state = { name: null, voice: false, busy: false, moments: 0 };
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// ---------- helpers ----------

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// Elpis sometimes uses **bold** / *emphasis*; render it instead of showing asterisks.
function renderText(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
}
function plainText(s) { return s.replace(/\*\*?(.+?)\*\*?/g, "$1"); }

function show(screenId) {
  for (const id of ["onboarding", "chat", "call", "breathe", "journal"]) $(id).hidden = id !== screenId;
}
function tickClock() {
  const d = new Date();
  $("clock").textContent = `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}`;
}
setInterval(tickClock, 15000); tickClock();
document.querySelectorAll(".listening span").forEach((s, i) => s.style.setProperty("--i", i));

async function api(path, body, method) {
  const res = await fetch(path, {
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
  return res.json();
}
const logEvent = (text) => api("/api/event", { text }).catch(() => {});

// Streams /api/chat (SSE over fetch). Calls onDelta(text) as words arrive; resolves with the final payload.
async function streamChat(payload, { onDelta, onSafety } = {}) {
  const local_time = new Date().toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" });
  const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, local_time }) });
  if (!res.ok || !res.body) throw new Error("Elpis couldn't respond");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", done = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /event: (\w+)/.exec(raw)?.[1];
      const data = JSON.parse(/data: (.*)/s.exec(raw)?.[1] || "{}");
      if (ev === "delta") onDelta?.(data.text);
      else if (ev === "safety") onSafety?.(data);
      else if (ev === "done") done = data;
      else if (ev === "error") throw new Error(data.message);
    }
  }
  if (!done) throw new Error("Connection dropped");
  return done;
}

// ---------- chat rendering ----------

const messagesEl = $("messages");
const scrollDown = () => requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });

function elpisRow() {
  const row = document.createElement("div");
  row.className = "msg elpis";
  row.innerHTML = `<img src="/assets/icon.svg" alt=""><div class="body"></div>`;
  messagesEl.appendChild(row);
  return row.querySelector(".body");
}
function addElpis(text) { elpisRow().innerHTML = renderText(text); }
function addUser(text, mode) {
  const row = document.createElement("div");
  row.className = `msg user${mode === "call" ? " call" : ""}`;
  row.innerHTML = `<div class="body"><span>${escapeHtml(text)}</span></div>`;
  messagesEl.appendChild(row);
}
// Quiet system note in the timestamp style: bold label, then detail. Optionally tappable.
function addEvent(label, detail, onClick) {
  const el = document.createElement(onClick ? "button" : "div");
  el.className = "event";
  el.innerHTML = `<b>${escapeHtml(label)}</b>${detail ? ` · ${escapeHtml(detail)}` : ""}`;
  if (onClick) el.onclick = onClick;
  messagesEl.appendChild(el);
}
// Deep link from a "Kept in your Restworld" note to that memory's single view
const openKept = (momentId, title) => async () => {
  await openJournal(null, "rw");
  // older notes have no id saved, so fall back to the card's title
  const card = rw.cards.find((c) => c.m.id === momentId) || rw.cards.find((c) => title && c.m.title === title);
  if (card) holdClose(card.m);
};
function clearTransient() { messagesEl.querySelectorAll(".chips").forEach((el) => el.remove()); }

// iMessage-style timestamps: "Today 9:41 AM", "Yesterday 9:41 AM", "Tuesday 9:41 AM", "Mon, Oct 13 at 9:41 AM".
// A new one appears when the day changes or after an hour of quiet, like Messages.
let lastStamp = null;
function stampParts(t) {
  const d = new Date(t * 1000), now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const daysAgo = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (daysAgo === 0) return ["Today", time];
  if (daysAgo === 1) return ["Yesterday", time];
  if (daysAgo < 7) return [d.toLocaleDateString(undefined, { weekday: "long" }), time];
  const opts = { weekday: "short", month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return [d.toLocaleDateString(undefined, opts), `at ${time}`];
}
function maybeDivider(t) {
  const prev = lastStamp;
  lastStamp = t;
  if (prev && new Date(prev * 1000).toDateString() === new Date(t * 1000).toDateString() && t - prev < 3600) return;
  const [day, time] = stampParts(t);
  const el = document.createElement("div");
  el.className = "day";
  el.innerHTML = `<b>${escapeHtml(day)}</b> ${escapeHtml(time)}`;
  messagesEl.appendChild(el);
}

function addSafetyCard(card) {
  const el = document.createElement("div");
  el.className = "card safety";
  el.innerHTML = `<div class="eyebrow">If you need someone right now</div>` + card.resources.map((r) => `
    <div class="row"><b>${escapeHtml(r.name)}</b><small>${escapeHtml(r.detail)}</small>
    <div class="acts">${r.actions.map((a) => `<a class="act" href="${a.href}">${escapeHtml(a.label)}</a>`).join("")}</div></div>`).join("");
  messagesEl.appendChild(el);
}

// Suggestions under Elpis's latest message. The model's action shows up first as its own chip:
// "✎ Write about this", "✦ Visit your Restworld", "≋ Breathing space".
function renderAfter(meta, { live } = {}) {
  const chips = [];
  if (meta.action === "journal" && meta.journal_prompt) chips.push({ label: "✎ Write about this", act: true, run: () => openJournal(meta.journal_prompt) });
  else if (meta.action === "rest_world" && state.moments > 0) chips.push({ label: "✦ Visit your Restworld", act: true, run: () => openJournal(null, "rw") });
  else if (meta.action === "breathe") chips.push({ label: "≋ Breathing space", act: true, run: openBreathe });
  for (const s of meta.suggestions || []) chips.push({ label: s, run: () => sendMessage(s) });
  if (!chips.length) return;
  const wrap = document.createElement("div");
  wrap.className = "chips";
  for (const c of chips) {
    const b = document.createElement("button");
    b.className = "chip" + (c.act ? " act" : "");
    b.appendChild(document.createElement("span")).textContent = c.label;
    b.onclick = () => { if (!c.act) clearTransient(); c.run(); };
    wrap.appendChild(b);
    if (c.act) wrap.appendChild(Object.assign(document.createElement("span"), { className: "break" }));
  }
  messagesEl.appendChild(wrap);
  if (live) scrollDown();
}

async function loadState() {
  const s = await api("/api/state");
  Object.assign(state, { name: s.name, voice: s.voice, moments: s.moments });
  messagesEl.innerHTML = "";
  lastStamp = null;
  let lastMode = "chat";
  s.messages.forEach((m, i) => {
    maybeDivider(m.created_at);
    if (m.mode === "call" && lastMode !== "call" && m.role !== "event") addEvent("Call with Elpis");
    if (m.role !== "event") lastMode = m.mode;
    if (m.role === "user") addUser(m.content, m.mode);
    else if (m.role === "assistant") {
      addElpis(m.content);
      if (m.meta?.safety) addSafetyCard(m.meta.safety);
    } else if (m.role === "event" && /^(She kept|Voice call ended|She did a breathing)/.test(m.content)) {
      addEvent(...eventParts(m.content, m.meta));
    }
    // Suggestions + action survive refresh, but only for the latest Elpis message.
    if (i === s.messages.length - 1 && m.role === "assistant") renderAfter(m.meta || {});
  });
  scrollDown();
  return s;
}
// Stored event text -> [label, detail, onClick]
function eventParts(text, meta = {}) {
  if (text.startsWith("She kept")) {
    const title = /"([^"]+)"/.exec(text)?.[1];
    return ["✦ Kept in your Restworld", title, openKept(meta.moment_id, title)];
  }
  if (text.startsWith("Voice call ended")) return ["Call ended", /\((.+?)\)/.exec(text)?.[1]];
  if (text.startsWith("She did a breathing")) return ["Breathing space", /for (.+?)\.?$/.exec(text)?.[1]];
  return [text];
}

// ---------- sending ----------

async function sendMessage(text, { event } = {}) {
  closeMenu();
  if (state.busy) return;
  state.busy = true;
  clearTransient();
  maybeDivider(Date.now() / 1000);
  if (text) addUser(text);
  const body = elpisRow();
  body.innerHTML = `<span class="thinking" role="status" aria-label="Elpis is thinking"></span>`;
  scrollDown();
  let acc = "";
  try {
    const done = await streamChat({ text, event, mode: "chat" }, {
      onDelta: (d) => { acc += d; body.innerHTML = renderText(acc.trimStart()); scrollDown(); },
      onSafety: (card) => { addSafetyCard(card); scrollDown(); },
    });
    body.innerHTML = renderText(done.text);
    renderAfter(done, { live: true });
  } catch (e) {
    body.innerHTML = `<span style="opacity:.7">I lost my words for a second. Could you say that again?</span>`;
    console.error(e);
  } finally {
    state.busy = false;
  }
}

const input = $("input"), typeArea = document.querySelector(".type-area");
function syncComposer() {
  const has = input.value.trim().length > 0;
  typeArea.classList.toggle("has-text", has);
  typeArea.classList.toggle("active", has || document.activeElement === input);
  input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 120) + "px";
}
input.addEventListener("input", syncComposer);
input.addEventListener("focus", syncComposer);
input.addEventListener("blur", syncComposer);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("composer").requestSubmit(); }
});
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || state.busy) return;
  input.value = ""; syncComposer();
  sendMessage(text);
});

// Dictation into the text box
let dictation = null;
$("mic-btn").onclick = () => {
  if (!SR) { alert("Voice input works in Chrome or Safari."); return; }
  if (dictation) { dictation.stop(); return; }
  dictation = new SR();
  dictation.lang = "en-US"; dictation.interimResults = true;
  const base = input.value;
  dictation.onresult = (e) => {
    input.value = (base + " " + [...e.results].map((r) => r[0].transcript).join("")).trim(); syncComposer();
  };
  dictation.onend = () => { $("mic-btn").classList.remove("recording"); dictation = null; };
  $("mic-btn").classList.add("recording");
  dictation.start();
};

// ---------- onboarding ----------

$("onboard-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("name-input").value.trim();
  if (!name) return;
  await api("/api/onboard", { name });
  state.name = name;
  show("chat");
  messagesEl.innerHTML = "";
  lastStamp = null;
  sendMessage(`Hi, my name is ${name}`, { event: "onboard" });   // Elpis answers right away — no blank screen
});

// ---------- + menu ----------

function closeMenu() { $("tools-menu").hidden = true; }
$("tools-btn").onclick = (e) => { e.stopPropagation(); $("tools-menu").hidden = !$("tools-menu").hidden; };
document.addEventListener("click", (e) => { if (!$("tools-menu").contains(e.target)) closeMenu(); });
const TOOLS = {
  reframe: () => sendMessage("Can you help me find another way to hold a thought?"),
  ground: () => sendMessage("Can we do a grounding exercise?"),
  mood: () => sendMessage("I'd like to check in on how I'm feeling."),
  journal: () => openJournal(null),
  breathe: () => openBreathe(),
  restworld: () => openJournal(null, "rw"),
};
document.querySelectorAll("#tools-menu button").forEach((b) => (b.onclick = () => { closeMenu(); TOOLS[b.dataset.tool](); }));

// ---------- Journal (Write | Restworld) ----------

const DEFAULT_PROMPT = "What's one small thing that felt like you today?";
let journalPrompt = DEFAULT_PROMPT;

async function openJournal(prompt, tab = "write") {
  journalPrompt = prompt || DEFAULT_PROMPT;
  $("j-prompt").textContent = journalPrompt;
  $("j-text").value = "";
  $("j-keep").disabled = false; $("j-keep").textContent = "Keep this";
  show("journal");
  const loading = setTab(tab);
  if (tab === "write") setTimeout(() => $("j-text").focus(), 200);
  return loading;
}
function setTab(tab) {
  $("tab-write").classList.toggle("on", tab === "write");
  $("tab-rw").classList.toggle("on", tab === "rw");
  $("j-write").hidden = tab !== "write";
  $("rw").hidden = tab !== "rw";
  if (tab === "rw") return loadRestworld();
}
$("tab-write").onclick = () => setTab("write");
$("tab-rw").onclick = () => setTab("rw");
$("j-back").onclick = () => { show("chat"); scrollDown(); };

$("j-keep").onclick = async () => {
  const text = $("j-text").value.trim();
  if (!text) { $("j-text").focus(); return; }
  $("j-keep").disabled = true;
  // Jump to Restworld right away; the card says "sketching..." until Claude finishes drawing.
  await setTab("rw");   // let Restworld finish loading first, or it would wipe the sketching card
  const placeholder = placePaper({ id: "pending", title: text.slice(0, 40) }, { pending: true });
  try {
    const moment = await api("/api/moments", { prompt: journalPrompt, text });
    state.moments += 1;
    // the sketching card becomes the sketch right where it is floating
    placeholder.m = moment; placeholder.pending = false; placeholder.tilt = tilt(moment.id);
    placeholder.el.innerHTML = `<img alt="" src="${svgSrc(moment.svg)}"><div>${escapeHtml(moment.title.toLowerCase())}</div>`;
    $("j-text").value = "";   // ready for the next entry
    $("j-keep").disabled = false;
    clearTransient();
    addEvent("✦ Kept in your Restworld", moment.title, openKept(moment.id, moment.title));
  } catch (e) {
    placeholder.el.querySelector(".sketching").textContent = "couldn't sketch — try again";
    placeholder.pending = false;   // not saved; it goes away the next time Restworld loads
    $("j-keep").disabled = false;
  }
};

// ---------- Restworld: paper cards floating on water ----------
// Each card wanders on its own slowly-turning heading, sways a little, eases away from the edges
// and from other cards (so nothing stacks). Drag a card to move just that card; drag empty space
// to look around when there are more cards than fit. Tap a card to hold it close.

const svgSrc = (svg) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
const CARD_W = 88, CARD_H = 112, SPEED = 9, PERSONAL_SPACE = 118, EDGE = 56;
const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const rw = { cards: [], panX: 0, panY: 0, W: 0, H: 0, worldW: 0, worldH: 0, raf: 0, last: 0, z: 1, t: 0 };

function tilt(id) { const n = (typeof id === "number" ? id : 7) * 9301 + 49297; return ((n % 233280) / 233280) * 16 - 8; }

function sizeWorld() {
  const box = $("rw").getBoundingClientRect();
  rw.W = box.width; rw.H = box.height - 60;   // keep clear of the hint line
  const grow = Math.max(1, Math.sqrt((rw.cards.length + 1) / 6));
  rw.worldW = rw.W * grow; rw.worldH = rw.H * grow;
  rw.panX = Math.min(0, Math.max(rw.W - rw.worldW, rw.panX));
  rw.panY = Math.min(0, Math.max(rw.H - rw.worldH, rw.panY));
}

// An open spot: a few random tries, keep the one furthest from everyone else.
function openSpot() {
  let best = null, bestGap = -1;
  for (let k = 0; k < 24; k++) {
    const x = EDGE + Math.random() * (rw.worldW - 2 * EDGE), y = EDGE + Math.random() * (rw.worldH - 2 * EDGE);
    const gap = Math.min(Infinity, ...rw.cards.map((c) => Math.hypot(c.x - x, c.y - y)));
    if (gap > bestGap) { best = { x, y }; bestGap = gap; }
  }
  return best;
}

function placePaper(m, { pending, fresh } = {}) {
  sizeWorld();
  const el = document.createElement("div");
  el.className = "paper";
  el.innerHTML = (pending ? `<div class="sketching">sketching...</div>` : `<img alt="" src="${svgSrc(m.svg)}">`) +
    `<div>${escapeHtml((m.title || "").toLowerCase())}</div>`;
  const spot = openSpot();
  const card = {
    m, el, pending, x: spot.x, y: spot.y, vx: 0, vy: 0,
    heading: Math.random() * Math.PI * 2, turn: 0, tilt: tilt(m.id), phase: Math.random() * 6,
    remove() { el.remove(); rw.cards = rw.cards.filter((c) => c !== card); },
  };
  if (pending || fresh) {   // glide in from the right edge, like the original
    card.x = rw.W - rw.panX; card.heading = Math.PI + (Math.random() - 0.5) * 0.6; card.vx = -60;   // half-visible at the right edge
  }
  el.addEventListener("pointerdown", (e) => startCardDrag(e, card));
  $("rw-canvas").appendChild(el);
  rw.cards.push(card);
  $("rw-empty").hidden = true;
  render(card);
  startFloat();
  return card;
}

function render(c) {
  const sway = calm ? 0 : Math.sin(rw.t * 0.5 + c.phase) * 3;
  c.el.style.transform = `translate(${c.x - CARD_W / 2 + rw.panX}px, ${c.y - CARD_H / 2 + rw.panY}px) rotate(${c.tilt + sway}deg)`;
}

function step(dt) {
  rw.t += dt;
  for (const c of rw.cards) {
    if (c.dragging) continue;
    // wander: the heading turns slowly and smoothly, never in a straight line for long
    c.turn += (Math.random() - 0.5) * 1.2 * dt;
    c.turn = Math.max(-0.35, Math.min(0.35, c.turn));
    c.heading += c.turn * dt;
    // steer back toward the middle when near an edge
    const near = c.x < EDGE || c.x > rw.worldW - EDGE || c.y < EDGE || c.y > rw.worldH - EDGE;
    if (near) {
      const toward = Math.atan2(rw.worldH / 2 - c.y, rw.worldW / 2 - c.x);
      const diff = Math.atan2(Math.sin(toward - c.heading), Math.cos(toward - c.heading));
      c.heading += diff * 0.8 * dt;
    }
    const speed = calm ? 0 : SPEED;
    c.vx += (Math.cos(c.heading) * speed - c.vx) * 0.5 * dt;
    c.vy += (Math.sin(c.heading) * speed - c.vy) * 0.5 * dt;
    // personal space: cards drift apart instead of stacking
    for (const o of rw.cards) {
      if (o === c) continue;
      const dx = c.x - o.x, dy = c.y - o.y, d = Math.hypot(dx, dy) || 0.01;
      if (d < PERSONAL_SPACE) {
        const push = ((PERSONAL_SPACE - d) / PERSONAL_SPACE) * 60 * dt;
        c.vx += (dx / d) * push; c.vy += (dy / d) * push;
      }
    }
    c.x += c.vx * dt; c.y += c.vy * dt;
    // soft walls
    c.x = Math.max(CARD_W / 2, Math.min(rw.worldW - CARD_W / 2 + (c.pending || c.vx < -20 ? CARD_W * 2 : 0), c.x));
    c.y = Math.max(CARD_H / 2, Math.min(rw.worldH - CARD_H / 2, c.y));
  }
  rw.cards.forEach(render);
}

function startFloat() {
  if (rw.raf) return;
  rw.last = performance.now();
  const tick = (now) => {
    if ($("rw").hidden || $("journal").hidden) { rw.raf = 0; return; }   // only while visible
    if ($("rw-hold").hidden) step(Math.min(0.05, (now - rw.last) / 1000));   // still while a card is held close
    rw.last = now;
    rw.raf = requestAnimationFrame(tick);
  };
  rw.raf = requestAnimationFrame(tick);
}

async function loadRestworld() {
  if (rw.cards.some((c) => c.pending)) { startFloat(); return; }   // a card is being drawn right now
  $("rw-canvas").innerHTML = "";
  rw.cards = []; rw.panX = 0; rw.panY = 0;
  const moments = await api("/api/moments");
  state.moments = moments.length;
  moments.forEach((m) => placePaper(m));
  $("rw-empty").hidden = rw.cards.length > 0;
}

// Drag one card. A press that doesn't move is a tap: hold it close.
function startCardDrag(e, card) {
  e.stopPropagation(); e.preventDefault();
  const start = { px: e.clientX, py: e.clientY, x: card.x, y: card.y, t: performance.now() };
  let moved = false, last = { x: e.clientX, y: e.clientY, t: start.t }, vel = { x: 0, y: 0 };
  card.dragging = true;
  card.el.style.zIndex = ++rw.z;
  card.el.classList.add("lifted");
  const move = (ev) => {
    const dx = ev.clientX - start.px, dy = ev.clientY - start.py;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    card.x = start.x + dx; card.y = start.y + dy;
    const now = performance.now(), dt = Math.max(1, now - last.t) / 1000;
    vel = { x: (ev.clientX - last.x) / dt, y: (ev.clientY - last.y) / dt };
    last = { x: ev.clientX, y: ev.clientY, t: now };
    render(card);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    card.dragging = false;
    card.el.classList.remove("lifted");
    if (!moved) { if (!card.pending) holdClose(card.m); return; }
    // let go: it keeps a little of your flick, then settles back into drifting
    const cap = 220, sp = Math.hypot(vel.x, vel.y), k = sp > cap ? cap / sp : 1;
    card.vx = vel.x * k; card.vy = vel.y * k;
    if (sp > 1) card.heading = Math.atan2(vel.y, vel.x);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// Drag empty space to look around (only matters once the world is bigger than the screen)
(() => {
  const area = $("rw");
  let start = null;
  area.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".paper")) return;
    start = { px: e.clientX, py: e.clientY, x: rw.panX, y: rw.panY };
    area.classList.add("dragging");
  });
  window.addEventListener("pointermove", (e) => {
    if (!start) return;
    rw.panX = Math.min(0, Math.max(rw.W - rw.worldW, start.x + e.clientX - start.px));
    rw.panY = Math.min(0, Math.max(rw.H - rw.worldH, start.y + e.clientY - start.py));
    rw.cards.forEach(render);
  });
  window.addEventListener("pointerup", () => { start = null; area.classList.remove("dragging"); });
})();

// tap a memory to hold it close
function holdClose(m) {
  const hold = $("rw-hold");
  hold.innerHTML = `<div class="paper"><img alt="" src="${svgSrc(m.svg)}"><div>${escapeHtml(m.title.toLowerCase())}</div>
    <div class="note">${m.prompt ? `<i>${escapeHtml(m.prompt)}</i>\n` : ""}${escapeHtml(m.text)}</div>
    <button class="let-go">let this one go</button></div>`;
  hold.hidden = false;
  hold.onclick = (e) => { if (e.target === hold) hold.hidden = true; };
  // Ask inside the card, not with a browser popup
  hold.querySelector(".let-go").onclick = (e) => {
    e.currentTarget.outerHTML = `<div class="confirm-go"><span>Let this one go?</span>
      <button class="keep-it">Keep it</button><button class="go">Let go</button></div>`;
    hold.querySelector(".keep-it").onclick = () => holdClose(m);
    hold.querySelector(".go").onclick = async () => {
      await api(`/api/moments/${m.id}`, null, "DELETE");
      hold.hidden = true;
      loadRestworld();
    };
  };
}

// ---------- Breathe ----------

const IN = 4, OUT = 6, CYCLE = IN + OUT;   // seconds
const br = { running: false, start: 0, pausedAt: 0, elapsed: 0, minutes: 3, sound: "waves", muted: false, raf: 0 };
const canvas = $("wave"), ctx = canvas.getContext("2d");
const dpr = window.devicePixelRatio || 1;
canvas.width = 393 * dpr; canvas.height = 300 * dpr; ctx.scale(dpr, dpr);

// level(t): 0 = empty (bottom), 1 = full (top). Smooth rise over IN seconds, smooth fall over OUT.
function level(t) {
  const p = ((t % CYCLE) + CYCLE) % CYCLE;
  return p < IN ? (1 - Math.cos(Math.PI * p / IN)) / 2 : (1 + Math.cos(Math.PI * (p - IN) / OUT)) / 2;
}
function drawWave(t) {
  const W = 393, top = 40, bottom = 230;
  ctx.clearRect(0, 0, W, 300);
  ctx.beginPath();
  for (let x = -10; x <= W + 10; x += 4) {
    const y = bottom - level(t + (x - W / 2) / W * CYCLE) * (bottom - top);
    x < -5 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = "rgba(220, 215, 235, 0.55)"; ctx.lineWidth = 16; ctx.lineCap = "round"; ctx.stroke();
  const y = bottom - level(t) * (bottom - top);
  ctx.beginPath(); ctx.arc(W / 2, y, 15, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
}
function frame() {
  const t = br.elapsed + (br.running ? (performance.now() - br.start) / 1000 : 0);
  drawWave(t);
  $("breathe-label").textContent = (t % CYCLE) < IN ? "Breathe In" : "Breathe Out";
  if (t >= br.minutes * 60) { finishBreathe(t); return; }
  br.raf = requestAnimationFrame(frame);
}
function setPlayIcon(playing) {
  $("play-icon").innerHTML = playing
    ? `<rect x="6" y="5" width="4" height="14" rx="1.5"/><rect x="14" y="5" width="4" height="14" rx="1.5"/>`
    : `<path d="M8 5.5v13a1 1 0 0 0 1.5.9l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5Z"/>`;
  $("breathe-play").setAttribute("aria-label", playing ? "Pause" : "Start");
}
function openBreathe() {
  show("breathe");
  Object.assign(br, { running: false, elapsed: 0 });
  $("breathe").classList.remove("running");
  $("breathe-done").hidden = true;
  setPlayIcon(false);
  cancelAnimationFrame(br.raf);
  drawWave(0);
}
$("breathe-play").onclick = () => {
  if (br.running) {
    br.elapsed += (performance.now() - br.start) / 1000; br.running = false;
    cancelAnimationFrame(br.raf); stopSound(); setPlayIcon(false);
  } else {
    br.start = performance.now(); br.running = true;
    $("breathe").classList.add("running"); setPlayIcon(true);
    if (!br.muted) playSound(br.sound);
    frame();
  }
};
$("breathe-timer").onclick = () => {
  const opts = [1, 3, 5, 10];
  br.minutes = opts[(opts.indexOf(br.minutes) + 1) % opts.length];
  $("breathe-mins").textContent = `${br.minutes} min`;
};
$("breathe-mute").onclick = () => {
  br.muted = !br.muted;
  $("mute-wave").style.opacity = br.muted ? 0.2 : 1;
  if (br.muted) stopSound(); else if (br.running) playSound(br.sound);
};
document.querySelectorAll(".sounds button").forEach((b) => (b.onclick = () => {
  document.querySelectorAll(".sounds button").forEach((x) => x.classList.toggle("selected", x === b));
  br.sound = b.dataset.sound; $("sound-name").textContent = b.querySelector("span").textContent;
}));
function finishBreathe(t) {
  cancelAnimationFrame(br.raf); stopSound(); br.running = false;
  if (t > 15) {
    const m = Math.floor(t / 60), s = Math.round(t % 60);
    const dur = [m && `${m} min`, s && `${s} sec`].filter(Boolean).join(" ");
    logEvent(`She did a breathing exercise for ${dur}.`);
    addEvent("Breathing space", dur);
    $("breathe-done").hidden = false;
  } else {
    show("chat");
  }
}
$("breathe-close").onclick = () => {
  const t = br.elapsed + (br.running ? (performance.now() - br.start) / 1000 : 0);
  finishBreathe(t);
};
$("breathe-back").onclick = () => { show("chat"); scrollDown(); };

// Ambient sound, synthesised so there are no audio files to ship.
let audioCtx = null, soundNodes = [];
function noiseBuffer(ac, brown) {
  const len = ac.sampleRate * 4, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    d[i] = brown ? (last = (last + 0.02 * w) / 1.02) * 3.5 : w;
  }
  return buf;
}
function playSound(kind) {
  stopSound();
  audioCtx = audioCtx || new AudioContext();
  const ac = audioCtx, master = ac.createGain();
  master.gain.value = 0.0001; master.connect(ac.destination);
  master.gain.exponentialRampToValueAtTime(kind === "music" ? 0.08 : 0.35, ac.currentTime + 2);
  soundNodes = [master];
  if (kind === "music") {
    [220, 277.18, 329.63, 415.3].forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain(), lfo = ac.createOscillator(), lg = ac.createGain();
      o.type = "sine"; o.frequency.value = f; g.gain.value = 0.25;
      lfo.frequency.value = 0.05 + i * 0.03; lg.gain.value = 0.2; lfo.connect(lg).connect(g.gain);
      o.connect(g).connect(master); o.start(); lfo.start(); soundNodes.push(o, lfo);
    });
  } else {
    const src = ac.createBufferSource(), filter = ac.createBiquadFilter();
    src.buffer = noiseBuffer(ac, kind === "waves"); src.loop = true;
    filter.type = kind === "waves" ? "lowpass" : "highpass";
    filter.frequency.value = kind === "waves" ? 600 : 1200;
    src.connect(filter).connect(master);
    if (kind === "waves") {   // swell in time with a slow sea
      const lfo = ac.createOscillator(), lg = ac.createGain();
      lfo.frequency.value = 1 / CYCLE; lg.gain.value = 0.25; lfo.connect(lg).connect(master.gain); lfo.start(); soundNodes.push(lfo);
    }
    src.start(); soundNodes.push(src);
  }
}
function stopSound() {
  soundNodes.forEach((n) => { try { n.stop?.(); n.disconnect(); } catch {} });
  soundNodes = [];
}

// ---------- Call ----------

const call = { active: false, started: 0, timer: 0, rec: null, audio: null, speaker: true, turn: 0 };

function setCallTexts(elpis, user) {
  const box = $("call-text");
  box.innerHTML = "";
  if (user) box.insertAdjacentHTML("beforeend", `<div class="bubble user">${escapeHtml(user)}</div>`);
  if (elpis != null) box.insertAdjacentHTML("beforeend", `<div class="bubble elpis">${renderText(elpis)}</div>`);
  box.scrollTop = box.scrollHeight;
}
function fmtTime(s) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }

async function startCall() {
  if (call.active) return;
  closeMenu();
  Object.assign(call, { active: true, started: Date.now(), turn: 0 });
  show("call");
  $("call-timer").textContent = "0:00";
  setCallTexts(null);
  $("listening").hidden = true;
  call.timer = setInterval(() => ($("call-timer").textContent = fmtTime(Math.floor((Date.now() - call.started) / 1000))), 500);
  // unlock audio on the user's tap so playback is allowed later
  call.audio = new Audio(); call.audio.play().catch(() => {});
  callTurn({ event: "call_start" });
}

async function callTurn(payload) {
  const turn = ++call.turn;
  $("listening").hidden = true;
  let acc = "";
  try {
    const done = await streamChat({ ...payload, mode: "call" }, {
      onDelta: (d) => { if (turn === call.turn) { acc += d; setCallTexts(acc.trimStart(), payload.text); } },
      onSafety: (card) => { call.safety = card; },
    });
    if (!call.active || turn !== call.turn) return;
    setCallTexts(done.text, payload.text);
    await speak(done.text);
    if (call.active && turn === call.turn) listen();
  } catch (e) {
    console.error(e);
    if (call.active) { setCallTexts("Sorry — I lost you for a second. I'm still here."); listen(); }
  }
}

async function speak(text) {
  if (!call.speaker) return;
  if (state.voice) {
    try {
      const res = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      if (!res.ok) throw new Error("tts");
      const url = URL.createObjectURL(await res.blob());
      call.audio.src = url;
      await call.audio.play();
      await new Promise((r) => { call.audio.onended = r; call.audio.onpause = r; });
      URL.revokeObjectURL(url);
      return;
    } catch (e) { console.warn("ElevenLabs unavailable, using the browser voice", e); }
  }
  await new Promise((r) => {
    const u = new SpeechSynthesisUtterance(plainText(text));
    u.rate = 0.95; u.pitch = 1.05; u.onend = r; u.onerror = r;
    speechSynthesis.speak(u);
  });
}

function listen() {
  if (!call.active) return;
  $("listening").hidden = false;
  if (!SR) { setCallTexts("Voice input needs Chrome or Safari. You can keep talking to me in chat."); return; }
  const rec = new SR();
  call.rec = rec;
  rec.lang = "en-US"; rec.interimResults = true; rec.continuous = false;
  let finalText = "", heard = false;
  const elpisText = $("call-text").querySelector(".bubble.elpis")?.textContent || "";
  rec.onresult = (e) => {
    heard = true;
    const text = [...e.results].map((r) => r[0].transcript).join("");
    if (e.results[e.results.length - 1].isFinal) finalText = text;
    setCallTexts(elpisText, text);
  };
  rec.onend = () => {
    call.rec = null;
    if (!call.active) return;
    if (finalText.trim()) callTurn({ text: finalText.trim() });
    else listen();   // silence — keep listening, like an open phone line
  };
  rec.onerror = (e) => { if (e.error === "not-allowed") { setCallTexts("I need microphone access to hear you."); call.active && ($("listening").hidden = true); } };
  try { rec.start(); } catch {}
}

async function endCall() {
  if (!call.active) return;
  call.active = false; call.turn++;
  clearInterval(call.timer);
  call.rec?.abort(); call.audio?.pause(); speechSynthesis.cancel();
  const secs = Math.floor((Date.now() - call.started) / 1000);
  await logEvent(`Voice call ended (${fmtTime(secs)})`);
  show("chat");
  await loadState();   // the call's words now live in the chat too
}

$("call-btn").onclick = startCall;
$("end-btn").onclick = endCall;
$("speaker-btn").onclick = () => {
  call.speaker = !call.speaker;
  $("speaker-btn").classList.toggle("on", call.speaker);
  if (!call.speaker) { call.audio?.pause(); speechSynthesis.cancel(); }
};

// ---------- boot ----------

(async function boot() {
  try {
    const s = await loadState();
    if (!s.name) { show("onboarding"); setTimeout(() => $("name-input").focus(), 100); return; }
    show("chat");
    if (!s.messages.length) sendMessage(null, { event: "onboard" });
  } catch (e) {
    document.body.innerHTML = `<p style="color:#fff;padding:24px">Elpis couldn't start: ${escapeHtml(e.message)}</p>`;
  }
})();
