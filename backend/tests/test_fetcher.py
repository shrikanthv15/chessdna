"""Tests for the fetcher's date parsing and game normalization."""
import chess

from app.services.fetcher import (
    _date_from_headers,
    _normalize_chesscom_game,
    _normalize_lichess_game,
    backfill_game_dates,
    date_from_pgn,
)

PGN = (
    '[White "Hikaru"]\n[Black "Opponent"]\n[Date "2025.03.04"]\n'
    '[UTCDate "2025.03.04"]\n[Result "1-0"]\n\n1. e4 e5 1-0\n'
)


def test_date_prefers_utcdate():
    assert (
        _date_from_headers({"UTCDate": "2025.03.04", "Date": "2025.03.05"})
        == "2025-03-04"
    )


def test_date_falls_back_to_date():
    assert _date_from_headers({"Date": "2025.03.04"}) == "2025-03-04"


def test_date_rejects_placeholders_and_invalid():
    assert _date_from_headers({"Date": "????.??.??"}) is None
    assert _date_from_headers({"Date": "2025.??.??"}) is None
    assert _date_from_headers({"Date": "2025.13.40"}) is None
    assert _date_from_headers({"UTCDate": "2025.02.30"}) is None
    assert _date_from_headers({}) is None
    assert _date_from_headers({"Date": "yesterday"}) is None


def test_chesscom_normalize_carries_date():
    raw = {
        "white": {"username": "Hikaru", "result": "win"},
        "black": {"username": "Opponent", "result": "checkmated"},
        "url": "https://www.chess.com/game/live/1",
        "time_class": "blitz",
        "pgn": PGN,
    }
    game = _normalize_chesscom_game(raw, "Hikaru")
    assert game is not None
    assert game["date"] == "2025-03-04"
    assert game["result"] == "win"
    assert game["user_color"] == "white"
    assert game["opponent"] == "Opponent"


def test_chesscom_normalize_missing_date_is_none():
    pgn = '[White "Hikaru"]\n[Black "Opponent"]\n\n1. e4 e5 1-0\n'
    raw = {
        "white": {"username": "Hikaru", "result": "win"},
        "black": {"username": "Opponent", "result": "resigned"},
        "url": "https://www.chess.com/game/live/1",
        "time_class": "blitz",
        "pgn": pgn,
    }
    game = _normalize_chesscom_game(raw, "Hikaru")
    assert game is not None
    assert game["date"] is None


def test_lichess_normalize_carries_date():
    raw = {
        "id": "abc123",
        "players": {
            "white": {"user": {"name": "Hikaru"}},
            "black": {"user": {"name": "Opponent"}},
        },
        "winner": "white",
        "speed": "blitz",
        "pgn": PGN,
        "opening": {"eco": "C20", "name": "King's Pawn Game"},
    }
    game = _normalize_lichess_game(raw, "Hikaru")
    assert game is not None
    assert game["date"] == "2025-03-04"
    assert game["eco"] == "C20"
    assert game["url"] == "https://lichess.org/abc123"


def test_date_from_pgn_reads_headers():
    assert date_from_pgn(PGN) == "2025-03-04"


def test_date_from_pgn_no_headers_is_none():
    assert date_from_pgn("1. e4 e5 1-0\n") is None
    assert date_from_pgn("") is None
    assert date_from_pgn("not a pgn at all") is None


def test_backfill_game_dates_fills_stale_entries():
    stale = {"pgn": PGN}  # no "date" key: pre-v2 fetch-cache entry
    fresh = {"pgn": PGN, "date": "2024-01-01"}
    nodate = {"pgn": "1. e4 e5 1-0\n"}
    games = backfill_game_dates([stale, fresh, nodate])
    assert games[0]["date"] == "2025-03-04"
    assert games[1]["date"] == "2024-01-01"  # untouched
    assert games[2]["date"] is None  # never fabricated
