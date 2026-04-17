"""Thin wrapper around OpenAI-compatible chat completion APIs."""
from __future__ import annotations

import os
from typing import AsyncIterator, Iterable

from openai import OpenAI


DEFAULT_BASE = "https://api.openai.com/v1"


def get_client(api_key: str | None, base_url: str | None) -> OpenAI:
    key = (api_key or os.environ.get("OPENAI_API_KEY") or "").strip()
    base = (base_url or DEFAULT_BASE).strip().rstrip("/")
    if not key:
        raise RuntimeError("缺少 API Key，请在设置里填写。")
    return OpenAI(api_key=key, base_url=base)


def chat(
    messages: Iterable[dict],
    *,
    api_key: str | None,
    base_url: str | None,
    model: str,
    temperature: float = 0.3,
    max_tokens: int = 1200,
) -> str:
    client = get_client(api_key, base_url)
    resp = client.chat.completions.create(
        model=model,
        messages=list(messages),
        temperature=temperature,
        max_tokens=max_tokens,
    )
    if not resp.choices:
        return ""
    return (resp.choices[0].message.content or "").strip()


def stream_chat(
    messages: Iterable[dict],
    *,
    api_key: str | None,
    base_url: str | None,
    model: str,
    temperature: float = 0.3,
    max_tokens: int = 1600,
) -> Iterable[str]:
    """Yield text deltas from a streaming chat completion."""
    client = get_client(api_key, base_url)
    stream = client.chat.completions.create(
        model=model,
        messages=list(messages),
        temperature=temperature,
        max_tokens=max_tokens,
        stream=True,
    )
    for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if delta and delta.content:
            yield delta.content
