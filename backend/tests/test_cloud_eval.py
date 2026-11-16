"""Tests for the Lichess cloud eval client (mocked HTTP — no network)."""
import chess
import httpx
import pytest

from app.services.cloud_eval import CloudEvalClient, normalize_fen

START = chess.Board().fen()
AFTER_E4 = chess.Board(START)
AFTER_E4.push_uci("e2e4")
AFTER_E4_FEN = AFTER_E4.fen()


def _client(tmp_path, handler):
    calls = {"n": 0}

    def wrapped(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return handler(request)

    client = CloudEvalClient(
        cache_dir=tmp_path / "cloud_eval", transport=httpx.MockTransport(wrapped)
    )
    return client, calls


def _hit(cp=None, mate=None, moves="e2e4 e7e5", depth=30):
    pv = {"moves": moves}
    if mate is not None:
        pv["mate"] = mate
    else:
        pv["cp"] = cp
    return httpx.Response(200, json={"depth": depth, "pvs": [pv]})


def test_cloud_hit_white_perspective(tmp_path):
    client, calls = _client(tmp_path, lambda req: _hit(cp=45))
    result = client.lookup(chess.Board(START))
    assert result is not None
    assert result.cp_white == 45
    assert result.best_move.uci() == "e2e4"
    assert result.depth == 30
    # Second lookup: memo, no second HTTP call.
    assert client.lookup(chess.Board(START)) is not None
    assert calls["n"] == 1


def test_cloud_hit_black_to_move_negated(tmp_path):
    client, _ = _client(tmp_path, lambda req: _hit(cp=30, moves="e7e5 d2d4"))
    result = client.lookup(chess.Board(AFTER_E4_FEN))
    assert result is not None
    assert result.cp_white == -30
    assert result.best_move.uci() == "e7e5"


def test_cloud_mate_encoding(tmp_path):
    client, _ = _client(tmp_path, lambda req: _hit(mate=3, moves="g1f3"))
    result = client.lookup(chess.Board(START))
    assert result is not None
    assert result.cp_white == 10000 - 3


def test_cloud_mate_black_to_move(tmp_path):
    client, _ = _client(tmp_path, lambda req: _hit(mate=-2, moves="e7e5"))
    result = client.lookup(chess.Board(AFTER_E4_FEN))
    assert result is not None
    # Black is mated in 2: terrible for black -> great for white.
    assert result.cp_white == 10000 - 2


def test_cloud_404_miss_memoized(tmp_path):
    client, calls = _client(tmp_path, lambda req: httpx.Response(404, json={}))
    assert client.lookup(chess.Board(START)) is None
    assert client.lookup(chess.Board(START)) is None
    assert calls["n"] == 1


def test_cloud_timeout_falls_back(tmp_path):
    def handler(req):
        raise httpx.TimeoutException("slow", request=req)

    client, _ = _client(tmp_path, handler)
    assert client.lookup(chess.Board(START)) is None


def test_cloud_malformed_payload_falls_back(tmp_path):
    client, _ = _client(tmp_path, lambda req: httpx.Response(200, json={"nonsense": True}))
    assert client.lookup(chess.Board(START)) is None


def test_cloud_illegal_best_move_falls_back(tmp_path):
    client, _ = _client(tmp_path, lambda req: _hit(cp=10, moves="e2e5"))
    assert client.lookup(chess.Board(START)) is None


def test_cloud_fen_normalization(tmp_path):
    # Same position, different halfmove/fullmove counters: one HTTP call.
    client, calls = _client(tmp_path, lambda req: _hit(cp=12))
    fen_a = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    fen_b = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 3 7"
    assert normalize_fen(fen_a) == normalize_fen(fen_b)
    assert client.lookup(chess.Board(fen_a)) is not None
    assert client.lookup(chess.Board(fen_b)) is not None
    assert calls["n"] == 1


def test_cloud_disk_cache_shared_across_clients(tmp_path):
    client1, calls1 = _client(tmp_path, lambda req: _hit(cp=45))
    assert client1.lookup(chess.Board(START)) is not None
    assert calls1["n"] == 1
    # Fresh client, same cache dir: disk hit, zero HTTP calls.
    client2, calls2 = _client(
        tmp_path, lambda req: (_ for _ in ()).throw(AssertionError("must not fetch"))
    )
    result = client2.lookup(chess.Board(START))
    assert result is not None
    assert result.cp_white == 45
    assert calls2["n"] == 0
