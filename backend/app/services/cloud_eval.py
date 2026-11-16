"""Lichess cloud evaluation lookup — first tier, local Stockfish fallback.

Before spending local CPU on a position, ask the Lichess cloud database
(``GET https://lichess.org/api/cloud-eval``), which holds deep engine
analysis for millions of positions reached in real games. Any failure —
timeout, non-200, malformed payload, illegal best move — falls back
silently to local Stockfish; the caller never sees an error.

Caching rules (never request the same position twice):
* disk: every successful response is stored under
  ``data/cache/cloud_eval/`` keyed by sha1 of the normalized FEN (first
  four fields — halfmove/fullmove counters stripped), with no expiry;
* memory: a per-process memo holds hits AND misses, so a position that
  404s is not re-requested within a run.

Rate discipline: sequential requests only (one shared client, short
timeout), no concurrency beyond the existing analysis worker threads.
The Lichess API is a free public service — the disk cache is what keeps
repeat analyses off it entirely.

Eval conventions match ``analyzer/engine.py``: centipawns from White's
perspective, mates encoded as ±(MATE_CP - distance). The Lichess API
already returns evals from White's perspective — verified 2026-11-16
against local Stockfish (after 1.e4, black to move: API cp +18, local
+20s; after 1.e4 e5 2.Qh5, black to move: API cp -25, local -28; black
mating in 1: API mate -1) — so NO sign flip is applied for black-to-move
positions. (An earlier version flipped the sign, inverting every
cloud-sourced eval with Black to move; fixed 2026-11-16.)
"""
from __future__ import annotations

import hashlib
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import chess
import httpx

from ..cache import FileCache
from ..config import settings

# Must match MATE_CP in analyzer/engine.py (kept local to avoid an import
# cycle: engine.py imports this module).
MATE_CP = 10000

CLOUD_EVAL_URL = "https://lichess.org/api/cloud-eval"
CLOUD_EVAL_TIMEOUT_SECONDS = 2.0


@dataclass(frozen=True)
class CloudEvalResult:
    """A cloud evaluation, normalized to the engine's conventions."""

    cp_white: int
    best_move: chess.Move
    depth: int


def normalize_fen(fen: str) -> str:
    """FEN without the halfmove/fullmove counters — the cache key."""
    return " ".join(fen.split(" ")[:4])


def _fen_key(fen: str) -> str:
    return hashlib.sha1(normalize_fen(fen).encode("utf-8")).hexdigest()


def _mate_to_cp(mate: int) -> int:
    """Mate distance (White's perspective, as the API returns it) ->
    centipawns. Positive mate = White mates; negative = White is mated."""
    return MATE_CP - mate if mate > 0 else -MATE_CP - mate


class CloudEvalClient:
    """Thread-safe Lichess cloud-eval client with memo + disk cache."""

    def __init__(
        self,
        cache_dir: str | Path | None = None,
        transport: httpx.BaseTransport | None = None,
        timeout: float = CLOUD_EVAL_TIMEOUT_SECONDS,
        user_agent: str | None = None,
    ):
        self._disk = FileCache(cache_dir or (settings.CACHE_DIR / "cloud_eval"))
        self._http = httpx.Client(
            timeout=timeout,
            transport=transport,
            headers={"User-Agent": user_agent or settings.USER_AGENT},
        )
        self._memo: dict[str, dict[str, Any] | None] = {}
        self._memo_lock = threading.Lock()
        # Observability counters (best-effort, for reporting hit rates).
        self.stats = {"memo": 0, "disk": 0, "http_hit": 0, "http_miss": 0, "error": 0}

    # -- public -----------------------------------------------------------

    def lookup(self, board: chess.Board) -> CloudEvalResult | None:
        """Return the cloud eval for ``board`` or None (fall back locally)."""
        fen = board.fen()
        key = _fen_key(fen)

        with self._memo_lock:
            if key in self._memo:
                self.stats["memo"] += 1
                stored = self._memo[key]
                return self._to_result(board, stored) if stored else None

        stored = self._disk.get(key)
        if stored is not None:
            with self._memo_lock:
                self.stats["disk"] += 1
                self._memo[key] = stored
            return self._to_result(board, stored)

        stored = self._fetch(fen)
        with self._memo_lock:
            self._memo[key] = stored
        if stored is None:
            return None
        self._disk.set(key, stored)
        return self._to_result(board, stored)

    # -- internals --------------------------------------------------------

    def _to_result(
        self, board: chess.Board, stored: dict[str, Any] | None
    ) -> CloudEvalResult | None:
        """Convert a stored raw payload to engine conventions.

        Stored payloads keep the API's White-perspective ``cp``/``mate``
        plus the best move in UCI — no sign flip is applied (see the
        module docstring). The best move is re-validated against the
        board: a stored move that is not legal here means corrupt/stale
        data and is treated as a miss.
        """
        if not stored:
            return None
        try:
            best = chess.Move.from_uci(stored["best_uci"])
            if best not in board.legal_moves:
                return None
            if stored.get("mate") is not None:
                cp_white = _mate_to_cp(int(stored["mate"]))
            elif stored.get("cp") is not None:
                cp_white = int(stored["cp"])
            else:
                return None
        except (KeyError, ValueError, TypeError):
            return None
        return CloudEvalResult(
            cp_white=cp_white, best_move=best, depth=int(stored.get("depth", 0))
        )

    def _fetch(self, fen: str) -> dict[str, Any] | None:
        """One cloud request. Any failure returns None (silent fallback)."""
        try:
            resp = self._http.get(
                CLOUD_EVAL_URL, params={"fen": fen, "multiPv": 1}
            )
        except httpx.HTTPError:
            with self._memo_lock:
                self.stats["error"] += 1
            return None
        if resp.status_code != 200:
            with self._memo_lock:
                self.stats["http_miss"] += 1
            return None
        try:
            data = resp.json()
            pv = data["pvs"][0]
            moves = str(pv["moves"]).split()
            if not moves:
                return None
            stored: dict[str, Any] = {
                "best_uci": moves[0],
                "depth": int(data.get("depth", 0)),
            }
            if pv.get("mate") is not None:
                stored["mate"] = int(pv["mate"])
            elif pv.get("cp") is not None:
                stored["cp"] = int(pv["cp"])
            else:
                return None
        except (ValueError, KeyError, IndexError, TypeError, AttributeError):
            with self._memo_lock:
                self.stats["error"] += 1
            return None
        with self._memo_lock:
            self.stats["http_hit"] += 1
        return stored


# -- process-wide default client (shared by all engine workers) -----------

_default_client: CloudEvalClient | None = None
_default_lock = threading.Lock()


def get_default_client() -> CloudEvalClient:
    global _default_client
    if _default_client is None:
        with _default_lock:
            if _default_client is None:
                _default_client = CloudEvalClient()
    return _default_client
