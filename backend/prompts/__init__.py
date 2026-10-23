"""Prompts live in .md files next to this module and are re-read on every request,
so you can edit them while the server is running."""

import re
from pathlib import Path

_DIR = Path(__file__).resolve().parent


def load(name):
    text = (_DIR / f"{name}.md").read_text(encoding="utf-8")
    return re.sub(r"<!--.*?-->\s*", "", text, flags=re.S).strip()
