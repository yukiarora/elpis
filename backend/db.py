"""SQLite storage. Each person (uid) has one continuous conversation, a memory summary, and Restworld moments.
Run locally without a passcode, everything belongs to the single uid "local"."""

import json
import os
import sqlite3
import time
from pathlib import Path

DB_PATH = Path(os.getenv("ELPIS_DB_PATH") or Path(__file__).resolve().parent.parent / "elpis.db")
LOCAL = "local"

SCHEMA = """
CREATE TABLE IF NOT EXISTS profile (uid TEXT PRIMARY KEY, name TEXT, created_at REAL);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL DEFAULT 'local',
    role TEXT NOT NULL,            -- 'user' | 'assistant' | 'event'
    content TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'chat',   -- 'chat' | 'call'
    meta TEXT,                     -- JSON: suggestions, action, journal_prompt, safety
    compacted INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_uid ON messages (uid, id);
CREATE TABLE IF NOT EXISTS memory (uid TEXT PRIMARY KEY, summary TEXT, updated_at REAL);
CREATE TABLE IF NOT EXISTS moments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL DEFAULT 'local',
    title TEXT, prompt TEXT, text TEXT, svg TEXT, created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS moments_uid ON moments (uid, id);
"""


def connect():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def _columns(c, table):
    return {r["name"] for r in c.execute(f"PRAGMA table_info({table})")}


def _migrate(c):
    """Databases from the single-user version keep their conversation under uid 'local'."""
    for table in ("messages", "moments"):
        cols = _columns(c, table)
        if cols and "uid" not in cols:
            c.execute(f"ALTER TABLE {table} ADD COLUMN uid TEXT NOT NULL DEFAULT 'local'")
    for table, rest in (("profile", "name, created_at"), ("memory", "summary, updated_at")):
        cols = _columns(c, table)
        if cols and "uid" not in cols:
            c.execute(f"ALTER TABLE {table} RENAME TO {table}_old")
            c.executescript(SCHEMA)
            c.execute(f"INSERT INTO {table} (uid, {rest}) SELECT 'local', {rest} FROM {table}_old")
            c.execute(f"DROP TABLE {table}_old")


def init():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as c:
        _migrate(c)
        c.executescript(SCHEMA)


def reset(uid):
    """Erase one person's name, conversation, memory and Restworld."""
    with connect() as c:
        for table in ("profile", "messages", "memory", "moments"):
            c.execute(f"DELETE FROM {table} WHERE uid = ?", (uid,))


def get_name(uid):
    with connect() as c:
        row = c.execute("SELECT name FROM profile WHERE uid = ?", (uid,)).fetchone()
        return row["name"] if row else None


def set_name(uid, name):
    with connect() as c:
        c.execute("INSERT INTO profile (uid, name, created_at) VALUES (?, ?, ?) "
                  "ON CONFLICT(uid) DO UPDATE SET name = excluded.name", (uid, name, time.time()))


def add_message(uid, role, content, mode="chat", meta=None):
    with connect() as c:
        cur = c.execute("INSERT INTO messages (uid, role, content, mode, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                        (uid, role, content, mode, json.dumps(meta) if meta else None, time.time()))
        return cur.lastrowid


def _row(r):
    d = dict(r)
    d["meta"] = json.loads(d["meta"]) if d["meta"] else {}
    return d


def all_messages(uid, limit=400):
    """Everything she can scroll back through (compacted messages stay visible in the UI)."""
    with connect() as c:
        rows = c.execute("SELECT * FROM messages WHERE uid = ? ORDER BY id DESC LIMIT ?", (uid, limit)).fetchall()
        return [_row(r) for r in reversed(rows)]


def active_messages(uid):
    """Messages not yet folded into the memory summary — these go to the model verbatim."""
    with connect() as c:
        return [_row(r) for r in c.execute(
            "SELECT * FROM messages WHERE uid = ? AND compacted = 0 ORDER BY id", (uid,)).fetchall()]


def mark_compacted(uid, up_to_id):
    with connect() as c:
        c.execute("UPDATE messages SET compacted = 1 WHERE uid = ? AND id <= ?", (uid, up_to_id))


def last_message_time(uid):
    with connect() as c:
        row = c.execute("SELECT created_at FROM messages WHERE uid = ? AND role != 'event' ORDER BY id DESC LIMIT 1",
                        (uid,)).fetchone()
        return row["created_at"] if row else None


def get_summary(uid):
    with connect() as c:
        row = c.execute("SELECT summary FROM memory WHERE uid = ?", (uid,)).fetchone()
        return row["summary"] if row else None


def set_summary(uid, summary):
    with connect() as c:
        c.execute("INSERT INTO memory (uid, summary, updated_at) VALUES (?, ?, ?) "
                  "ON CONFLICT(uid) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at",
                  (uid, summary, time.time()))


def add_moment(uid, title, prompt, text, svg):
    with connect() as c:
        cur = c.execute("INSERT INTO moments (uid, title, prompt, text, svg, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                        (uid, title, prompt, text, svg, time.time()))
        return cur.lastrowid


def moments(uid):
    with connect() as c:
        return [dict(r) for r in c.execute("SELECT * FROM moments WHERE uid = ? ORDER BY id DESC", (uid,)).fetchall()]


def delete_moment(uid, moment_id):
    with connect() as c:
        c.execute("DELETE FROM moments WHERE uid = ? AND id = ?", (uid, moment_id))
