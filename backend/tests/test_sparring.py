"""Tests for POST /api/position (sparring endpoint) and the sparring
service. Live-engine tests use depth 8 to stay fast; cloud-tier tests
use a mocked transport (no network).
"""
import chess
import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.services.cloud_eval import CloudEvalClient
from app.services.sparring import analyze_position, ply_of

START_FEN = chess.Board().fen()
FOOLS_SETUP_FEN = "rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2"


def _fools_mate_fen() -> str:
    # Derived from the moves, never hand-written (hand-written FENs lie).
    board = chess.Board()
    for uci in ("f2f3", "e7e5", "g2g4", "d8h4"):
        board.push_uci(uci)
    assert board.is_checkmate()
    return board.fen()


FOOLS_MATE_FEN = _fools_mate_fen()

client = TestClient(app)


@pytest.fixture()
def stockfish_path():
    if not settings.STOCKFISH_PATH:
        pytest.skip("no Stockfish binary resolved")
    return settings.STOCKFISH_PATH


# ---------------------------------------------------------------------------
# route: happy paths (live Stockfish, depth 8)
# ---------------------------------------------------------------------------


def test_position_start_no_move():
    resp = client.post("/api/position", json={"fen": START_FEN, "depth": 8})
    assert resp.status_code == 200
    body = resp.json()
    assert body["fen"] == START_FEN
    assert body["turn"] == "w"
    assert isinstance(body["eval_cp_white"], int)
    assert body["best_move_uci"] is not None
    assert chess.Move.from_uci(body["best_move_uci"]) in chess.Board().legal_moves
    assert body["best_move_san"] is not None
    assert 1 <= len(body["pv_san"]) <= 6
    assert body["eval_source"] in ("cloud", "local")
    assert body["played"] is None


def test_position_blunder_move_classified():
    # g4 in the fool's-mate setup allows Qh4#: huge loss, and the
    # classifier must name the mating reply.
    resp = client.post(
        "/api/position",
        json={"fen": FOOLS_SETUP_FEN, "move_uci": "g2g4", "depth": 8},
    )
    assert resp.status_code == 200
    played = resp.json()["played"]
    assert played is not None
    assert played["move_uci"] == "g2g4"
    assert played["move_san"] == "g4"
    assert played["eval_after_cp_white"] <= -9000
    assert played["cp_loss_user"] >= 9000
    assert played["win_prob_drop"] > 40
    assert "allowed_counterplay" in played["tags"]
    assert "Qh4#" in played["explanations"]["allowed_counterplay"]


def test_position_good_move_small_loss():
    # Nf3 in the start position is a top engine move: near-zero loss.
    resp = client.post(
        "/api/position",
        json={"fen": START_FEN, "move_uci": "g1f3", "depth": 8},
    )
    assert resp.status_code == 200
    played = resp.json()["played"]
    assert played is not None
    assert played["cp_loss_user"] < 60
    assert played["tags"] == ["unclassified"] or played["primary"]


def test_position_checkmate_terminal():
    resp = client.post("/api/position", json={"fen": FOOLS_MATE_FEN, "depth": 8})
    assert resp.status_code == 200
    body = resp.json()
    assert body["eval_cp_white"] == -10000  # White to move is mated
    assert body["best_move_uci"] is None
    assert body["best_move_san"] is None
    assert body["pv_san"] == []
    assert body["played"] is None


def test_position_black_to_move_turn():
    board = chess.Board()
    board.push_uci("e2e4")
    resp = client.post("/api/position", json={"fen": board.fen(), "depth": 8})
    assert resp.status_code == 200
    assert resp.json()["turn"] == "b"


def test_position_default_depth_is_16():
    # No depth given: the request still succeeds (default 16, capped 3s).
    resp = client.post("/api/position", json={"fen": START_FEN})
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# route: validation -> 400 / 422
# ---------------------------------------------------------------------------


def test_position_invalid_fen_400():
    resp = client.post("/api/position", json={"fen": "not a fen", "depth": 8})
    assert resp.status_code == 400


def test_position_illegal_position_400():
    # Kings missing: parses as a board but is not a legal position.
    resp = client.post(
        "/api/position",
        json={"fen": "8/8/8/8/8/8/8/8 w - - 0 1", "depth": 8},
    )
    assert resp.status_code == 400


def test_position_illegal_move_400():
    resp = client.post(
        "/api/position", json={"fen": START_FEN, "move_uci": "e2e5", "depth": 8}
    )
    assert resp.status_code == 400


def test_position_malformed_move_400():
    resp = client.post(
        "/api/position", json={"fen": START_FEN, "move_uci": "zzz", "depth": 8}
    )
    assert resp.status_code == 400


def test_position_move_in_checkmate_400():
    resp = client.post(
        "/api/position",
        json={"fen": FOOLS_MATE_FEN, "move_uci": "e1e2", "depth": 8},
    )
    assert resp.status_code == 400


def test_position_depth_above_max_rejected():
    resp = client.post("/api/position", json={"fen": START_FEN, "depth": 21})
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# service: cloud tier + ply gate (mocked transport, no network)
# ---------------------------------------------------------------------------


def _mock_cloud_client(tmp_path, cp=25, moves="e2e4"):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"depth": 30, "pvs": [{"cp": cp, "moves": moves}]}
        )

    return CloudEvalClient(
        cache_dir=tmp_path / "cloud", transport=httpx.MockTransport(handler)
    )


def test_analyze_position_cloud_hit(tmp_path, stockfish_path):
    cloud = _mock_cloud_client(tmp_path, cp=25, moves="e2e4")
    result = analyze_position(START_FEN, None, 8, stockfish_path, cloud_client=cloud)
    assert result["eval_source"] == "cloud"
    assert result["eval_cp_white"] == 25
    assert result["best_move_uci"] == "e2e4"
    assert result["best_move_san"] == "e4"
    # Cloud has no PV: the best move alone, never an invented line.
    assert result["pv_san"] == ["e4"]


def test_analyze_position_cloud_miss_falls_back_to_local(tmp_path, stockfish_path):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={})

    cloud = CloudEvalClient(
        cache_dir=tmp_path / "cloud", transport=httpx.MockTransport(handler)
    )
    result = analyze_position(START_FEN, None, 8, stockfish_path, cloud_client=cloud)
    assert result["eval_source"] == "local"
    assert result["best_move_uci"] is not None
    assert len(result["pv_san"]) >= 1


def test_analyze_position_cloud_gate_by_ply(tmp_path, stockfish_path):
    # A late position (move 40) must NOT consult the cloud even when the
    # mock would answer: the ply gate keeps deep positions local.
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("cloud must not be consulted past ply 24")

    cloud = CloudEvalClient(
        cache_dir=tmp_path / "cloud", transport=httpx.MockTransport(handler)
    )
    fen = "8/8/4k3/8/8/4K3/4P3/8 w - - 0 40"
    result = analyze_position(fen, None, 8, stockfish_path, cloud_client=cloud)
    assert result["eval_source"] == "local"


def test_ply_of():
    assert ply_of(chess.Board()) == 0
    board = chess.Board()
    board.push_uci("e2e4")
    assert ply_of(board) == 1
    board.push_uci("e7e5")
    assert ply_of(board) == 2
    assert ply_of(chess.Board("8/8/4k3/8/8/4K3/4P3/8 w - - 0 40")) == 78
    assert ply_of(chess.Board("8/8/4k3/8/8/4K3/4P3/8 b - - 0 40")) == 79
