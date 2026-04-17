"""SQLite storage layer for the PDF reader assistant."""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "app.db"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)


SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    filename TEXT NOT NULL,
    num_pages INTEGER DEFAULT 0,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS highlights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    page INTEGER NOT NULL,
    text TEXT NOT NULL,
    summary TEXT,
    note TEXT,
    color TEXT DEFAULT 'yellow',
    created_at REAL NOT NULL,
    FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    meta TEXT,
    created_at REAL NOT NULL,
    FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


@contextmanager
def get_conn() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(SCHEMA)


def now() -> float:
    return time.time()


def upsert_document(doc_id: str, title: str, filename: str, num_pages: int) -> dict[str, Any]:
    ts = now()
    with get_conn() as conn:
        existing = conn.execute("SELECT id FROM documents WHERE id = ?", (doc_id,)).fetchone()
        if existing:
            conn.execute(
                "UPDATE documents SET title = ?, filename = ?, num_pages = ?, updated_at = ? WHERE id = ?",
                (title, filename, num_pages, ts, doc_id),
            )
        else:
            conn.execute(
                "INSERT INTO documents (id, title, filename, num_pages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (doc_id, title, filename, num_pages, ts, ts),
            )
    return get_document(doc_id)  # type: ignore[return-value]


def list_documents() -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM documents ORDER BY updated_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_document(doc_id: str) -> Optional[dict[str, Any]]:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
    return dict(row) if row else None


def delete_document(doc_id: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))


def add_highlight(
    doc_id: str,
    page: int,
    text: str,
    summary: Optional[str] = None,
    note: Optional[str] = None,
    color: str = "yellow",
) -> dict[str, Any]:
    ts = now()
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO highlights (doc_id, page, text, summary, note, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (doc_id, page, text, summary, note, color, ts),
        )
        hl_id = cur.lastrowid
        conn.execute("UPDATE documents SET updated_at = ? WHERE id = ?", (ts, doc_id))
        row = conn.execute("SELECT * FROM highlights WHERE id = ?", (hl_id,)).fetchone()
    return dict(row)


def update_highlight(hl_id: int, **fields: Any) -> Optional[dict[str, Any]]:
    allowed = {"summary", "note", "color", "text"}
    sets = {k: v for k, v in fields.items() if k in allowed}
    if not sets:
        return get_highlight(hl_id)
    cols = ", ".join(f"{k} = ?" for k in sets)
    vals = list(sets.values()) + [hl_id]
    with get_conn() as conn:
        conn.execute(f"UPDATE highlights SET {cols} WHERE id = ?", vals)
    return get_highlight(hl_id)


def get_highlight(hl_id: int) -> Optional[dict[str, Any]]:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM highlights WHERE id = ?", (hl_id,)).fetchone()
    return dict(row) if row else None


def list_highlights(doc_id: str) -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM highlights WHERE doc_id = ? ORDER BY page ASC, id ASC",
            (doc_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def delete_highlight(hl_id: int) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM highlights WHERE id = ?", (hl_id,))


def add_message(doc_id: str, role: str, content: str, meta: Optional[dict] = None) -> dict[str, Any]:
    ts = now()
    meta_json = json.dumps(meta, ensure_ascii=False) if meta else None
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO messages (doc_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)",
            (doc_id, role, content, meta_json, ts),
        )
        mid = cur.lastrowid
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (mid,)).fetchone()
    return dict(row)


def list_messages(doc_id: str, limit: int = 200) -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM messages WHERE doc_id = ? ORDER BY id ASC LIMIT ?",
            (doc_id, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def clear_messages(doc_id: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM messages WHERE doc_id = ?", (doc_id,))


def get_settings() -> dict[str, Any]:
    with get_conn() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
    out: dict[str, Any] = {}
    for r in rows:
        try:
            out[r["key"]] = json.loads(r["value"])
        except Exception:
            out[r["key"]] = r["value"]
    return out


def set_settings(data: dict[str, Any]) -> dict[str, Any]:
    with get_conn() as conn:
        for k, v in data.items():
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (k, json.dumps(v, ensure_ascii=False)),
            )
    return get_settings()
