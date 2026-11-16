"""ChessDNA backend API.

Endpoints:
    GET  /api/health          service + Stockfish status
    POST /api/analyze         start an analysis job (202 + job_id)
    GET  /api/status/{job_id} job progress and PlayerDNA result
    POST /api/coach           coaching summary + checklist for a finished job

Jobs run as asyncio background tasks; the Stockfish work runs in a worker
thread (``asyncio.to_thread``) so the event loop stays responsive. Job
state lives in memory; fetched games and per-game engine analyses are
cached on disk under ``data/cache/``.
"""
from __future__ import annotations

import asyncio
import subprocess
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Literal

import chess
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .analyzer.aggregator import build_player_dna
from .analyzer.classifier import classify_record
from .analyzer.engine import EngineAnalyzer, ensure_game_context
from .cache import FileCache, cache_key
from .config import settings
from .services.coach import generate_coaching
from .services.fetcher import FetchError, backfill_game_dates, fetch_games

FETCH_CACHE_TTL_SECONDS = 3600.0

# Bump when the classifier or engine output format changes, so cached
# per-game analyses are re-computed instead of serving stale tags.
ANALYSIS_CACHE_VERSION = "2"

app = FastAPI(title="ChessDNA", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

cache = FileCache(settings.CACHE_DIR)

# In-memory job store: job_id -> job dict.
jobs: dict[str, dict[str, Any]] = {}

# One analysis at a time: a job already saturates every core with its
# worker engines, so a second concurrent job would only slow both down.
# Queued jobs wait here with an honest progress message.
_engine_lock = asyncio.Lock()


class AnalyzeRequest(BaseModel):
    platform: Literal["chesscom", "lichess"]
    username: str = Field(min_length=1, max_length=64)
    time_control: Literal["all", "rapid", "blitz", "bullet"] = "all"
    game_count: Literal[25, 50, 100] = 50
    depth: int = Field(default=12, ge=1, le=20)


class CoachRequest(BaseModel):
    job_id: str
    llm_base_url: str | None = None
    llm_api_key: str | None = None
    llm_model: str | None = None


# ---------------------------------------------------------------------------
# health
# ---------------------------------------------------------------------------


def _stockfish_alive(path: str) -> bool:
    try:
        proc = subprocess.run(
            [path],
            input="uci\nquit\n",
            capture_output=True,
            text=True,
            timeout=5,
        )
        return "uciok" in proc.stdout
    except (OSError, subprocess.SubprocessError):
        return False


@app.get("/api/health")
def health() -> dict[str, Any]:
    path = settings.STOCKFISH_PATH
    alive = bool(path) and _stockfish_alive(path)
    return {"status": "ok", "stockfish": alive, "stockfish_path": path}


# ---------------------------------------------------------------------------
# analysis jobs
# ---------------------------------------------------------------------------


@app.post("/api/analyze", status_code=202)
async def analyze(request: AnalyzeRequest) -> dict[str, str]:
    job_id = uuid.uuid4().hex
    jobs[job_id] = {
        "job_id": job_id,
        "status": "pending",
        "progress": {"current": 0, "total": 0, "message": "Queued…"},
        "result": None,
        "error": None,
        "request": request.model_dump(),
    }
    asyncio.create_task(_run_job(job_id, request))
    return {"job_id": job_id, "status": "pending"}


@app.get("/api/status/{job_id}")
def job_status(job_id: str) -> dict[str, Any]:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown job_id: {job_id}")
    return {
        "job_id": job["job_id"],
        "status": job["status"],
        "progress": job["progress"],
        "result": job["result"],
        "error": job["error"],
    }


def _set_progress(job: dict[str, Any], current: int, total: int, message: str) -> None:
    job["progress"] = {"current": current, "total": total, "message": message}


async def _run_job(job_id: str, request: AnalyzeRequest) -> None:
    job = jobs[job_id]
    try:
        job["status"] = "running"
        _set_progress(job, 0, 0, f"Fetching games for {request.username}…")

        fetch_key = cache_key(
            "fetch", request.platform, request.username.lower(),
            request.time_control, str(request.game_count),
        )
        games = cache.get(fetch_key, ttl_seconds=FETCH_CACHE_TTL_SECONDS)
        if games is None:
            games = await fetch_games(
                request.platform, request.username, request.time_control, request.game_count
            )
            cache.set(fetch_key, games)
        # Fetch-cache entries written before the "date" field existed carry
        # no date; recover it from the stored PGN headers so game identity
        # is never silently missing.
        backfill_game_dates(games)

        if _engine_lock.locked():
            _set_progress(
                job, 0, len(games),
                "Waiting for the engine — another analysis is running…",
            )
        async with _engine_lock:
            _set_progress(job, 0, len(games), f"Analyzing game 0/{len(games)}…")
            analyses = await asyncio.to_thread(
                _analyze_games, job, games, request.depth
            )

        _set_progress(job, len(games), len(games), "Building your Player DNA…")
        dna = build_player_dna(
            username=request.username,
            platform=request.platform,
            time_control=request.time_control,
            games_requested=request.game_count,
            analyses=analyses,
        )
        job["result"] = dna
        job["status"] = "done"
        _set_progress(job, len(games), len(games), "Done.")
    except FetchError as exc:
        job["status"] = "error"
        job["error"] = str(exc)
    except Exception as exc:  # keep the job inspectable instead of hanging
        job["status"] = "error"
        job["error"] = f"Analysis failed: {exc}"


def _analyze_games(
    job: dict[str, Any], games: list[dict[str, Any]], depth: int
) -> list[dict[str, Any]]:
    """Synchronous engine work: runs in a worker thread. Games are analyzed
    in parallel across ANALYZE_WORKERS threads, each with its own
    single-threaded Stockfish process — one worker per core. Per-game
    results cached by sha1(pgn + depth)."""
    stockfish_path = settings.STOCKFISH_PATH
    if not stockfish_path:
        raise RuntimeError(
            "Stockfish binary not found. Run backend/scripts/setup_stockfish.sh "
            "and set STOCKFISH_PATH in backend/.env."
        )
    workers = max(1, settings.ANALYZE_WORKERS)
    results: list[dict[str, Any] | None] = [None] * len(games)
    if workers == 1 or len(games) == 1:
        for index, game in enumerate(games):
            _set_progress(
                job, index, len(games), f"Analyzing game {index + 1}/{len(games)}…"
            )
            results[index] = _analyze_one(game, depth, stockfish_path)
        return [r for r in results if r is not None]
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(_analyze_one, game, depth, stockfish_path): index
            for index, game in enumerate(games)
        }
        for future in as_completed(futures):
            results[futures[future]] = future.result()
            done += 1
            _set_progress(
                job, done, len(games), f"Analyzing game {done}/{len(games)}…"
            )
    return [r for r in results if r is not None]


def _analyze_one(
    game: dict[str, Any], depth: int, stockfish_path: str
) -> dict[str, Any]:
    """Analyze a single game (cache-first). Opens its own engine process so
    worker threads never share Stockfish state; engine startup (~0.1s) is
    negligible next to a game's analysis time. The cache key carries the
    analyzer version: classifier/engine changes must re-analyze rather
    than serve stale tags."""
    game_key = cache_key("analysis", ANALYSIS_CACHE_VERSION, game["pgn"], str(depth))
    analysis = cache.get(game_key)
    if analysis is None:
        with EngineAnalyzer(stockfish_path, depth=depth) as analyzer:
            analysis = analyzer.analyze_game(game)
        _classify_analysis(analysis)
        cache.set(game_key, analysis)
    else:
        # Older cached analyses predate the v2 game-context fields; fill
        # them in from the PGN + cached records (no engine calls).
        ensure_game_context(analysis, game)
    return analysis


def _classify_analysis(analysis: dict[str, Any]) -> None:
    """Attach blind-spot tags to every blunder-level move in an analysis."""
    user_color = (
        chess.WHITE if analysis["game"]["user_color"] == "white" else chess.BLACK
    )
    for move in analysis["moves"]:
        if move["severity"] != "blunder":
            move["tags"] = []
            move["primary"] = "unclassified"
            move["explanations"] = {}
            continue
        classification = classify_record(move, user_color)
        move["tags"] = classification.tags
        move["primary"] = classification.primary
        move["explanations"] = classification.explanations


# ---------------------------------------------------------------------------
# coach
# ---------------------------------------------------------------------------


@app.post("/api/coach")
async def coach(request: CoachRequest) -> dict[str, Any]:
    job = jobs.get(request.job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown job_id: {request.job_id}")
    if job["status"] != "done" or job["result"] is None:
        raise HTTPException(
            status_code=400,
            detail=f"Job {request.job_id} is not finished (status: {job['status']}).",
        )
    # API keys from the request are used for this call only, never stored.
    return await generate_coaching(
        job["result"],
        llm_base_url=request.llm_base_url,
        llm_api_key=request.llm_api_key,
        llm_model=request.llm_model,
    )
