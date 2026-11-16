"""Game ingestion from the Chess.com Public API and the Lichess API.

Both sources are normalized into the same game dict::

    {
        "pgn": str,                 # full PGN (mainline, with clock comments)
        "url": str,                 # link to the game on the platform
        "user_color": "white"|"black",
        "result": "win"|"loss"|"draw",   # from the user's perspective
        "opponent": str,
        "eco": str,                 # e.g. "B12" ("" when unknown)
        "eco_name": str,            # e.g. "Caro-Kann Defense"
        "time_class": str,          # "rapid"|"blitz"|"bullet"
        "date": str | None,         # ISO date "YYYY-MM-DD" from the PGN
                                    # Date/UTCDate headers (None when absent
                                    # or malformed — never fabricated)
        "clocks": [                 # one entry per ply that has clock data
            {"ply": int, "clock_seconds": float,
             "move_time_seconds": float | None},
        ],
    }

Clock data comes from ``[%clk h:mm:ss]`` PGN comments (Chess.com and Lichess
both embed them) or, for Lichess, from the ``clocks`` array in the NDJSON
payload. ``move_time_seconds`` is the time the player spent on that move,
reconstructed from consecutive clocks of the same color plus the increment.
"""
from __future__ import annotations

import datetime
import io
import json
import re
from typing import Any

import chess.pgn
import httpx

from ..config import settings

CHESSCOM_BASE = "https://api.chess.com/pub"
LICHESS_BASE = "https://lichess.org"

# Chess.com result strings: "win" means that side won; everything else is a
# loss for that side except the known draw outcomes.
CHESSCOM_DRAW_RESULTS = {
    "agreed",
    "stalemate",
    "repetition",
    "insufficient",
    "timevsinsufficient",
    "50move",
    "threefold",
}

TIME_CLASSES = ("rapid", "blitz", "bullet")

_CLK_RE = re.compile(r"\[%clk\s+(\d+(?::\d+){1,2}(?:\.\d+)?)\]")
_TC_RE = re.compile(r"^\s*(\d+)(?:\+(\d+))?")
_DATE_RE = re.compile(r"^(\d{4})\.(\d{2})\.(\d{2})$")


def _date_from_headers(headers: Any) -> str | None:
    """ISO date from the PGN UTCDate/Date headers.

    Prefers UTCDate (the actual UTC play date) over Date. Only fully
    numeric ``YYYY.MM.DD`` values that form a real calendar date are
    accepted; anything else (``????.??.??``, partial dates, junk) yields
    None — a missing date is always better than a fabricated one.
    """
    for key in ("UTCDate", "Date"):
        raw = (headers.get(key) or "").strip()
        match = _DATE_RE.match(raw)
        if not match:
            continue
        try:
            return datetime.date(
                int(match.group(1)), int(match.group(2)), int(match.group(3))
            ).isoformat()
        except ValueError:
            continue
    return None


def date_from_pgn(pgn: str) -> str | None:
    """ISO date from a PGN string's headers (header parse only, no replay).

    Used to backfill ``date`` on game dicts that came from a fetch-cache
    entry written before the ``date`` field existed. Any parse failure
    yields None — never fabricated.
    """
    try:
        headers = chess.pgn.read_headers(io.StringIO(pgn))
    except Exception:
        return None
    if headers is None:
        return None
    return _date_from_headers(headers)


def backfill_game_dates(games: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fill a missing ``date`` on each game dict from its stored PGN.

    Games that already carry a date are untouched. Mutates in place and
    returns the same list for convenience.
    """
    for game in games:
        if not game.get("date") and game.get("pgn"):
            game["date"] = date_from_pgn(game["pgn"])
    return games


class FetchError(Exception):
    """Raised when game fetching fails (unknown user, API error, no games)."""


def _parse_clock_text(text: str) -> float | None:
    # Accepts "M:SS", "H:MM:SS", and fractional seconds ("0:02:58.4").
    parts = text.split(":")
    try:
        nums = [float(p) for p in parts]
    except ValueError:
        return None
    if len(nums) == 2:
        minutes, seconds = nums
        return minutes * 60 + seconds
    if len(nums) == 3:
        hours, minutes, seconds = nums
        return hours * 3600 + minutes * 60 + seconds
    return None


def _parse_time_control(header: str) -> tuple[float | None, float]:
    """Return (base_seconds, increment_seconds) from a TimeControl header."""
    match = _TC_RE.match(header or "")
    if not match:
        return None, 0.0
    base = float(match.group(1))
    increment = float(match.group(2) or 0)
    return base, increment


def extract_clocks_from_pgn(pgn_text: str) -> list[dict[str, Any]]:
    """Parse [%clk ...] comments into per-ply clock entries.

    The clock comment on a move is the mover's remaining time *after* the
    move. Move time is reconstructed from the same color's previous clock
    plus the increment.
    """
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None:
        return []
    base, increment = _parse_time_control(game.headers.get("TimeControl", ""))

    raw: list[tuple[int, float]] = []
    for ply, node in enumerate(game.mainline()):
        match = _CLK_RE.search(node.comment or "")
        if match:
            seconds = _parse_clock_text(match.group(1))
            if seconds is not None:
                raw.append((ply, seconds))
    if not raw:
        return []

    by_ply = dict(raw)
    clocks: list[dict[str, Any]] = []
    last_by_color: dict[int, float] = {}
    for ply, seconds in raw:
        color = ply % 2  # 0 = white (plies 0, 2, ...), 1 = black
        prev = last_by_color.get(color, base)
        move_time = None
        if prev is not None:
            move_time = max(0.0, prev - seconds + increment)
        last_by_color[color] = seconds
        clocks.append(
            {
                "ply": ply,
                "clock_seconds": seconds,
                "move_time_seconds": move_time,
            }
        )
    _ = by_ply
    return clocks


def _eco_from_headers(headers: Any) -> tuple[str, str]:
    eco = (headers.get("ECO") or "").strip()
    name = (headers.get("Opening") or "").strip()
    if not name:
        url = headers.get("ECOUrl") or ""
        slug = url.rstrip("/").rsplit("/", 1)[-1] if url else ""
        name = slug.replace("-", " ").strip()
    return eco, name


def _headers_for(pgn_text: str) -> Any:
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    return game.headers if game is not None else {}


# ---------------------------------------------------------------------------
# Chess.com
# ---------------------------------------------------------------------------


async def _fetch_chesscom(
    client: httpx.AsyncClient,
    username: str,
    time_control: str,
    game_count: int,
) -> list[dict[str, Any]]:
    archives_resp = await client.get(f"{CHESSCOM_BASE}/player/{username}/games/archives")
    if archives_resp.status_code == 404:
        raise FetchError(f"Chess.com user '{username}' not found.")
    archives_resp.raise_for_status()
    archives = archives_resp.json().get("archives", [])
    if not archives:
        raise FetchError(f"No game archives found for Chess.com user '{username}'.")

    wanted = TIME_CLASSES if time_control == "all" else (time_control,)
    collected: list[dict[str, Any]] = []
    # Archives are oldest-first; walk from the newest backwards, and within
    # each archive take the most recent games first.
    for archive_url in reversed(archives):
        if len(collected) >= game_count:
            break
        resp = await client.get(archive_url)
        if resp.status_code != 200:
            continue
        for raw in reversed(resp.json().get("games", [])):
            if len(collected) >= game_count:
                break
            if raw.get("time_class") not in wanted:
                continue
            pgn_text = raw.get("pgn") or ""
            if not pgn_text.strip():
                continue
            game = _normalize_chesscom_game(raw, username)
            if game is not None:
                collected.append(game)
    collected.reverse()  # chronological order
    return collected


def _normalize_chesscom_game(raw: dict[str, Any], username: str) -> dict[str, Any] | None:
    white = raw.get("white") or {}
    black = raw.get("black") or {}
    user_lower = username.lower()
    if (white.get("username") or "").lower() == user_lower:
        user_color = "white"
        user_result = white.get("result")
        opp_result = black.get("result")
        opponent = black.get("username") or "?"
    elif (black.get("username") or "").lower() == user_lower:
        user_color = "black"
        user_result = black.get("result")
        opp_result = white.get("result")
        opponent = white.get("username") or "?"
    else:
        return None

    if user_result == "win":
        result = "win"
    elif opp_result == "win":
        result = "loss"
    elif user_result in CHESSCOM_DRAW_RESULTS or opp_result in CHESSCOM_DRAW_RESULTS:
        result = "draw"
    else:
        # Abandoned / unknown outcomes: treat as a draw unless a side won.
        result = "draw"

    pgn_text = raw.get("pgn") or ""
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None or not list(game.mainline_moves()):
        return None  # skip move-less (aborted) games
    eco, eco_name = _eco_from_headers(game.headers)

    return {
        "pgn": pgn_text,
        "url": raw.get("url") or "",
        "user_color": user_color,
        "result": result,
        "opponent": opponent,
        "eco": eco,
        "eco_name": eco_name or "Unknown Opening",
        "time_class": raw.get("time_class") or "",
        "date": _date_from_headers(game.headers),
        "clocks": extract_clocks_from_pgn(pgn_text),
    }


# ---------------------------------------------------------------------------
# Lichess
# ---------------------------------------------------------------------------


async def _fetch_lichess(
    client: httpx.AsyncClient,
    username: str,
    time_control: str,
    game_count: int,
) -> list[dict[str, Any]]:
    # Over-fetch when filtering client-side so a mixed history still yields
    # enough games of the requested time control.
    params = {
        "max": str(min(game_count * 3, 300)),
        "pgnInJson": "true",
        "clocks": "true",
        "opening": "true",
        "evals": "false",
        "moves": "true",
    }
    resp = await client.get(
        f"{LICHESS_BASE}/api/games/user/{username}",
        params=params,
        headers={"Accept": "application/x-ndjson"},
    )
    if resp.status_code == 404:
        raise FetchError(f"Lichess user '{username}' not found.")
    resp.raise_for_status()

    wanted = TIME_CLASSES if time_control == "all" else (time_control,)
    collected: list[dict[str, Any]] = []
    for line in resp.text.splitlines():
        if len(collected) >= game_count:
            break
        line = line.strip()
        if not line:
            continue
        try:
            raw = json.loads(line)
        except ValueError:
            continue
        if raw.get("variant") not in (None, "standard"):
            continue
        speed = raw.get("speed") or raw.get("perf")
        if speed not in wanted:
            continue
        if raw.get("status") in ("aborted", "noStart"):
            continue
        game = _normalize_lichess_game(raw, username)
        if game is not None:
            collected.append(game)
    collected.reverse()  # chronological order
    return collected


def _normalize_lichess_game(raw: dict[str, Any], username: str) -> dict[str, Any] | None:
    players = raw.get("players") or {}
    white_user = ((players.get("white") or {}).get("user") or {}).get("name", "")
    black_user = ((players.get("black") or {}).get("user") or {}).get("name", "")
    user_lower = username.lower()
    if white_user.lower() == user_lower:
        user_color = "white"
        opponent = black_user or "?"
    elif black_user.lower() == user_lower:
        user_color = "black"
        opponent = white_user or "?"
    else:
        return None

    winner = raw.get("winner")
    if winner == user_color:
        result = "win"
    elif winner in ("white", "black"):
        result = "loss"
    else:
        result = "draw"

    pgn_text = raw.get("pgn") or ""
    if not pgn_text.strip():
        # Fall back to the UCI move list when no PGN was returned.
        moves = (raw.get("moves") or "").split()
        if not moves:
            return None
        pgn_text = _pgn_from_uci_moves(raw, moves)
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None or not list(game.mainline_moves()):
        return None

    opening = raw.get("opening") or {}
    eco = (opening.get("eco") or "").strip()
    eco_name = (opening.get("name") or "").strip()
    if not eco:
        eco, header_name = _eco_from_headers(game.headers)
        eco_name = eco_name or header_name

    num_moves = len(list(game.mainline_moves()))
    clocks = _lichess_clocks(raw, pgn_text, num_moves)
    return {
        "pgn": pgn_text,
        "url": f"{LICHESS_BASE}/{raw.get('id', '')}",
        "user_color": user_color,
        "result": result,
        "opponent": opponent,
        "eco": eco,
        "eco_name": eco_name or "Unknown Opening",
        "time_class": raw.get("speed") or raw.get("perf") or "",
        "date": _date_from_headers(game.headers),
        "clocks": clocks,
    }


def _lichess_clocks(
    raw: dict[str, Any], pgn_text: str, num_moves: int
) -> list[dict[str, Any]]:
    """Prefer the NDJSON ``clocks`` array.

    Lichess returns clock times in CENTISECONDS, one per ply, with one
    trailing extra entry (len == moves + 1). Entry ``i`` is the mover's
    remaining time after ply ``i`` — verified against the PGN ``[%clk]``
    comments, which match entry-for-entry after dividing by 100.
    """
    raw_clocks = raw.get("clocks")
    if isinstance(raw_clocks, list) and raw_clocks:
        clock_cfg = raw.get("clock") or {}
        increment = float(clock_cfg.get("increment") or 0)
        base = clock_cfg.get("initial")
        base = float(base) if base is not None else None
        clocks: list[dict[str, Any]] = []
        last_by_color: dict[int, float] = {}
        for ply, centiseconds in enumerate(raw_clocks[:num_moves]):
            try:
                seconds_f = float(centiseconds) / 100.0
            except (TypeError, ValueError):
                continue
            color = ply % 2
            prev = last_by_color.get(color, base)
            move_time = None
            if prev is not None:
                move_time = max(0.0, prev - seconds_f + increment)
            last_by_color[color] = seconds_f
            clocks.append(
                {
                    "ply": ply,
                    "clock_seconds": seconds_f,
                    "move_time_seconds": move_time,
                }
            )
        if clocks:
            return clocks
    return extract_clocks_from_pgn(pgn_text)


def _pgn_from_uci_moves(raw: dict[str, Any], moves: list[str]) -> str:
    import chess

    board = chess.Board()
    sans: list[str] = []
    for uci in moves:
        try:
            move = chess.Move.from_uci(uci)
        except ValueError:
            break
        if move not in board.legal_moves:
            break
        sans.append(board.san(move))
        board.push(move)
    players = raw.get("players") or {}
    white = ((players.get("white") or {}).get("user") or {}).get("name", "?")
    black = ((players.get("black") or {}).get("user") or {}).get("name", "?")
    result_map = {"white": "1-0", "black": "0-1", None: "1/2-1/2"}
    result = result_map.get(raw.get("winner"), "1/2-1/2")
    movetext_parts: list[str] = []
    for i, san in enumerate(sans):
        if i % 2 == 0:
            movetext_parts.append(f"{i // 2 + 1}. {san}")
        else:
            movetext_parts.append(san)
    movetext = " ".join(movetext_parts) + f" {result}"
    return (
        f'[White "{white}"]\n[Black "{black}"]\n[Result "{result}"]\n\n{movetext}\n'
    )


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


async def fetch_games(
    platform: str,
    username: str,
    time_control: str,
    game_count: int,
) -> list[dict[str, Any]]:
    """Fetch and normalize the user's most recent games from a platform."""
    username = username.strip()
    if not username:
        raise FetchError("Username must not be empty.")
    headers = {"User-Agent": settings.USER_AGENT}
    timeout = httpx.Timeout(30.0, connect=10.0)
    async with httpx.AsyncClient(headers=headers, timeout=timeout, follow_redirects=True) as client:
        try:
            if platform == "chesscom":
                games = await _fetch_chesscom(client, username, time_control, game_count)
            elif platform == "lichess":
                games = await _fetch_lichess(client, username, time_control, game_count)
            else:
                raise FetchError(f"Unknown platform: {platform!r}")
        except httpx.HTTPStatusError as exc:
            raise FetchError(f"Upstream API error ({exc.response.status_code}) while fetching games.")
        except httpx.RequestError as exc:
            raise FetchError(f"Network error while fetching games: {exc}")
    if not games:
        raise FetchError(
            f"No {time_control} games found for '{username}' on {platform}."
        )
    return games
