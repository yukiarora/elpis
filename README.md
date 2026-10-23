# Elpis

A private AI companion for women after miscarriage. It feels like returning to a friend: one continuous conversation with long-term memory, plus voice calls, a breathing space and a Restworld of kept happy moments.

## Run it

```bash
./run.sh            # first run creates .env; add your keys, then run again
open http://localhost:3000
```

Use Chrome or Safari, which have the speech recognition that voice calls need.

| `.env` key | What it's for |
|---|---|
| `ANTHROPIC_API_KEY` | Elpis's mind (required) |
| `ELEVENLABS_API_KEY` | Elpis's call voice. Without it the browser's built-in voice is used |
| `ELEVENLABS_VOICE_ID` | Which ElevenLabs voice to use |
| `ELPIS_MODEL` | Defaults to `claude-sonnet-4-6` |

Reset everything: `curl -X POST localhost:3000/api/reset`, or delete `elpis.db`.

## Share it with friends (Railway)

Hosted, each friend's browser gets its own private Elpis (name, conversation, memory, Restworld), behind a passcode you choose.

1. railway.com → **New Project** → **Deploy from GitHub repo** → `elpis`. It builds from the `Dockerfile`.
2. **Variables**: `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELPIS_PASSCODE` (any word you'll tell friends; not case-sensitive).
3. **Volume**: add a volume to the service, mounted at `/data`, so conversations survive redeploys.
4. **Settings → Networking → Generate Domain**, then share the link and the passcode.

**Or on Render:** render.com → **New → Blueprint** → `elpis`. `render.yaml` sets up the Starter plan, a disk at `/data` and the health check; Render asks for `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY` and `ELPIS_PASSCODE`.

Without `ELPIS_PASSCODE` (like on your own machine) there's no passcode and a single user.

## How it's built

FastAPI + Python backend, vanilla HTML/JS frontend, Claude for conversation, ElevenLabs for voice, and the Web Speech API for listening.

```
backend/
  app.py            API: streaming chat, call turns, Restworld, TTS
  memory.py         auto-compaction: at 60 messages, everything but the last 10 becomes a narrative memory
  safety.py         deterministic crisis guardrail (runs before the model) + hotline cards
  db.py             SQLite: profile, messages, memory summary, moments
  prompts/
    system.md       Elpis's personality: edit freely, it's re-read on every message
    compaction.md   what Elpis remembers
    sketch.md       turns a kept moment into a little line sketch
frontend/
  index.html  styles.css  app.js  assets/ (icons exported from Figma)
```

### Features
- **Onboarding.** She enters her name and Elpis speaks first, so she never lands on a blank screen.
- **One continuous chat.** There are no sessions. Reopening the app picks up where she left off. Suggested replies are generated per message and survive a refresh. `**bold**` is rendered as bold.
- **Spark of Joy → journaling.** Elpis notices real joy ("I'm so happy, I want to paint") and offers a contextual journal question. "Keep this memory" turns her answer into a sketch in her **Restworld**.
- **Low days.** Elpis can gently point her back to moments she kept, offer breathing, or just stay and talk.
- **Calls.** Speak with Elpis. Replies stream into a fixed-height area so the controls never move. Everything said on a call flows back into the chat.
- **Breathe.** A guided wave: 4 seconds in, 6 seconds out, with synthesized waves, rain or music.
- **Safety.** A regex guardrail flags suicide or self-harm and domestic-violence language before the model replies, and always shows US crisis resources (988, Crisis Text Line, DV Hotline, 911). The model is also instructed to respond with care and set `action: "crisis"`.

### Where the personality came from
`prompts/system.md` and `prompts/compaction.md` are copied verbatim from the Elpis deck up to the point where the deck's text cuts off. Everything after the `RECONSTRUCTED BELOW THIS LINE` marker was rewritten from the deck, the Loom demo and the Figma flows. Replace it with your own wording.
