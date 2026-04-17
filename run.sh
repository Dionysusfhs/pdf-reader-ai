#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  echo "[setup] creating virtualenv..."
  python3 -m venv .venv
fi

source .venv/bin/activate

echo "[setup] installing dependencies..."
pip install -q --disable-pip-version-check -r requirements.txt

echo "[run] starting server on http://127.0.0.1:8765"
exec python -m uvicorn backend.main:app --host 127.0.0.1 --port 8765 --reload
