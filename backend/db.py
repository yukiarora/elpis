"""SQLite storage: one user, one continuous conversation, a memory summary, and Rest World moments."""

import json
import sqlite3
import time
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "elpis.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT, created_at REAL);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,            -- 'user' | 'assistant' | 'event'
    content TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'chat',   -- 'chat' | 'call'
    meta TEXT,                     -- JSON: suggestions, action, journal_prompt, safety
    compacted INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY CHECK (id = 1), summary TEXT, updated_at REAL);
CREATE TABLE IF NOT EXISTS moments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT, prompt TEXT, text TEXT, svg TEXT, created_at REAL NOT NULL
);
"""


def connect():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init():
    with connect() as c:
        c.executescript(SCHEMA)


def reset():
    with connect() as c:
        c.executescript("DROP TABLE IF EXISTS profile; DROP TABLE IF EXISTS messages; "
                        "DROP TABLE IF EXISTS memory; DROP TABLE IF EXISTS moments;")
        c.executescript(SCHEMA)


def get_name():
    with connect() as c:
        row = c.execute("SELECT name FROM profile WHERE id = 1").fetchone()
        return row["name"] if row else None


def set_name(name):
    with connect() as c:
        c.execute("INSERT INTO profile (id, name, created_at) VALUES (1, ?, ?) "
                  "ON CONFLICT(id) DO UPDATE SET name = excluded.name", (name, time.time()))


def add_message(role, content, mode="chat", meta=None):
    with connect() as c:
        cur = c.execute("INSERT INTO messages (role, content, mode, meta, created_at) VALUES (?, ?, ?, ?, ?)",
                        (role, content, mode, json.dumps(meta) if meta else None, time.time()))
        return cur.lastrowid


def _row(r):
    d = dict(r)
    d["meta"] = json.loads(d["meta"]) if d["meta"] else {}
    return d


def all_messages(limit=400):
    """Everything she can scroll back through (compacted messages stay visible in the UI)."""
    with connect() as c:
        rows = c.execute("SELECT * FROM messages ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [_row(r) for r in reversed(rows)]


def active_messages():
    """Messages not yet folded into the memory summary — these go to the model verbatim."""
    with connect() as c:
        return [_row(r) for r in c.execute("SELECT * FROM messages WHERE compacted = 0 ORDER BY id").fetchall()]


def mark_compacted(up_to_id):
    with connect() as c:
        c.execute("UPDATE messages SET compacted = 1 WHERE id <= ?", (up_to_id,))


def last_message_time():
    with connect() as c:
        row = c.execute("SELECT created_at FROM messages WHERE role != 'event' ORDER BY id DESC LIMIT 1").fetchone()
        return row["created_at"] if row else None


def get_summary():
    with connect() as c:
        row = c.execute("SELECT summary FROM memory WHERE id = 1").fetchone()
        return row["summary"] if row else None


def set_summary(summary):
    with connect() as c:
        c.execute("INSERT INTO memory (id, summary, updated_at) VALUES (1, ?, ?) "
                  "ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at",
                  (summary, time.time()))


def add_moment(title, prompt, text, svg):
    with connect() as c:
        cur = c.execute("INSERT INTO moments (title, prompt, text, svg, created_at) VALUES (?, ?, ?, ?, ?)",
                        (title, prompt, text, svg, time.time()))
        return cur.lastrowid


def moments():
    with connect() as c:
        return [dict(r) for r in c.execute("SELECT * FROM moments ORDER BY id DESC").fetchall()]


def delete_moment(moment_id):
    with connect() as c:
        c.execute("DELETE FROM moments WHERE id = ?", (moment_id,))
