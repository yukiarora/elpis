"""Deterministic crisis guardrail. Runs on every message before the model sees it, so the SOS card
never depends on the model noticing. The model is also told how to respond (see prompts/system.md)."""

import re

SUICIDE = [
    r"\bkill(ing)? my ?self\b", r"\bend(ing)? (it|my life|things)\b", r"\bsuicid",
    r"\b(want|wanna|wish) (to )?(die|be dead|disappear forever)\b", r"\bno (longer )?(want|wish) to (live|be alive|be here)\b",
    r"\bdon'?t want to (live|be alive|be here|wake up)\b", r"\bnot (want(ing)? to )?be (alive|here) anymore\b",
    r"\b(better off|world.*better) without me\b", r"\bno reason to live\b", r"\bgoing bye\b",
    r"\b(saying|say) goodbye (to everyone|forever)\b", r"\bhurt(ing)? myself\b", r"\bself[- ]harm",
    r"\bcut(ting)? myself\b", r"\boverdose\b", r"\bcan'?t (go on|do this anymore|keep going)\b",
]
VIOLENCE = [
    r"\b(he|she|they|my (husband|partner|boyfriend|bf)) (hits?|beats?|chokes?|hurts?|threatens?) me\b",
    r"\b(hit|beat|choked|hurt|threatened) me\b", r"\bnot safe (at home|with him|with her)\b",
    r"\bafraid (of|for) my (life|safety)\b", r"\b(domestic|physical) (violence|abuse)\b", r"\babus(ive|ing) (partner|husband)\b",
]

_SUICIDE = [re.compile(p, re.I) for p in SUICIDE]
_VIOLENCE = [re.compile(p, re.I) for p in VIOLENCE]

RESOURCES = {
    "suicide": [
        {"name": "988 Suicide & Crisis Lifeline", "detail": "Free and confidential, 24/7.",
         "actions": [{"label": "Call 988", "href": "tel:988"}, {"label": "Text 988", "href": "sms:988"}]},
        {"name": "Crisis Text Line", "detail": "Text with a trained counselor, any time.",
         "actions": [{"label": "Text HOME to 741741", "href": "sms:741741?&body=HOME"}]},
    ],
    "violence": [
        {"name": "National Domestic Violence Hotline", "detail": "Confidential support, 24/7.",
         "actions": [{"label": "Call 1-800-799-7233", "href": "tel:18007997233"},
                     {"label": "Text START to 88788", "href": "sms:88788?&body=START"}]},
        {"name": "If you're in immediate danger", "detail": "Emergency services.",
         "actions": [{"label": "Call 911", "href": "tel:911"}]},
    ],
}


def detect(text):
    if any(p.search(text) for p in _SUICIDE):
        return "suicide"
    if any(p.search(text) for p in _VIOLENCE):
        return "violence"
    return None


def card(kind):
    return {"kind": kind, "resources": RESOURCES[kind]} if kind in RESOURCES else None
