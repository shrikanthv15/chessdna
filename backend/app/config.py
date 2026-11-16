"""Configuration for ChessDNA backend.

Settings come from ``backend/.env`` (see ``../.env.example``), with sane
defaults so the app runs out of the box with no LLM key configured.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent

load_dotenv(BACKEND_DIR / ".env")


def _sanitize_no_proxy() -> None:
    """httpx fails to parse bracketed IPv6 entries (e.g. ``[::1]``) in
    NO_PROXY (``InvalidURL: Invalid port``), which breaks every proxied
    request. Strip bracketed entries at import time; the unbracketed forms
    (``::1``, ``127.0.0.1``, ``localhost``) remain, so proxy-bypass
    behavior for local addresses is unchanged."""
    for key in ("NO_PROXY", "no_proxy"):
        value = os.environ.get(key)
        if value and "[" in value:
            os.environ[key] = ",".join(
                part for part in value.split(",") if "[" not in part
            )


_sanitize_no_proxy()


def _resolve_stockfish() -> str | None:
    """Resolve the Stockfish binary path.

    Precedence: STOCKFISH_PATH env var, backend/bin/stockfish (durable copy
    installed by scripts/setup_stockfish.sh), then anything on PATH.
    """
    candidates: list[str] = []
    env_path = os.getenv("STOCKFISH_PATH", "").strip()
    if env_path:
        candidates.append(env_path)
    candidates.append(str(BACKEND_DIR / "bin" / "stockfish"))
    which = shutil.which("stockfish")
    if which:
        candidates.append(which)
    for candidate in candidates:
        path = Path(candidate)
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
    return None


class Settings:
    LLM_BASE_URL: str = os.getenv("LLM_BASE_URL", "http://localhost:11434/v1").rstrip("/")
    LLM_API_KEY: str = os.getenv("LLM_API_KEY", "")
    LLM_MODEL: str = os.getenv("LLM_MODEL", "gpt-oss:120b")
    ENGINE_DEPTH: int = int(os.getenv("ENGINE_DEPTH", "12"))
    ANALYZE_WORKERS: int = max(1, int(os.getenv("ANALYZE_WORKERS", "2")))
    CORS_ORIGINS: list[str] = [
        origin.strip()
        for origin in os.getenv(
            "CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
        ).split(",")
        if origin.strip()
    ]
    STOCKFISH_PATH: str | None = _resolve_stockfish()
    CACHE_DIR: Path = REPO_ROOT / "data" / "cache"
    USER_AGENT: str = "ChessDNA/1.0 (personal chess diagnostic; contact: none)"


settings = Settings()
