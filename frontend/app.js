// Elpis frontend — vanilla JS. One continuous conversation; call, breathe and Rest World all flow back into it.

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
  for (const id of ["onboarding", "chat", "call", "breathe", "restworld"]) $(id).hidden = id !== screenId;
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
  row.innerHTML = `<div class="body">${escapeHtml(text)}</div>`;
  messagesEl.appendChild(row);
}
function addEvent(text) {
  const el = document.createElement("div");
  el.className = "event"; el.textContent = text;
  messagesEl.appendChild(el);
}
function clearTransient() { messagesEl.querySelectorAll(".chips, .card.action").forEach((el) => el.remove()); }

function addSafetyCard(card) {
  const el = document.createElement("div");
  el.className = "card safety";
  el.innerHTML = `<div class="eyebrow">If you need someone right now</div>` + card.resources.map((r) => `
    <div class="row"><b>${escapeHtml(r.name)}</b><small>${escapeHtml(r.detail)}</small>
    <div class="acts">${r.actions.map((a) => `<a class="act" href="${a.href}">${escapeHtml(a.label)}</a>`).join("")}</div></div>`).join("");
  messagesEl.appendChild(el);
}

function addActionCard(icon, label, onClick) {
  const el = document.createElement("button");
  el.className = "card action";
  el.innerHTML = `<img src="/assets/${icon}" alt=""><span>${escapeHtml(label)}</span>`;
  el.onclick = onClick;
  messagesEl.appendChild(el);
}

function addChips(suggestions) {
  if (!suggestions?.length) return;
  const wrap = document.createElement("div");
  wrap.className = "chips";
  for (const s of suggestions) {
    const b = document.createElement("button");
    b.className = "chip"; b.textContent = s;
    b.onclick = () => handleChip(s);
    wrap.appendChild(b);
  }
  messagesEl.appendChild(wrap);
}
function handleChip(s) {
  const t = s.toLowerCase();
  if (/open my rest world/.test(t) && state.moments > 0) { clearTransient(); openRestWorld(); return; }
  sendMessage(s);
}

// Follow-up UI for the model's action: journal / rest world / breathe.
function renderAfter(meta, { live } = {}) {
  if (meta.action === "journal" && meta.journal_prompt) {
    addActionCard("icon.svg", "Journal this moment", () => openJournal(meta.journal_prompt));
  } else if (meta.action === "rest_world" && state.moments > 0) {
    addActionCard("icon.svg", "Open your Rest World", () => { clearTransient(); openRestWorld(); });
  } else if (meta.action === "breathe") {
    addActionCard("call-icon.svg", "Start a breathing space", () => { clearTransient(); openBreathe(); });
  }
  addChips(meta.suggestions);
  if (live) scrollDown();
}

async function loadState() {
  const s = await api("/api/state");
  Object.assign(state, { name: s.name, voice: s.voice, moments: s.moments });
  messagesEl.innerHTML = "";
  let lastMode = "chat";
  s.messages.forEach((m, i) => {
    if (m.mode === "call" && lastMode !== "call" && m.role !== "event") addEvent("Call with Elpis");
    if (m.role !== "event") lastMode = m.mode;
    if (m.role === "user") addUser(m.content, m.mode);
    else if (m.role === "assistant") {
      addElpis(m.content);
      if (m.meta?.safety) addSafetyCard(m.meta.safety);
    } else if (m.role === "event" && /^(She kept|Voice call ended|She did a breathing)/.test(m.content)) {
      addEvent(eventLabel(m.content));
    }
    // Suggestions + action survive refresh, but only for the latest Elpis message.
    if (i === s.messages.length - 1 && m.role === "assistant") renderAfter(m.meta || {});
  });
  scrollDown();
  return s;
}
function eventLabel(text) {
  if (text.startsWith("She kept")) return "✦ " + (/"([^"]+)"/.exec(text)?.[1] || "Moment") + " kept in your Rest World";
  if (text.startsWith("Voice call ended")) return text.replace("Voice call ended", "Call ended").replace(/\.$/, "");
  if (text.startsWith("She did a breathing")) return "Breathing space · " + (/for (.+?)\./.exec(text)?.[1] || "");
  return text;
}

// ---------- sending ----------

async function sendMessage(text, { event } = {}) {
  if (state.busy) return;
  state.busy = true;
  clearTransient();
  if (text) addUser(text);
  const body = elpisRow();
  body.innerHTML = `<span class="typing"><i></i><i></i><i></i></span>`;
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
  sendMessage(null, { event: "onboard" });   // Elpis speaks first — no blank screen
});

// ---------- bottom sheets ----------

function openSheet(id) { $("scrim").hidden = false; $(id).hidden = false; }
function closeSheets() { $("scrim").hidden = true; document.querySelectorAll(".sheet").forEach((s) => (s.hidden = true)); }
$("scrim").onclick = closeSheets;
$("tools-btn").onclick = () => openSheet("tools-sheet");
document.querySelectorAll(".tool").forEach((b) => (b.onclick = () => {
  closeSheets();
  ({ breathe: openBreathe, restworld: openRestWorld, call: startCall })[b.dataset.tool]();
}));

// ---------- journaling → Rest World ----------

let journalPrompt = "";
function openJournal(prompt) {
  journalPrompt = prompt;
  $("j-prompt").textContent = prompt;
  $("j-text").value = "";
  $("j-keep").disabled = false; $("j-keep").textContent = "Keep this memory";
  openSheet("journal-sheet");
  setTimeout(() => $("j-text").focus(), 250);
}
$("j-cancel").onclick = closeSheets;
$("j-keep").onclick = async () => {
  const text = $("j-text").value.trim();
  if (!text) { $("j-text").focus(); return; }
  $("j-keep").disabled = true; $("j-keep").textContent = "Sketching your moment…";
  try {
    const moment = await api("/api/moments", { prompt: journalPrompt, text });
    closeSheets(); clearTransient();
    state.moments += 1;
    addEvent(`✦ ${moment.title} kept in your Rest World`);
    openRestWorld(moment.id);
  } catch (e) {
    $("j-keep").disabled = false; $("j-keep").textContent = "Try again";
  }
};

// ---------- Rest World ----------

const fmtDate = (t) => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const svgSrc = (svg) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);

async function openRestWorld(newId) {
  show("restworld");
  $("rw-detail").hidden = true;
  const grid = $("rw-grid");
  grid.innerHTML = "";
  const moments = await api("/api/moments");
  state.moments = moments.length;
  if (!moments.length) {
    grid.innerHTML = `<div class="rw-empty"><img src="/assets/icon.svg" alt=""><br>Nothing here yet.<br>When something brings you a little joy, Elpis will help you keep it here.</div>`;
    return;
  }
  for (const m of moments) {
    const card = document.createElement("button");
    card.className = "moment" + (m.id === newId ? " new" : "");
    card.innerHTML = `<img alt="" src="${svgSrc(m.svg)}"><b>${escapeHtml(m.title)}</b><small>${fmtDate(m.created_at)}</small>`;
    card.onclick = () => openMoment(m);
    grid.appendChild(card);
  }
}
function openMoment(m) {
  const d = $("rw-detail");
  d.innerHTML = `<img alt="" src="${svgSrc(m.svg)}"><h3>${escapeHtml(m.title)}</h3>
    ${m.prompt ? `<p class="q">${escapeHtml(m.prompt)}</p>` : ""}<div class="t">${escapeHtml(m.text)}</div>
    <div class="rw-actions"><button class="pill-btn" id="m-back">Back</button><button class="text-btn" id="m-del">Let this one go</button></div>`;
  d.hidden = false;
  $("m-back").onclick = () => (d.hidden = true);
  $("m-del").onclick = async () => {
    if (!confirm("Remove this moment from your Rest World?")) return;
    await api(`/api/moments/${m.id}`, null, "DELETE");
    openRestWorld();
  };
}
$("rw-close").onclick = () => { show("chat"); scrollDown(); };

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
    logEvent(`She did a breathing exercise for ${m ? `${m} min ` : ""}${s} sec.`);
    addEvent(`Breathing space · ${m ? `${m} min ` : ""}${s} sec`);
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
  closeSheets();
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
$("voice-btn").onclick = startCall;
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
