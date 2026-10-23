#!/usr/bin/env bash
# Start Elpis at http://localhost:3000
set -e
cd "$(dirname "$0")"
[ -f .env ] || { cp .env.example .env; echo "Created .env — add your API keys to it, then run again."; exit 1; }
[ -d .venv ] || python3 -m venv .venv
. .venv/bin/activate
pip install -q -r requirements.txt
cd backend && exec uvicorn app:app --port 3000 --reload
