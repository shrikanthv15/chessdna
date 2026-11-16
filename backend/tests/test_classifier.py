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
              user_color=chess.WHITE, best_uci=None, eval_before=None,
              eval_after=None):
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
        best_move_uci=best_uci,
        eval_before_cp=eval_before,
        eval_after_cp=eval_after,
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


# ---------------------------------------------------------------------------
# v2: static exchange evaluation
# ---------------------------------------------------------------------------

from app.analyzer.classifier import _see, _losing_pieces, classify_record  # noqa: E402


def test_see_hanging_piece():
    board = chess.Board("4k3/8/8/3p4/8/8/8/3QK3 w - - 0 1")
    assert _see(board, chess.Move.from_uci("d1d5")) == 100


def test_see_defended_capture_loses_queen():
    # Qxd5, pawn on e6 recaptures: queen for pawn.
    board = chess.Board("4k3/8/4p3/3p4/8/8/8/3QK3 w - - 0 1")
    assert _see(board, chess.Move.from_uci("d1d5")) == -800


def test_see_pawn_takes_defended_queen():
    board = chess.Board("4k3/8/4p3/3q4/4P3/8/8/4K3 w - - 0 1")
    assert _see(board, chess.Move.from_uci("e4d5")) == 800


def test_see_non_capture_is_zero():
    board = chess.Board()
    assert _see(board, chess.Move.from_uci("g1f3")) == 0


def test_losing_pieces_ignores_pinned_attacker():
    # Black bishop c4 is pinned to king c8 by rook c1; it attacks b3 but
    # cannot legally take. The pawn must NOT count as losing.
    board = chess.Board("2k5/8/8/8/2b5/1P6/8/2R1K3 w - - 0 1")
    assert chess.B3 not in _losing_pieces(board, chess.WHITE)


def test_losing_pieces_finds_unpinned_threat():
    board = chess.Board("4k3/8/8/r7/8/8/P7/4K3 w - - 0 1")
    losing = _losing_pieces(board, chess.WHITE)
    assert chess.A2 in losing
    assert losing[chess.A2][1] == 100


# ---------------------------------------------------------------------------
# v2: missed_tactic
# ---------------------------------------------------------------------------


def test_missed_tactic_winning_capture():
    # Black knight on d5 hangs; best is Qxd5. Qa4 misses it.
    fen = "4k3/8/8/3n4/8/8/8/3QK3 w - - 0 1"
    result = _classify(
        fen, "d1a4", best_uci="d1d5", eval_before=300, eval_after=0,
    )
    assert "missed_tactic" in result.tags
    assert result.primary == "missed_tactic"
    expl = result.explanations["missed_tactic"]
    assert "knight" in expl and "d5" in expl


def test_missed_tactic_no_fire_on_quiet_best():
    # Same position, but the "best" move is itself quiet: no tactic exists.
    fen = "4k3/8/8/3n4/8/8/8/3QK3 w - - 0 1"
    result = _classify(
        fen, "d1a4", best_uci="d1a4", eval_before=300, eval_after=0,
    )
    assert "missed_tactic" not in result.tags


def test_missed_tactic_fork():
    # Knight on d5 can fork queen a4 and rook c8 with Nb6.
    fen = "2r1k3/8/8/3N4/q7/8/8/4K3 w - - 0 1"
    result = _classify(
        fen, "d5e3", best_uci="d5b6", eval_before=200, eval_after=-100,
    )
    assert "missed_tactic" in result.tags
    assert "fork" in result.explanations["missed_tactic"]


def test_missed_tactic_beats_time_scramble_priority():
    fen = "4k3/8/8/3n4/8/8/8/3QK3 w - - 0 1"
    result = _classify(
        fen, "d1a4", best_uci="d1d5", eval_before=300, eval_after=0, clock=10.0,
    )
    assert "missed_tactic" in result.tags
    assert "time_scramble_panic" in result.tags
    assert result.primary == "missed_tactic"


# ---------------------------------------------------------------------------
# v2: missed_mate
# ---------------------------------------------------------------------------


def test_missed_mate_in_one():
    # Qf7 + Kg6 vs Kh8: Qf8 is checkmate. Qe6 misses it.
    fen = "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1"
    result = _classify(
        fen, "f7e6", best_uci="f7f8", eval_before=9999, eval_after=500,
    )
    assert "missed_mate" in result.tags
    assert result.primary == "missed_mate"
    assert "mate" in result.explanations["missed_mate"].lower()


def test_missed_mate_no_fire_without_mate_eval():
    fen = "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1"
    result = _classify(
        fen, "f7e6", best_uci="f7f8", eval_before=300, eval_after=100,
    )
    assert "missed_mate" not in result.tags


def test_missed_mate_no_fire_when_mate_played():
    fen = "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1"
    result = _classify(
        fen, "f7f8", best_uci="f7f8", eval_before=9999, eval_after=9999,
    )
    assert "missed_mate" not in result.tags


# ---------------------------------------------------------------------------
# v2: left_piece_hanging
# ---------------------------------------------------------------------------


def test_left_piece_hanging_without_reply():
    # Nc3-d5 walks into the e6 pawn's attack; no reply needed for this tag.
    fen = "4k3/8/4p3/8/8/2N5/8/4K3 w - - 0 1"
    result = _classify(fen, "c3d5")
    assert "left_piece_hanging" in result.tags
    assert "abandoned_defender" not in result.tags  # needs the reply
    expl = result.explanations["left_piece_hanging"]
    assert "knight" in expl and "d5" in expl


def test_left_piece_hanging_no_fire_when_attacker_captured():
    fen = "4k3/8/8/3p4/4B3/2N5/8/4K3 w - - 0 1"
    result = _classify(fen, "c3d5")
    assert "left_piece_hanging" not in result.tags


# ---------------------------------------------------------------------------
# v2: missed_defense
# ---------------------------------------------------------------------------


def test_missed_defense_unpunished_threat():
    # ...Qa5 attacks a2; Ke2 ignores it; the reply is a quiet king move.
    # missed_opponent_threat must NOT fire (no collecting reply), but the
    # broader missed_defense must.
    fen_before_opp = "3qk3/8/8/8/8/8/P7/4K3 b - - 0 1"
    fen_before = _after(fen_before_opp, "d8a5")
    result = _classify(
        fen_before, "e1e2", reply_uci="e8d7",
        opp_prev_uci="d8a5", fen_before_opp=fen_before_opp,
    )
    assert "missed_defense" in result.tags
    assert "missed_opponent_threat" not in result.tags
    expl = result.explanations["missed_defense"]
    assert "pawn" in expl and "a2" in expl


def test_missed_defense_no_fire_when_piece_moved():
    # King on g1 so ...Qa5 is not check and a2-a4 is legal.
    fen_before_opp = "3qk3/8/8/8/8/8/P7/6K1 b - - 0 1"
    fen_before = _after(fen_before_opp, "d8a5")
    result = _classify(
        fen_before, "a2a4", reply_uci="e8d7",
        opp_prev_uci="d8a5", fen_before_opp=fen_before_opp,
    )
    assert "missed_defense" not in result.tags


# ---------------------------------------------------------------------------
# v2: king_safety
# ---------------------------------------------------------------------------


def test_king_safety_shelter_pawn_opens_diagonal():
    # Bishop e4 eyes h1 through the g2 pawn; g3 opens the diagonal.
    fen = "4k3/8/8/8/4b3/8/5PPP/6K1 w - - 0 1"
    result = _classify(fen, "g2g3")
    assert "king_safety" in result.tags
    assert result.primary == "king_safety"


def test_king_safety_no_fire_without_new_attack():
    # f3 also leaves the shelter, but opens no new attack on the king.
    fen = "4k3/8/8/8/4b3/8/5PPP/6K1 w - - 0 1"
    result = _classify(fen, "f2f3")
    assert "king_safety" not in result.tags


def test_king_safety_no_fire_for_king_move():
    fen = "4k3/8/8/8/4b3/8/5PPP/6K1 w - - 0 1"
    result = _classify(fen, "g1h1")
    assert "king_safety" not in result.tags


# ---------------------------------------------------------------------------
# v2: fallback explainer + regression with best-move info
# ---------------------------------------------------------------------------


def test_fallback_explains_with_numbers_and_best_move():
    # 1.e4 e5 2.Nf3, best Bc4: a quiet developing move with a quiet best
    # move. No pattern fires, but the explanation must name the best move
    # and the eval swing — never generic filler. (The old Ke2 version of
    # this test now fires missed_development, correctly: Ke2 in the
    # opening instead of developing IS the pattern.)
    start = chess.Board().fen()
    fen_before = _after(_after(start, "e2e4"), "e7e5")
    result = _classify(
        fen_before, "g1f3", opp_prev_uci="e7e5",
        fen_before_opp=_after(start, "e2e4"),
        clock=300.0, move_time=20.0,
        best_uci="f1c4", eval_before=20, eval_after=-180,
    )
    assert result.primary == "unclassified"
    expl = result.explanations["unclassified"]
    assert "Bc4" in expl
    assert "200cp" in expl
    assert "no single pattern matched" not in expl


def test_old_tagger_regression_with_best_move_info():
    # Abandoned defender still wins primary when best-move info is present.
    fen = "4k3/8/8/3p4/4B3/2N5/8/4K3 w - - 0 1"
    fen_after = _after(fen, "c3a4")
    record = {
        "fen_before": fen,
        "uci": "c3a4",
        "fen_after": fen_after,
        "reply_uci": "d5e4",
        "fen_after_reply": _after(fen_after, "d5e4"),
        "opp_prev_uci": None,
        "fen_before_opp_move": None,
        "clock_seconds": 300.0,
        "move_time_seconds": 20.0,
        "best_move_uci": "c3e2",
        "eval_before_cp": 100,
        "eval_after_cp": -200,
    }
    result = classify_record(record, chess.WHITE)
    assert "abandoned_defender" in result.tags
    assert result.primary == "abandoned_defender"
