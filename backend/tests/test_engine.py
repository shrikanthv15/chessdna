"""Tests for engine game context, eval series, and cloud integration."""
import chess
import httpx
import pytest

from app.analyzer.engine import (
    EngineAnalyzer,
    build_eval_series,
    ensure_game_context,
)
from app.config import settings
from app.services.cloud_eval import CloudEvalClient

FOOLS_MATE_PGN = (
    '[White "Alice"]\n[Black "Bob"]\n[Date "2025.03.04"]\n'
    '[UTCDate "2025.03.04"]\n[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1\n'
)


def _game(**overrides):
    game = {
        "pgn": FOOLS_MATE_PGN,
        "url": "https://example.com/game/1",
        "user_color": "white",
        "result": "loss",
        "opponent": "Bob",
        "eco": "",
        "eco_name": "Unknown Opening",
        "time_class": "blitz",
        "date": "2025-03-04",
        "clocks": [],
    }
    game.update(overrides)
    return game


def _record(ply, eval_before, eval_after):
    return {"ply": ply, "eval_before_cp": eval_before, "eval_after_cp": eval_after}


# ---------------------------------------------------------------------------
# eval series assembly (pure, no engine)
# ---------------------------------------------------------------------------


def test_eval_series_white_user():
    records = [_record(0, 10, 25), _record(2, 30, -50)]
    series = build_eval_series(records, chess.WHITE, 4)
    assert series == [
        {"ply": 0, "cp": 10},   # start position: first eval-before
        {"ply": 1, "cp": 25},   # after ply 0: user's eval-after
        {"ply": 2, "cp": 30},   # after ply 1: next user eval-before
        {"ply": 3, "cp": -50},  # after ply 2: user's eval-after
        {"ply": 4, "cp": -50},  # trailing opponent ply: carried forward
    ]


def test_eval_series_black_user_negated():
    records = [_record(1, 10, 25), _record(3, 30, -50)]
    series = build_eval_series(records, chess.BLACK, 4)
    assert series == [
        {"ply": 0, "cp": 0},    # start position: no computed eval
        {"ply": 1, "cp": -10},  # after ply 0: first eval-before, negated
        {"ply": 2, "cp": -25},
        {"ply": 3, "cp": -30},
        {"ply": 4, "cp": 50},
    ]


def test_eval_series_empty_records_is_zeros():
    assert build_eval_series([], chess.WHITE, 3) == [
        {"ply": 0, "cp": 0},
        {"ply": 1, "cp": 0},
        {"ply": 2, "cp": 0},
        {"ply": 3, "cp": 0},
    ]


# ---------------------------------------------------------------------------
# game context backfill (no engine)
# ---------------------------------------------------------------------------


def test_ensure_game_context_backfills_from_pgn():
    analysis = {
        "game": {"url": "x", "user_color": "white", "result": "loss"},
        "moves": [_record(0, 10, 25), _record(2, 30, -50)],
        "max_eval_cp": 25,
    }
    ensure_game_context(analysis, _game())
    meta = analysis["game"]
    assert meta["game_id"]
    assert meta["game_date"] == "2025-03-04"
    assert meta["moves_san"] == ["f3", "e5", "g4", "Qh4#"]
    assert meta["moves_uci"] == ["f2f3", "e7e5", "g2g4", "d8h4"]
    assert [e["cp"] for e in meta["eval_series"]] == [10, 25, 30, -50, -50]
    # Idempotent: a second call changes nothing.
    snapshot = dict(meta)
    ensure_game_context(analysis, _game())
    assert meta == snapshot


def test_ensure_game_context_game_id_is_stable():
    a1 = {"game": {}, "moves": [], "max_eval_cp": 0}
    a2 = {"game": {}, "moves": [], "max_eval_cp": 0}
    ensure_game_context(a1, _game())
    ensure_game_context(a2, _game())
    assert a1["game"]["game_id"] == a2["game"]["game_id"]
    # Different PGN text -> different id (hash of the PGN string).
    a3 = {"game": {}, "moves": [], "max_eval_cp": 0}
    ensure_game_context(a3, _game(pgn=FOOLS_MATE_PGN + " "))
    assert a1["game"]["game_id"] != a3["game"]["game_id"]


# ---------------------------------------------------------------------------
# live engine (Stockfish binary required)
# ---------------------------------------------------------------------------


@pytest.fixture()
def stockfish_path():
    if not settings.STOCKFISH_PATH:
        pytest.skip("no Stockfish binary resolved")
    return settings.STOCKFISH_PATH


def test_analyze_game_local_records_and_context(stockfish_path):
    with EngineAnalyzer(stockfish_path, depth=8, cloud_enabled=False) as analyzer:
        analysis = analyzer.analyze_game(_game())
    assert len(analysis["moves"]) == 2  # two white moves
    for record in analysis["moves"]:
        assert record["eval_source"] == "local"
    meta = analysis["game"]
    assert meta["game_date"] == "2025-03-04"
    assert meta["moves_san"] == ["f3", "e5", "g4", "Qh4#"]
    assert len(meta["eval_series"]) == 5
    assert [e["ply"] for e in meta["eval_series"]] == [0, 1, 2, 3, 4]
    # g4 allows mate: the position after ply 2 (series index 3) must be
    # deeply negative for white.
    assert meta["eval_series"][3]["cp"] <= -9000


def test_analyze_game_cloud_client_used(tmp_path, stockfish_path):
    def handler(request: httpx.Request) -> httpx.Response:
        board = chess.Board(request.url.params["fen"])
        first = next(iter(board.legal_moves)).uci()
        return httpx.Response(
            200, json={"depth": 25, "pvs": [{"cp": 20, "moves": first}]}
        )

    client = CloudEvalClient(
        cache_dir=tmp_path / "cloud", transport=httpx.MockTransport(handler)
    )
    with EngineAnalyzer(
        stockfish_path, depth=8, cloud_client=client, cloud_enabled=True
    ) as analyzer:
        analysis = analyzer.analyze_game(_game())
    assert analysis["moves"]
    assert all(r["eval_source"] == "cloud" for r in analysis["moves"])
    assert all(r["best_move_uci"] for r in analysis["moves"])


def test_analyze_game_cloud_failure_falls_back_to_local(tmp_path, stockfish_path):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={})

    client = CloudEvalClient(
        cache_dir=tmp_path / "cloud", transport=httpx.MockTransport(handler)
    )
    with EngineAnalyzer(
        stockfish_path, depth=8, cloud_client=client, cloud_enabled=True
    ) as analyzer:
        analysis = analyzer.analyze_game(_game())
    assert analysis["moves"]
    assert all(r["eval_source"] == "local" for r in analysis["moves"])


def test_analyze_game_cloud_only_within_max_ply(tmp_path, stockfish_path):
    """Cloud eval is consulted only for positions within
    CLOUD_EVAL_MAX_PLY half-moves; later positions go straight local."""
    movetext = (
        "1. a3 a6 2. b3 b6 3. c3 c6 4. d3 d6 5. e3 e6 6. f3 f6 "
        "7. g3 g6 8. h3 h6 9. a4 a5 10. b4 b5 11. c4 c5 12. d4 d5 "
        "13. e4 e5 14. f4 f5 15. g4 g5 16. h4 h5 17. Ra2 Ra7 "
        "18. Rb2 Rb7 19. Rc2 Rc7 20. Rd2 Rd7 *"
    )
    pgn = (
        '[White "Alice"]\n[Black "Bob"]\n[Date "2025.03.04"]\n'
        f'[Result "*"]\n\n{movetext}\n'
    )
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        board = chess.Board(request.url.params["fen"])
        first = next(iter(board.legal_moves)).uci()
        return httpx.Response(
            200, json={"depth": 25, "pvs": [{"cp": 20, "moves": first}]}
        )

    client = CloudEvalClient(
        cache_dir=tmp_path / "cloud", transport=httpx.MockTransport(handler)
    )
    with EngineAnalyzer(
        stockfish_path, depth=8, cloud_client=client, cloud_enabled=True
    ) as analyzer:
        analysis = analyzer.analyze_game(_game(pgn=pgn))

    cap = settings.CLOUD_EVAL_MAX_PLY
    records = analysis["moves"]
    assert len(records) == 20  # 20 white moves in a 40-ply game
    early = [r for r in records if r["ply"] <= cap]
    late = [r for r in records if r["ply"] > cap]
    assert early and late  # the fixture must straddle the cap
    assert all(r["eval_source"] == "cloud" for r in early)
    assert all(r["eval_source"] == "local" for r in late)
    # One cloud request per evaluated position within the cap: user-move
    # eval-befores at even plies and eval-afters at odd plies.
    expected_calls = len([p for p in range(0, 40, 2) if p <= cap]) + len(
        [p for p in range(1, 40, 2) if p <= cap]
    )
    assert calls["n"] == expected_calls


# ---------------------------------------------------------------------------
# pass 2: deep re-analysis of blunder positions (v3)
# ---------------------------------------------------------------------------

DEEP_KEYS = ("deep_best_move", "deep_eval", "pv_san")


def test_deep_pass_only_blunders_get_deep_fields(stockfish_path):
    # Fool's mate: f3 is a mistake (137cp), g4 is the blunder (mate).
    with EngineAnalyzer(stockfish_path, depth=8, cloud_enabled=False) as analyzer:
        analysis = analyzer.analyze_game(_game())
    by_san = {r["san"]: r for r in analysis["moves"]}
    assert by_san["f3"]["severity"] == "mistake"
    for key in DEEP_KEYS:
        assert key not in by_san["f3"]
    assert by_san["g4"]["severity"] == "blunder"
    for key in DEEP_KEYS:
        assert key in by_san["g4"]


def test_deep_pass_fields_are_consistent(stockfish_path):
    with EngineAnalyzer(stockfish_path, depth=8, cloud_enabled=False) as analyzer:
        analysis = analyzer.analyze_game(_game())
    blunder = next(r for r in analysis["moves"] if r["severity"] == "blunder")
    board = chess.Board(blunder["fen_before"])
    deep_move = chess.Move.from_uci(blunder["deep_best_move"])
    assert deep_move in board.legal_moves
    assert isinstance(blunder["deep_eval"], int)
    pv_san = blunder["pv_san"]
    assert 1 <= len(pv_san) <= 6
    assert pv_san[0] == board.san(deep_move)
    # The whole PV must replay legally from the position.
    probe = board.copy()
    for san in pv_san:
        probe.push_san(san)


def test_deep_pass_skips_without_engine(stockfish_path):
    analyzer = EngineAnalyzer(stockfish_path, depth=8, cloud_enabled=False)
    board = chess.Board()
    assert analyzer._deep_analyze(board) == (None, None, [])
    record = {
        "severity": "blunder",
        "fen_before": board.fen(),
        "eval_before_cp": 0,
    }
    analyzer._deep_pass([record], chess.WHITE)
    for key in DEEP_KEYS:
        assert key not in record


def test_deep_pass_leaves_pass1_fields_untouched(stockfish_path):
    with EngineAnalyzer(stockfish_path, depth=8, cloud_enabled=False) as analyzer:
        analysis = analyzer.analyze_game(_game())
        records = analysis["moves"]
        before = [
            {k: v for k, v in r.items() if k not in DEEP_KEYS} for r in records
        ]
        # Re-running pass 2 on the same records must not touch pass-1 data.
        analyzer._deep_pass(records, chess.WHITE)
    after = [{k: v for k, v in r.items() if k not in DEEP_KEYS} for r in records]
    assert after == before
