"""Long-term memory: when the live conversation grows past COMPACTION_THRESHOLD messages, everything
except the most recent KEEP_RECENT is folded into a narrative summary written by Claude."""

import logging
import threading

import db
from prompts import load

COMPACTION_THRESHOLD = 60
KEEP_RECENT = 10

log = logging.getLogger("elpis.memory")
_lock = threading.Lock()


def _transcript(messages, name):
    who = {"user": name or "Her", "assistant": "Elpis", "event": "[App]"}
    lines = []
    for m in messages:
        tag = " (on a call)" if m["mode"] == "call" else ""
        lines.append(f"{who.get(m['role'], m['role'])}{tag}: {m['content']}")
    return "\n\n".join(lines)


def maybe_compact(client, model):
    if not _lock.acquire(blocking=False):
        return
    try:
        active = db.active_messages()
        if len(active) < COMPACTION_THRESHOLD:
            return
        to_compact = active[:-KEEP_RECENT]
        previous = db.get_summary()
        body = ""
        if previous:
            body += f"<earlier_summary>\n{previous}\n</earlier_summary>\n\n"
        body += f"<new_messages>\n{_transcript(to_compact, db.get_name())}\n</new_messages>"
        response = client.messages.create(
            model=model,
            max_tokens=4000,
            system=load("compaction"),
            messages=[{"role": "user", "content": body}],
        )
        summary = "".join(b.text for b in response.content if b.type == "text").strip()
        if summary:
            db.set_summary(summary)
            db.mark_compacted(to_compact[-1]["id"])
            log.info("Compacted %d messages into memory", len(to_compact))
    except Exception:
        log.exception("Compaction failed; will retry after the next message")
    finally:
        _lock.release()


def compact_in_background(client, model):
    threading.Thread(target=maybe_compact, args=(client, model), daemon=True).start()
