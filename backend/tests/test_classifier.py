"""Tests for the human blind-spot classifier.

Each test builds a concrete position with python-chess, applies the user
move and the opponent's reply, and asserts the expected tag fires. FENs
after each move are computed by python-chess, never hand-written.
"""
import chess

from app.analyzer.classifier import classify_move


def _after(fen: str, uci: str) -> str:
    board = chess.Board(fen)
    board.push_uci(uci)
    return board.fen()


def _classify(fen_before, user_uci, reply_uci=None, opp_prev_uci=None,
              fen_before_opp=None, clock=None, move_time=None,
              user_color=chess.WHITE):
    fen_after = _after(fen_before, user_uci)
    fen_after_reply = _after(fen_after, reply_uci) if reply_uci else None
    return classify_move(
        fen_before=fen_before,
        user_move_uci=user_uci,
        fen_after=fen_after,
        reply_uci=reply_uci,
        fen_after_reply=fen_after_reply,
        opp_prev_uci=opp_prev_uci,
        fen_before_opp_move=fen_before_opp,
        clock_seconds=clock,
        move_time_seconds=move_time,
        user_color=user_color,
    )


def test_abandoned_defender():
    # White Nc3 is the SOLE defender of Be4 (black pawn d5 attacks it).
    # Nc3-a4 abandons the bishop; ...dxe4 collects it.
    fen = "4k3/8/8/3p4/4B3/2N5/8/4K3 w - - 0 1"
    result = _classify(fen, "c3a4", reply_uci="d5e4")
    assert "abandoned_defender" in result.tags
    assert result.primary == "abandoned_defender"
    assert "defender" in result.explanations["abandoned_defender"]


def test_abandoned_defender_no_fire_when_piece_still_defended():
    # Same shape, but the knight captures the attacker instead of leaving:
    # Nxd5 removes the pawn, so nothing is abandoned.
    fen = "4k3/8/8/3p4/4B3/2N5/8/4K3 w - - 0 1"
    result = _classify(fen, "c3d5", reply_uci="e8d7")
    assert "abandoned_defender" not in result.tags


def test_missed_opponent_threat():
    # Black's ...Qd8-a5 newly attacks the undefended a2 pawn. White plays
    # an unrelated king move; ...Qxa2 collects the pawn.
    fen_before_opp = "3qk3/8/8/8/8/8/P7/4K3 b - - 0 1"
    fen_before = _after(fen_before_opp, "d8a5")
    result = _classify(
        fen_before, "e1e2", reply_uci="a5a2",
        opp_prev_uci="d8a5", fen_before_opp=fen_before_opp,
    )
    assert "missed_opponent_threat" in result.tags


def test_missed_opponent_threat_no_fire_when_answered():
    # Same threat (king on g1 so ...Qa5 is not check), but White answers
    # it by moving the threatened pawn itself: a2-a4. The reply still
    # captures the pawn, but on a new square — the original threat was
    # addressed, so the tag must not fire.
    fen_before_opp = "3qk3/8/8/8/8/8/P7/6K1 b - - 0 1"
    fen_before = _after(fen_before_opp, "d8a5")
    result = _classify(
        fen_before, "a2a4", reply_uci="a5a4",
        opp_prev_uci="d8a5", fen_before_opp=fen_before_opp,
    )
    assert "missed_opponent_threat" not in result.tags


def test_hope_chess_hanging_piece():
    # White captures on h5 with the queen while the queen itself is left
    # hanging to the g6 pawn — an aggressive capture, own piece undefended.
    fen = "4k3/5p2/6p1/7p/8/8/8/3QK3 w - - 0 1"
    result = _classify(fen, "d1h5")
    assert "hope_chess_hanging_piece" in result.tags
    assert result.primary == "hope_chess_hanging_piece"


def test_time_scramble_panic_low_clock():
    fen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2"
    result = _classify(fen, "g1f3", clock=12.0)
    assert "time_scramble_panic" in result.tags
    assert result.primary == "time_scramble_panic"


def test_time_scramble_panic_fast_move():
    fen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2"
    result = _classify(fen, "g1f3", clock=300.0, move_time=1.5)
    assert "time_scramble_panic" in result.tags


def test_time_scramble_no_fire_with_healthy_clock():
    fen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2"
    result = _classify(fen, "g1f3", clock=300.0, move_time=15.0)
    assert "time_scramble_panic" not in result.tags


def test_backward_or_long_range_blindness_snipe():
    # Black bishop on c8 snipes 5 squares to h3, capturing the pawn.
    # The threat pre-existed Black's king move, so missed_opponent_threat
    # must NOT fire — this isolates the long-range tag.
    fen_before_opp = "2b1k3/8/8/8/8/7P/8/3Q1K2 b - - 0 1"
    fen_before = _after(fen_before_opp, "e8f8")
    result = _classify(
        fen_before, "d1a4", reply_uci="c8h3",
        opp_prev_uci="e8f8", fen_before_opp=fen_before_opp,
    )
    assert "backward_or_long_range_blindness" in result.tags
    assert "missed_opponent_threat" not in result.tags


def test_backward_or_long_range_blindness_retreat():
    # Black knight retreats e6-d8, uncovering the rook on e8: discovered
    # check on the white king. A backward move doing the damage.
    fen = "4r1k1/8/4n3/8/8/8/8/3QK3 w - - 0 1"
    result = _classify(fen, "d1a4", reply_uci="e6d8")
    assert "backward_or_long_range_blindness" in result.tags


def test_multiple_tags_priority_order():
    # Abandoned defender + time scramble: both fire, abandoned_defender
    # wins primary by the priority order.
    fen = "4k3/8/8/3p4/4B3/2N5/8/4K3 w - - 0 1"
    result = _classify(fen, "c3a4", reply_uci="d5e4", clock=10.0)
    assert "abandoned_defender" in result.tags
    assert "time_scramble_panic" in result.tags
    assert result.primary == "abandoned_defender"


def test_sound_move_unclassified():
    # 1.e4 e5 2.Nf3: a sound developing move. No tag may fire.
    start = chess.Board().fen()
    fen_before = _after(_after(start, "e2e4"), "e7e5")
    result = _classify(
        fen_before, "g1f3", opp_prev_uci="e7e5",
        fen_before_opp=_after(start, "e2e4"),
        clock=300.0, move_time=20.0,
    )
    assert result.tags == ["unclassified"]
    assert result.primary == "unclassified"
