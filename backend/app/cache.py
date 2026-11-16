"""Atomic JSON file cache.

Two cache tiers live under ``data/cache/`` (gitignored):

* fetched game lists, keyed by ``sha1(platform + username + time_control +
  game_count)`` with a 1h TTL;
* per-game engine analysis, keyed by ``sha1(pgn + depth)`` with no expiry.

All writes are atomic (write temp file + ``os.replace``) so a crash or a
concurrent reader never sees a partial file.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path
from typing import Any


def cache_key(*parts: str) -> str:
    digest = hashlib.sha1("\0".join(parts).encode("utf-8")).hexdigest()
    return digest


class FileCache:
    def __init__(self, directory: str | Path):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        return self.directory / f"{key}.json"

    def get(self, key: str, ttl_seconds: float | None = None) -> Any | None:
        path = self._path(key)
        try:
            with path.open("r", encoding="utf-8") as fh:
                envelope = json.load(fh)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return None
        if ttl_seconds is not None:
            age = time.time() - float(envelope.get("saved_at", 0))
            if age > ttl_seconds:
                return None
        return envelope.get("value")

    def set(self, key: str, value: Any) -> None:
        envelope = {"saved_at": time.time(), "value": value}
        path = self._path(key)
        # Unique temp name per process+thread: parallel workers writing the
        # same key must never share one temp file.
        tmp_path = path.with_suffix(f".tmp{os.getpid()}-{threading.get_ident()}")
        with tmp_path.open("w", encoding="utf-8") as fh:
            json.dump(envelope, fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, path)
