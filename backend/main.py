"""FastAPI app for the PDF Reader AI assistant."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from pypdf import PdfReader

from . import llm, storage

ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "static"
PDF_DIR = ROOT / "data" / "pdfs"
PDF_DIR.mkdir(parents=True, exist_ok=True)

storage.init_db()

app = FastAPI(title="PDF Reader AI", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DEFAULT_SETTINGS: dict[str, Any] = {
    "provider": "openai",
    "base_url": "https://api.openai.com/v1",
    "api_key": "",
    "model": "gpt-4o-mini",
    "temperature": 0.3,
    "language": "zh",
}


# ---------- helpers ----------

def _ensure_settings() -> dict[str, Any]:
    current = storage.get_settings()
    merged = {**DEFAULT_SETTINGS, **current}
    return merged


def _safe_filename(name: str) -> str:
    name = re.sub(r"[^\w\-. \u4e00-\u9fff]", "_", name).strip() or "document.pdf"
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    return name


def _extract_page_text(path: Path, page: int) -> str:
    try:
        reader = PdfReader(str(path))
        if page < 1 or page > len(reader.pages):
            return ""
        text = reader.pages[page - 1].extract_text() or ""
        return text.strip()
    except Exception:
        return ""


def _doc_path(doc: dict[str, Any]) -> Path:
    return PDF_DIR / doc["filename"]


def _truncate(text: str, limit: int = 4000) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + " …(truncated)"


def _build_context_for_chat(
    doc: dict[str, Any],
    current_page: Optional[int],
    selection: Optional[str],
    max_highlights: int = 20,
) -> str:
    parts: list[str] = []
    parts.append(f"当前文档：《{doc['title']}》，共 {doc.get('num_pages', 0)} 页。")

    highlights = storage.list_highlights(doc["id"])
    if highlights:
        kb_lines = []
        for h in highlights[-max_highlights:]:
            line = f"[第 {h['page']} 页] {_truncate(h['text'], 400)}"
            if h.get("summary"):
                line += f"\n  • 摘要：{_truncate(h['summary'], 300)}"
            if h.get("note"):
                line += f"\n  • 笔记：{_truncate(h['note'], 200)}"
            kb_lines.append(line)
        parts.append("用户已标注的知识片段（按时间排序，最近的在后）：\n" + "\n---\n".join(kb_lines))
    else:
        parts.append("用户目前还没有标注任何知识片段。")

    if current_page:
        page_text = _extract_page_text(_doc_path(doc), current_page)
        if page_text:
            parts.append(f"当前正在阅读第 {current_page} 页，该页原文如下：\n{_truncate(page_text, 3000)}")

    if selection:
        parts.append(f"用户刚刚选中的文字：\n{_truncate(selection, 1500)}")

    return "\n\n".join(parts)


# ---------- settings ----------

@app.get("/api/settings")
def api_get_settings() -> dict[str, Any]:
    s = _ensure_settings()
    # Mask the api key in responses so it isn't leaked via logs, but return
    # a flag so the UI knows whether one is configured.
    masked = {**s}
    if masked.get("api_key"):
        key = masked["api_key"]
        masked["api_key"] = (key[:4] + "…" + key[-4:]) if len(key) > 8 else "****"
        masked["api_key_set"] = True
    else:
        masked["api_key_set"] = False
    return masked


class SettingsIn(BaseModel):
    provider: Optional[str] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    model: Optional[str] = None
    temperature: Optional[float] = None
    language: Optional[str] = None


@app.post("/api/settings")
def api_set_settings(body: SettingsIn) -> dict[str, Any]:
    data = body.model_dump(exclude_none=True)
    if "api_key" in data and data["api_key"] == "":
        data.pop("api_key")
    storage.set_settings(data)
    return api_get_settings()


# ---------- documents ----------

@app.get("/api/documents")
def api_list_docs() -> list[dict[str, Any]]:
    return storage.list_documents()


@app.post("/api/documents")
async def api_upload_doc(file: UploadFile = File(...)) -> dict[str, Any]:
    if not file.filename:
        raise HTTPException(status_code=400, detail="missing filename")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty file")

    digest = hashlib.sha1(raw).hexdigest()[:16]
    safe = _safe_filename(file.filename)
    stored_name = f"{digest}_{safe}"
    target = PDF_DIR / stored_name
    if not target.exists():
        target.write_bytes(raw)

    try:
        reader = PdfReader(str(target))
        num_pages = len(reader.pages)
        meta_title = ""
        try:
            meta_title = (reader.metadata.title or "").strip() if reader.metadata else ""
        except Exception:
            meta_title = ""
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"不是有效的 PDF：{exc}") from exc

    title = meta_title or Path(safe).stem
    doc = storage.upsert_document(doc_id=digest, title=title, filename=stored_name, num_pages=num_pages)
    return doc


@app.get("/api/documents/{doc_id}")
def api_get_doc(doc_id: str) -> dict[str, Any]:
    doc = storage.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")
    return doc


@app.delete("/api/documents/{doc_id}")
def api_delete_doc(doc_id: str) -> dict[str, str]:
    doc = storage.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")
    storage.delete_document(doc_id)
    p = _doc_path(doc)
    if p.exists():
        try:
            p.unlink()
        except Exception:
            pass
    return {"status": "ok"}


@app.get("/api/documents/{doc_id}/file")
def api_doc_file(doc_id: str) -> FileResponse:
    doc = storage.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")
    path = _doc_path(doc)
    if not path.exists():
        raise HTTPException(status_code=404, detail="file missing")
    return FileResponse(path, media_type="application/pdf", filename=doc["filename"])


# ---------- highlights ----------

class HighlightIn(BaseModel):
    page: int = Field(ge=1)
    text: str
    summary: Optional[str] = None
    note: Optional[str] = None
    color: str = "yellow"


@app.get("/api/documents/{doc_id}/highlights")
def api_list_highlights(doc_id: str) -> list[dict[str, Any]]:
    if not storage.get_document(doc_id):
        raise HTTPException(status_code=404, detail="document not found")
    return storage.list_highlights(doc_id)


@app.post("/api/documents/{doc_id}/highlights")
def api_add_highlight(doc_id: str, body: HighlightIn) -> dict[str, Any]:
    if not storage.get_document(doc_id):
        raise HTTPException(status_code=404, detail="document not found")
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="text is empty")
    return storage.add_highlight(
        doc_id=doc_id,
        page=body.page,
        text=body.text.strip(),
        summary=body.summary,
        note=body.note,
        color=body.color,
    )


class HighlightPatch(BaseModel):
    summary: Optional[str] = None
    note: Optional[str] = None
    color: Optional[str] = None
    text: Optional[str] = None


@app.patch("/api/highlights/{hl_id}")
def api_patch_highlight(hl_id: int, body: HighlightPatch) -> dict[str, Any]:
    updated = storage.update_highlight(hl_id, **body.model_dump(exclude_none=True))
    if not updated:
        raise HTTPException(status_code=404, detail="highlight not found")
    return updated


@app.delete("/api/highlights/{hl_id}")
def api_delete_highlight(hl_id: int) -> dict[str, str]:
    storage.delete_highlight(hl_id)
    return {"status": "ok"}


# ---------- summarize ----------

class SummarizeIn(BaseModel):
    text: str
    page: int = Field(ge=1)
    save: bool = True
    style: str = "concise"  # concise | bullet | detailed


@app.post("/api/documents/{doc_id}/summarize")
def api_summarize(doc_id: str, body: SummarizeIn) -> dict[str, Any]:
    doc = storage.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is empty")

    s = _ensure_settings()
    lang = "中文" if s.get("language", "zh") == "zh" else "English"
    style_map = {
        "concise": "用 2-4 句话给出凝练的要点概括",
        "bullet": "用 3-6 条项目符号（使用 `- ` 开头）列出关键点",
        "detailed": "给出一段 5-8 句话的详细解读，可以结合上下文并指出可能的延伸问题",
    }
    style_hint = style_map.get(body.style, style_map["concise"])

    page_ctx = _extract_page_text(_doc_path(doc), body.page)

    system = (
        f"你是一个学术阅读助手。回答请使用{lang}。"
        "请基于用户选中的文本进行准确的信息提炼，如果原文有歧义请指出。"
        "禁止编造原文中没有的信息。"
    )
    user = (
        f"文档标题：《{doc['title']}》（共 {doc.get('num_pages', 0)} 页）\n"
        f"当前页：第 {body.page} 页\n\n"
        f"【选中的文本】\n{text}\n\n"
        f"【所在页上下文（供参考，可能被截断）】\n{_truncate(page_ctx, 2500)}\n\n"
        f"任务：{style_hint}。直接输出结果，不要前言。"
    )

    try:
        summary = llm.chat(
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            api_key=s.get("api_key"),
            base_url=s.get("base_url"),
            model=s.get("model", "gpt-4o-mini"),
            temperature=float(s.get("temperature", 0.3)),
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LLM 调用失败：{exc}") from exc

    highlight = None
    if body.save:
        highlight = storage.add_highlight(
            doc_id=doc_id,
            page=body.page,
            text=text,
            summary=summary,
        )
    return {"summary": summary, "highlight": highlight}


# ---------- chat ----------

@app.get("/api/documents/{doc_id}/messages")
def api_list_messages(doc_id: str) -> list[dict[str, Any]]:
    if not storage.get_document(doc_id):
        raise HTTPException(status_code=404, detail="document not found")
    return storage.list_messages(doc_id)


@app.delete("/api/documents/{doc_id}/messages")
def api_clear_messages(doc_id: str) -> dict[str, str]:
    if not storage.get_document(doc_id):
        raise HTTPException(status_code=404, detail="document not found")
    storage.clear_messages(doc_id)
    return {"status": "ok"}


class ChatIn(BaseModel):
    message: str
    current_page: Optional[int] = None
    selection: Optional[str] = None
    history_limit: int = 16


@app.post("/api/documents/{doc_id}/chat")
def api_chat(doc_id: str, body: ChatIn) -> StreamingResponse:
    doc = storage.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")
    msg = body.message.strip()
    if not msg:
        raise HTTPException(status_code=400, detail="empty message")

    s = _ensure_settings()
    lang = "中文" if s.get("language", "zh") == "zh" else "English"
    context = _build_context_for_chat(doc, body.current_page, body.selection)

    system = (
        f"你是一个贴心的学术阅读伙伴，语言使用{lang}。"
        "用户正在阅读一份 PDF，你的职责是基于【文档上下文】和【用户已标注的知识片段】回答问题。"
        "优先引用已有的知识片段（标注页码），必要时可结合当前页原文。"
        "如果当前提供的上下文中找不到答案，请明确告知并建议用户去查找相关页面，不要编造。"
        "回答要条理清晰、尽量简洁，可以使用 Markdown。"
    )

    history = storage.list_messages(doc_id)[-body.history_limit:]
    history_msgs = [{"role": m["role"], "content": m["content"]} for m in history if m["role"] in ("user", "assistant")]

    user_block = f"【文档上下文】\n{context}\n\n【用户问题】\n{msg}"

    messages = [{"role": "system", "content": system}, *history_msgs, {"role": "user", "content": user_block}]

    # persist the user-visible message (no context baked in)
    user_meta = {"current_page": body.current_page}
    if body.selection:
        user_meta["selection"] = body.selection[:1000]
    storage.add_message(doc_id, "user", msg, meta=user_meta)

    def gen():
        buffer: list[str] = []
        try:
            for delta in llm.stream_chat(
                messages=messages,
                api_key=s.get("api_key"),
                base_url=s.get("base_url"),
                model=s.get("model", "gpt-4o-mini"),
                temperature=float(s.get("temperature", 0.3)),
            ):
                buffer.append(delta)
                yield f"data: {json.dumps({'delta': delta}, ensure_ascii=False)}\n\n"
        except Exception as exc:  # pragma: no cover - network errors
            err_text = "\n\n[LLM 调用失败] " + str(exc)
            buffer.append(err_text)
            payload = json.dumps({"delta": err_text}, ensure_ascii=False)
            yield f"data: {payload}\n\n"
        finally:
            full = "".join(buffer).strip()
            if full:
                storage.add_message(doc_id, "assistant", full)
            yield f"data: {json.dumps({'done': True}, ensure_ascii=False)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


# ---------- static frontend ----------

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
