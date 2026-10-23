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
  for (const id of ["locked", "chat", "call", "breathe", "journal"]) $(id).hidden = id !== screenId;
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
  if (res.status === 401) { showLocked(); throw new Error("locked"); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
  return res.json();
}
const logEvent = (text) => api("/api/event", { text }).catch(() => {});

// Streams /api/chat (SSE over fetch). Calls onDelta(text) as words arrive; resolves with the final payload.
async function streamChat(payload, { onDelta, onSafety } = {}) {
  const local_time = new Date().toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" });
  const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, local_time }) });
  if (res.status === 401) { showLocked(); throw new Error("locked"); }
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
  const icon = label.startsWith("✦ ") ? "✦" : "";
  if (icon) label = label.slice(2);
  el.innerHTML = (icon ? `<span class="ev-icon">${icon}</span>` : "") +
    `<span class="ev-text"><b>${escapeHtml(label)}</b>${detail ? ` · ${escapeHtml(detail)}` : ""}</span>`;
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
  for (const s of meta.suggestions || []) chips.push({ label: s, run: () => (state.name ? sendMessage(s) : introduce(s)) });
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
  if (!state.name) introduce(text); else sendMessage(text);
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

// ---------- passcode (hosted only) ----------

function showLocked() {
  show("locked");
  setTimeout(() => $("pass-input").focus(), 100);
}
$("unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("pass-error").hidden = true;
  const res = await fetch("/api/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passcode: $("pass-input").value }) });
  if (!res.ok) {
    $("pass-error").textContent = (await res.json().catch(() => ({}))).detail || "That didn't work. Try again?";
    $("pass-error").hidden = false;
    return;
  }
  $("pass-input").value = "";
  boot();
});

// ---------- onboarding: Elpis asks her name in the chat ----------
// Her first reply is her name; Elpis answers with a short scripted welcome, one bubble at a time.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function introduce(text) {
  if (state.busy) return;
  state.busy = true;
  clearTransient();
  maybeDivider(Date.now() / 1000);
  addUser(text);
  try {
    const { name, messages } = await api("/api/onboard", { text });
    state.name = name;
    for (const m of messages) {
      const body = elpisRow();
      body.innerHTML = `<span class="thinking" role="status" aria-label="Elpis is thinking"></span>`;
      scrollDown();
      await wait(700 + Math.min(1400, m.text.length * 12));
      body.innerHTML = renderText(m.text);
      scrollDown();
    }
    renderAfter(messages[messages.length - 1], { live: true });
  } catch (e) {
    console.error(e);
  } finally {
    state.busy = false;
  }
}

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
  await setTab("rw");   // let Restworld finish loading first
  const studio = openStudio();
  try {
    const moment = await streamSketch({ prompt: journalPrompt, text }, studio);
    await studio.drawn();                 // let the crayon finish its last line
    state.moments += 1;
    const at = await studio.flyAway();    // the big sheet shrinks into a floating paper
    placePaper(moment, { at });
    $("j-text").value = "";   // ready for the next entry
    clearTransient();
    addEvent("✦ Kept in your Restworld", moment.title, openKept(moment.id, moment.title));
  } catch (e) {
    console.error(e);
    studio.fail();
  } finally {
    $("j-keep").disabled = false;
  }
};

// Streams /api/moments: the caption first, then each shape of the sketch as Claude draws it.
async function streamSketch(payload, studio) {
  const res = await fetch("/api/moments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (res.status === 401) { showLocked(); throw new Error("locked"); }
  if (!res.ok || !res.body) throw new Error("couldn't sketch");
  const reader = res.body.getReader(), decoder = new TextDecoder();
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
      if (ev === "title") studio.setTitle(data.title);
      else if (ev === "shape") studio.addShape(data.svg);
      else if (ev === "done") done = data;
    }
  }
  if (!done) throw new Error("connection dropped");
  return done;
}

// ---------- Paper: glassy, translucent, with torn paper edges ----------

const SVG_NS = "http://www.w3.org/2000/svg";
const SHAPE_TAGS = new Set(["path", "circle", "ellipse", "line", "polyline", "polygon", "rect"]);
const SHAPE_ATTRS = new Set(["d", "points", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "width", "height",
  "stroke-width", "fill", "fill-opacity", "opacity", "stroke-linecap", "stroke-linejoin"]);

// Rebuild shapes from an allowlist (the server does the same) so only plain drawing reaches the page.
function shapesFrom(svgText) {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const out = [];
  doc.querySelectorAll("*").forEach((node) => {
    const tag = node.localName;
    if (!SHAPE_TAGS.has(tag)) return;
    const el = document.createElementNS(SVG_NS, tag);
    for (const { name, value } of [...node.attributes]) {
      if (SHAPE_ATTRS.has(name) && /^[\w\s.,#\-]*$/.test(value)) el.setAttribute(name, value);
    }
    out.push(el);
  });
  return out;
}
function sketchSvg(shapes = []) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 200 200");
  svg.classList.add("ink");
  shapes.forEach((s) => svg.appendChild(s));
  return svg;
}

// Torn paper edge: a polygon that wobbles a little along each side.
function deckle(el) {
  const w = el.offsetWidth, h = el.offsetHeight, amp = Math.max(1.4, Math.min(3.2, w / 90)), step = 7;
  const pts = [], j = () => (Math.random() * amp).toFixed(1);
  for (let x = 0; x <= w; x += step) pts.push(`${x}px ${j()}px`);
  for (let y = step; y <= h; y += step) pts.push(`${w - j()}px ${y}px`);
  for (let x = w - step; x >= 0; x -= step) pts.push(`${x}px ${h - j()}px`);
  for (let y = h - step; y > 0; y -= step) pts.push(`${j()}px ${y}px`);
  el.style.clipPath = `polygon(${pts.join(",")})`;
}

const CRAYON = `<svg viewBox="0 0 18 52" width="18" height="52" aria-hidden="true">
  <path d="M5 13h8v35a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z" fill="#8f7fc4"/>
  <path d="M5 20h8v15H5z" fill="#fff" opacity=".75"/>
  <path d="M5 13 9 1.5l4 11.5z" fill="#4b4266"/></svg>`;

// The studio: one big sheet in the middle of Restworld where the crayon draws the new moment.
function openStudio() {
  const wrap = document.createElement("div");
  wrap.className = "studio";
  wrap.innerHTML = `<div class="paper big"><div class="sketch"></div><div class="cap">sketching…</div>
    <div class="crayon idle">${CRAYON}</div></div>`;
  $("rw").appendChild(wrap);
  $("rw-empty").hidden = true;
  const sheet = wrap.querySelector(".paper"), area = wrap.querySelector(".sketch"), crayon = wrap.querySelector(".crayon");
  const svg = sketchSvg(); area.appendChild(svg);
  deckle(sheet);
  const tipAt = (x, y) => { crayon.style.transform = `translate(${x - 9}px, ${y - 1.5}px) rotate(28deg)`; };
  const toSheet = (pt) => {   // svg user units -> sheet pixels
    const a = area.getBoundingClientRect(), s = sheet.getBoundingClientRect(), k = a.width / 200;
    return [a.left - s.left + pt.x * k, a.top - s.top + pt.y * k];
  };
  tipAt(sheet.offsetWidth * 0.62, sheet.offsetHeight * 0.42);
  let queue = Promise.resolve();

  function drawOne(shape) {
    return new Promise((resolve) => {
      crayon.classList.remove("idle");
      svg.appendChild(shape);
      let len = 0;
      try { len = shape.getTotalLength(); } catch {}
      if (!len || calm) { shape.style.opacity = 1; return resolve(); }
      const fillOpacity = shape.getAttribute("fill-opacity");
      shape.style.strokeDasharray = len; shape.style.strokeDashoffset = len;
      if (fillOpacity) shape.style.fillOpacity = 0;
      // a hand eases into and out of each stroke, at its own pace, then lifts briefly
      const dur = Math.max(420, Math.min(1700, len * 8 * (0.85 + Math.random() * 0.3))), t0 = performance.now();
      const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
      const tick = (now) => {
        const p = ease(Math.min(1, (now - t0) / dur));
        shape.style.strokeDashoffset = len * (1 - p);
        tipAt(...toSheet(shape.getPointAtLength(len * p)));
        if (now - t0 < dur) return requestAnimationFrame(tick);
        if (fillOpacity) { shape.style.transition = "fill-opacity .5s"; shape.style.fillOpacity = fillOpacity; }
        setTimeout(resolve, 120 + Math.random() * 220);   // pen lifts before the next stroke
      };
      requestAnimationFrame(tick);
    });
  }

  return {
    setTitle(t) { wrap.querySelector(".cap").textContent = t; },
    addShape(svgText) {
      for (const shape of shapesFrom(`<svg xmlns="${SVG_NS}">${svgText}</svg>`)) queue = queue.then(() => drawOne(shape));
    },
    async drawn() { await queue; crayon.classList.add("done"); await wait(500); },
    async flyAway() {
      const s = sheet.getBoundingClientRect(), r = $("rw").getBoundingClientRect();
      sheet.style.transition = "transform .7s cubic-bezier(.4,0,.2,1), opacity .7s";
      sheet.style.transform = `scale(${CARD_W / sheet.offsetWidth}) rotate(-4deg)`;
      sheet.style.opacity = 0.6;
      await wait(700);
      wrap.remove();
      return { x: s.left - r.left + s.width / 2 - rw.panX, y: s.top - r.top + s.height / 2 - rw.panY };
    },
    fail() {
      wrap.querySelector(".cap").textContent = "couldn't sketch this time — try again?";
      crayon.remove();
      setTimeout(() => wrap.remove(), 2500);
    },
  };
}

// ---------- Restworld: paper cards floating on water ----------
// Each card wanders on its own slowly-turning heading, sways a little, eases away from the edges
// and from other cards (so nothing stacks). Drag a card to move just that card; drag empty space
// to look around when there are more cards than fit. Tap a card to hold it close.

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

function placePaper(m, { fresh, at } = {}) {
  sizeWorld();
  const el = document.createElement("div");
  el.className = "paper";
  el.innerHTML = `<div class="sketch"></div><div class="cap">${escapeHtml((m.title || "").toLowerCase())}</div>`;
  el.querySelector(".sketch").appendChild(sketchSvg(shapesFrom(m.svg || "")));
  const spot = at || openSpot();
  const card = {
    m, el, x: spot.x, y: spot.y, vx: 0, vy: 0,
    heading: Math.random() * Math.PI * 2, turn: 0, tilt: tilt(m.id), phase: Math.random() * 6,
    remove() { el.remove(); rw.cards = rw.cards.filter((c) => c !== card); },
  };
  if (fresh && !at) {   // glide in from the right edge
    card.x = rw.W - rw.panX; card.heading = Math.PI + (Math.random() - 0.5) * 0.6; card.vx = -60;
  }
  el.addEventListener("pointerdown", (e) => startCardDrag(e, card));
  $("rw-canvas").appendChild(el);
  deckle(el);
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
    c.x = Math.max(CARD_W / 2, Math.min(rw.worldW - CARD_W / 2 + (c.vx < -20 ? CARD_W * 2 : 0), c.x));
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
  if ($("rw").querySelector(".studio")) { startFloat(); return; }   // a sketch is being drawn right now
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
    if (!moved) { holdClose(card.m); return; }
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
  hold.innerHTML = `<div class="paper"><div class="sketch"></div><div class="cap">${escapeHtml(m.title.toLowerCase())}</div>
    <div class="note">${m.prompt ? `<i>${escapeHtml(m.prompt)}</i>\n` : ""}${escapeHtml(m.text)}</div>
    <button class="let-go">let this one go</button></div>`;
  hold.querySelector(".sketch").appendChild(sketchSvg(shapesFrom(m.svg || "")));
  hold.hidden = false;
  deckle(hold.querySelector(".paper"));
  hold.onclick = (e) => { if (e.target === hold) hold.hidden = true; };
  // Ask inside the card, not with a browser popup
  hold.querySelector(".let-go").onclick = (e) => {
    e.currentTarget.outerHTML = `<div class="confirm-go"><span>Let this one go?</span>
      <button class="keep-it">Keep it</button><button class="go">Let go</button></div>`;
    deckle(hold.querySelector(".paper"));
    hold.querySelector(".keep-it").onclick = () => holdClose(m);
    hold.querySelector(".go").onclick = async () => {
      await api(`/api/moments/${m.id}`, null, "DELETE");
      hold.hidden = true;
      loadRestworld();
    };
  };
}

// ---------- Breathe: "Drift" ----------
// An intro card (what it's for), then a particle orb in a starry space. A wave runs across it and a dot rides
// the wave: up to breathe in, down to breathe out. The words fill in letter by letter as the seconds pass,
// and a soft chord rings at the start of each phase and fades with it.

const IN = 5, OUT = 5, CYCLE = IN + OUT;   // seconds
const LENGTHS = [5, 10, 20];               // breaths per session
const br = { running: false, start: 0, elapsed: 0, breaths: 10, muted: false, raf: 0, phase: null,
  yaw: 0, pitch: -0.35, spin: 0.12, dragged: false };
const dpr = window.devicePixelRatio || 1;
function fit(c, w, h) { c.width = w * dpr; c.height = h * dpr; const x = c.getContext("2d"); x.setTransform(dpr, 0, 0, dpr, 0, 0); return x; }

// level(t): 0 = empty (bottom), 1 = full (top). Smooth rise over IN seconds, smooth fall over OUT.
function level(t) {
  const p = ((t % CYCLE) + CYCLE) % CYCLE;
  return p < IN ? (1 - Math.cos(Math.PI * p / IN)) / 2 : (1 + Math.cos(Math.PI * (p - IN) / OUT)) / 2;
}

// Stars: a fixed scatter of faint dots
function drawStars() {
  const c = $("stars"), w = c.offsetWidth || 393, h = c.offsetHeight || 852, x = fit(c, w, h);
  for (let i = 0; i < 160; i++) {
    x.fillStyle = `rgba(255,255,255,${0.15 + Math.random() * 0.55})`;
    const r = Math.random() < 0.9 ? 0.6 : 1.2;
    x.fillRect(Math.random() * w, Math.random() * h, r, r);
  }
}

// The orb: a few thousand particles in a sphere, coloured in drifting bands of lilac, violet and cyan.
const ORB = (() => {
  const N = 3600, pts = [];
  for (let i = 0; i < N; i++) {
    let x, y, z, d;
    do { x = Math.random() * 2 - 1; y = Math.random() * 2 - 1; z = Math.random() * 2 - 1; d = x * x + y * y + z * z; } while (d > 1 || d < 0.04);
    const shell = 0.82 + 0.18 * Math.cbrt(Math.random()), k = shell / Math.sqrt(d);   // most particles near the surface
    x *= k; y *= k; z *= k;
    const band = Math.sin(1.9 * x + 1.3) * Math.sin(1.7 * y + 0.4) + 0.75 * Math.sin(2.2 * z - 1.1 + 1.3 * y);   // broad, soft bands
    pts.push({ x, y, z, band, tw: Math.random() * 6 });
  }
  return pts;
})();

function drawOrb(ctx, size, t, { breath = 0, glow = 0, yaw = br.yaw, pitch = br.pitch, width = size } = {}) {
  const c = size / 2, R = size * 0.47 * (1 + 0.03 * breath);
  ctx.clearRect(0, 0, width, size);
  ctx.save(); ctx.translate((width - size) / 2, 0);
  // a crisp dark body with a thin rim glow that stays inside the canvas (no square edges)
  const halo = ctx.createRadialGradient(c, c, R * 0.96, c, c, Math.min(c, R * 1.06));
  halo.addColorStop(0, "rgba(120, 100, 230, 0.35)"); halo.addColorStop(1, "rgba(120, 100, 230, 0)");
  ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(c, c, Math.min(c, R * 1.06), 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(22, 20, 32, 0.92)"; ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = "lighter";
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const dot = Math.max(1, size / 200);
  for (const p of ORB) {
    const x1 = p.x * cy + p.z * sy, z1 = -p.x * sy + p.z * cy;
    const y2 = p.y * cp - z1 * sp, z2 = p.y * sp + z1 * cp;
    const depth = (z2 + 1) / 2, twinkle = 0.85 + 0.15 * Math.sin(t * 1.3 + p.tw);
    let r, g, b, a;
    if (p.band > 1.05) { r = 90; g = 240; b = 225; a = 1; }            // cyan cores
    else if (p.band > 0.3) { r = 120; g = 95; b = 255; a = 0.95; }     // violet bands
    else { r = 165; g = 160; b = 190; a = 0.42; }                       // speckled grey-lilac body
    if (glow && y2 > 0.3 && Math.abs(x1) < 0.85) {                     // breathing out: cyan light pools at the bottom
      const k = glow * Math.min(1, (y2 - 0.3) / 0.3);
      r += (90 - r) * k; g += (245 - g) * k; b += (225 - b) * k; a = a + (1 - a) * k;
    }
    ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${(a * (0.3 + 0.7 * depth) * twinkle).toFixed(3)})`;
    ctx.fillRect(c + x1 * R, c + y2 * R, dot, dot);
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.restore();
}

// The wave: brighter behind the dot (time already breathed), softer ahead, fading at both edges.
function drawWave(ctx, W, H, t) {
  const top = 80, bottom = 250, mid = W / 2;   // the wave spans the orb like the reference
  ctx.clearRect(0, 0, W, H);
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, "rgba(255,255,255,0)"); grad.addColorStop(0.18, "rgba(255,255,255,0.75)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.85)"); grad.addColorStop(0.505, "rgba(255,255,255,0.32)");
  grad.addColorStop(0.85, "rgba(255,255,255,0.28)"); grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.beginPath();
  for (let x = -10; x <= W + 10; x += 3) {
    const y = bottom - level(t + (x - mid) / W * CYCLE * 0.9) * (bottom - top);
    x < -5 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = grad; ctx.lineWidth = 10; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke();
  const y = bottom - level(t) * (bottom - top);
  ctx.shadowColor = "rgba(255,255,255,0.8)"; ctx.shadowBlur = 14;
  ctx.beginPath(); ctx.arc(mid, y, 12, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
  ctx.shadowBlur = 0;
}

// Sound: at each phase a soft chord rings and fades over the phase, like the reference.
let audioCtx = null, chimes = [];
const CHORDS = { in: [164.81, 220, 440, 659.25], out: [196, 261.63, 392, 587.33, 783.99] };
function chime(kind, seconds) {
  if (br.muted) return;
  audioCtx = audioCtx || new AudioContext();
  const ac = audioCtx, now = ac.currentTime, end = now + seconds + 0.6;
  const master = ac.createGain(), lp = ac.createBiquadFilter();
  lp.type = "lowpass"; lp.frequency.value = 2600;
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(0.2, now + 0.05);
  master.gain.exponentialRampToValueAtTime(0.0006, end);
  master.connect(lp).connect(ac.destination);
  CHORDS[kind].forEach((f, i) => {
    for (const [type, detune, vol] of [["sine", 0, 1], ["triangle", 4, 0.25]]) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.value = f; o.detune.value = detune; g.gain.value = vol / (i + 1.6);
      o.connect(g).connect(master); o.start(now); o.stop(end);
      chimes.push(o);
    }
  });
  chimes.push(master);
}
function hush() {
  chimes.forEach((n) => { try { n.stop ? n.stop() : n.disconnect(); } catch {} });
  chimes = [];
}

// Intro art: the orb turning slowly behind the play button, and a tiny one in the session row
function animateIntro() {
  const art = fit($("orb-art"), 296, 296), thumb = fit($("orb-thumb"), 92, 64), t0 = performance.now();
  const loop = (now) => {
    if ($("breathe").hidden || $("b-intro").hidden) return;
    const t = (now - t0) / 1000;
    drawOrb(art, 296, t, { yaw: t * 0.15 });
    drawOrb(thumb, 64, t, { yaw: t * 0.15, width: 92 });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

const orbCtx = () => br.orbCtx || (br.orbCtx = fit($("orb"), 296, 296));
const waveCtx = () => br.waveCtx || (br.waveCtx = fit($("wave"), 393, 300));
const elapsed = () => br.elapsed + (br.running ? (performance.now() - br.start) / 1000 : 0);

function runLoop() {
  let last = performance.now();
  const loop = (now) => {
    if ($("breathe").hidden || $("b-run").hidden) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!br.dragging) br.yaw += br.spin * dt;
    const t = elapsed(), p = ((t % CYCLE) + CYCLE) % CYCLE, inhale = p < IN;
    const progress = inhale ? p / IN : (p - IN) / OUT;
    const glow = br.running && !inhale ? Math.sin(Math.min(1, progress * 1.4) * Math.PI / 2) : 0;
    drawOrb(orbCtx(), 296, now / 1000, { breath: br.running ? level(t) : 0, glow });
    if (br.running || br.elapsed > 0) {
      drawWave(waveCtx(), 393, 300, t);
      const label = $("breathe-label");
      const phase = inhale ? "in" : "out";
      if (br.running && phase !== br.phase) { br.phase = phase; chime(phase, phase === "in" ? IN : OUT); }
      label.textContent = inhale ? "Breathe In" : "Breathe Out";
      label.style.setProperty("--p", progress.toFixed(3));
      if (t >= br.breaths * CYCLE) { finishBreathe(t); return; }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function setPlayIcon(playing) {
  $("play-icon").innerHTML = playing
    ? `<rect x="6" y="5" width="4" height="14" rx="1.5"/><rect x="14" y="5" width="4" height="14" rx="1.5"/>`
    : `<path d="M8 5.5v13a1 1 0 0 0 1.5.9l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5Z"/>`;
  $("breathe-play").setAttribute("aria-label", playing ? "Pause" : "Start");
}
function lengthLabel() {
  const mins = Math.max(1, Math.round(br.breaths * CYCLE / 60));
  $("b-length").textContent = `${br.breaths} breaths · about ${mins} min`;
}

function openBreathe() {
  show("breathe");
  hush();
  Object.assign(br, { running: false, elapsed: 0, phase: null });
  $("breathe").classList.remove("running");
  $("b-intro").hidden = false; $("b-run").hidden = true; $("breathe-done").hidden = true;
  $("b-about-text").hidden = true;
  lengthLabel();
  drawStars();
  animateIntro();
}
function enterRun() {
  $("b-intro").hidden = true; $("b-run").hidden = false;
  $("breathe-label").textContent = ""; $("b-count").textContent = br.breaths;
  waveCtx().clearRect(0, 0, 393, 300);
  $("b-hint").style.opacity = 1;
  setPlayIcon(false);
  runLoop();
}
$("b-start").onclick = enterRun;
$("b-art-play").onclick = enterRun;
$("b-about").onclick = () => ($("b-about-text").hidden = !$("b-about-text").hidden);
const nextLength = () => { br.breaths = LENGTHS[(LENGTHS.indexOf(br.breaths) + 1) % LENGTHS.length]; lengthLabel(); $("b-count").textContent = br.breaths; };
$("b-length-btn").onclick = nextLength;
$("b-count").onclick = () => { if (!br.running && !br.elapsed) nextLength(); };
$("b-back").onclick = () => { show("chat"); scrollDown(); };

$("breathe-play").onclick = () => {
  if (br.running) {
    br.elapsed = elapsed(); br.running = false; hush();
    $("breathe").classList.remove("running"); setPlayIcon(false);
  } else {
    audioCtx?.resume?.();
    br.start = performance.now(); br.running = true; br.phase = null;
    $("breathe").classList.add("running"); setPlayIcon(true);
    $("b-hint").style.opacity = 0;
  }
};
$("breathe-mute").onclick = () => {
  br.muted = !br.muted;
  $("mute-wave").style.opacity = br.muted ? 0.2 : 1;
  $("breathe-mute").setAttribute("aria-label", br.muted ? "Sound off" : "Sound on");
  if (br.muted) hush();
};

// drag to rotate the orb
(() => {
  const c = $("orb");
  let last = null;
  c.addEventListener("pointerdown", (e) => { last = [e.clientX, e.clientY]; br.dragging = true; c.setPointerCapture(e.pointerId); $("b-hint").style.opacity = 0; });
  c.addEventListener("pointermove", (e) => {
    if (!last) return;
    br.yaw += (e.clientX - last[0]) * 0.01;
    br.pitch = Math.max(-1.2, Math.min(1.2, br.pitch + (e.clientY - last[1]) * 0.01));
    last = [e.clientX, e.clientY];
  });
  const up = () => { last = null; br.dragging = false; };
  c.addEventListener("pointerup", up); c.addEventListener("pointercancel", up);
})();

function finishBreathe(t) {
  br.running = false; hush();
  $("breathe").classList.remove("running");
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
$("breathe-close").onclick = () => finishBreathe(elapsed());
$("breathe-back").onclick = () => { show("chat"); scrollDown(); };

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

async function boot() {
  try {
    if ((await api("/api/access")).locked) { showLocked(); return; }
    const s = await loadState();
    show("chat");   // a brand-new visitor sees Elpis asking her name (added by the server)
  } catch (e) {
    if (e.message === "locked") return;
    document.body.innerHTML = `<p style="color:#fff;padding:24px">Elpis couldn't start: ${escapeHtml(e.message)}</p>`;
  }
}
boot();
