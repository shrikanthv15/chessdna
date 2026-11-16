"""Tests for classifier v3 (positional taggers + missed_tactic extensions).

Positive tests use constructed positions or real training-set FENs from
tests/fixtures/unclassified_rapid_v2.json (FENs after each move computed
by python-chess, never hand-written). Every new tagger has at least two
negative tests asserting it does NOT fire when the pattern is absent.
"""
import json
from pathlib import Path

import chess
import pytest

from app.analyzer.classifier import UNCLASSIFIED, classify_move, classify_record

FIXTURE = Path(__file__).parent / "fixtures" / "unclassified_rapid_v2.json"


def _after(fen: str, uci: str) -> str:
    board = chess.Board(fen)
    board.push_uci(uci)
    return board.fen()


def _classify(fen_before, user_uci, reply_uci=None, clock=None, move_time=None,
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
        opp_prev_uci=None,
        fen_before_opp_move=None,
        clock_seconds=clock,
        move_time_seconds=move_time,
        user_color=user_color,
        best_move_uci=best_uci,
        eval_before_cp=eval_before,
        eval_after_cp=eval_after,
    )


def _fixture_case(index: int):
    """1-based training-set case -> (record, user_color)."""
    cases = json.loads(FIXTURE.read_text())
    case = cases[index - 1]
    record = {
        "fen_before": case["fen_before"],
        "uci": case["uci"],
        "fen_after": case["fen_after"],
        "best_move_uci": case["best_uci"],
        "eval_before_cp": case["eval_before"],
        "eval_after_cp": case["eval_after"],
    }
    color = chess.WHITE if case["user_color"] == "white" else chess.BLACK
    return record, color


# ---------------------------------------------------------------------------
# missed_tactic (d): best move creates a concrete threat
# ---------------------------------------------------------------------------


def test_missed_tactic_new_threat_outpost():
    # Nd5 jumps to an outpost attacking the queen on e7 (defended only by
    # the king: Nxe7 wins material by force). Na4 misses it. The e2 pawn
    # blocks the queen's file so White is not in check.
    fen = "4k3/4q3/8/8/8/2N5/4P3/4K3 w - - 0 1"
    result = _classify(fen, "c3a4", best_uci="c3d5",
                       eval_before=100, eval_after=-100)
    assert "missed_tactic" in result.tags
    assert "queen" in result.explanations["missed_tactic"]
    assert "e7" in result.explanations["missed_tactic"]


def test_missed_tactic_new_threat_no_fire_on_quiet_best():
    # Same position, but the best move is a quiet king move: no new threat.
    fen = "4k3/4q3/8/8/8/2N5/4P3/4K3 w - - 0 1"
    result = _classify(fen, "c3a4", best_uci="e1d1",
                       eval_before=100, eval_after=-100)
    assert "missed_tactic" not in result.tags


def test_missed_tactic_new_threat_no_fire_when_played_creates_it():
    # The played move IS the threatening move: no "missed" threat exists.
    fen = "4k3/4q3/8/8/8/2N5/4P3/4K3 w - - 0 1"
    result = _classify(fen, "c3d5", best_uci="c3d5",
                       eval_before=100, eval_after=-100)
    assert "missed_tactic" not in result.tags


# ---------------------------------------------------------------------------
# missed_tactic (e): forcing capture sequence
# ---------------------------------------------------------------------------


def test_missed_tactic_forcing_capture_sequence():
    # Rxe5: bishop recaptures, Nxe5 wins the bishop back with interest
    # (the queen recapture loses the queen to Qxe5). Rh4 misses it.
    fen = "6k1/6b1/3q4/4p1B1/4R3/5N2/4Q3/4K3 w - - 0 1"
    result = _classify(fen, "e4h4", best_uci="e4e5",
                       eval_before=100, eval_after=-100)
    assert "missed_tactic" in result.tags
    assert "forcing capture" in result.explanations["missed_tactic"]


def test_missed_tactic_sequence_no_fire_when_sac_too_deep():
    # Bxe5 is a genuine sac (SEE -200: the pawn recaptures and no
    # follow-up capture wins anything), so no forcing-sequence tag. The
    # queen on d8 defends d6 so the new-threat clause stays silent too.
    fen = "3q4/8/3p4/4p3/8/2B5/8/4K2k w - - 0 1"
    result = _classify(fen, "c3b2", best_uci="c3e5",
                       eval_before=100, eval_after=-100)
    assert "missed_tactic" not in result.tags


def test_missed_tactic_sequence_no_fire_without_follow_up():
    # Rxe5, bishop recaptures, and no follow-up capture wins anything.
    fen = "6k1/6b1/8/4p1B1/4R3/8/8/4K3 w - - 0 1"
    result = _classify(fen, "e4h4", best_uci="e4e5",
                       eval_before=100, eval_after=-100)
    assert "missed_tactic" not in result.tags


# ---------------------------------------------------------------------------
# allowed_counterplay
# ---------------------------------------------------------------------------


def test_allowed_counterplay_real_case_9():
    # Qa2+ allows Rc2, attacking the undefended queen; Qd3+ prevents it.
    record, color = _fixture_case(9)
    result = classify_record(record, color)
    assert "allowed_counterplay" in result.tags
    assert "Rc2" in result.explanations["allowed_counterplay"]


def test_allowed_counterplay_no_fire_when_quiet():
    # Quiet developing position: no reply creates a material threat.
    start = chess.Board().fen()
    fen_before = _after(_after(start, "e2e4"), "e7e5")
    result = _classify(fen_before, "g1f3", best_uci="f1c4",
                       eval_before=20, eval_after=-180,
                       clock=300.0, move_time=20.0)
    assert "allowed_counterplay" not in result.tags


def test_allowed_counterplay_suppressed_when_best_allows_it_too():
    # Case #20: Nd6 creates a threat after a6 AND after Bb8, so the
    # played move did not "allow" anything the best move prevents.
    record, color = _fixture_case(20)
    result = classify_record(record, color)
    assert "allowed_counterplay" not in result.tags


def test_allowed_counterplay_names_immediate_mate():
    # Fool's mate: g4 allows Qh4#, mate in one. The explanation must
    # name the mating move itself, not an arbitrary quiet reply.
    fen_before = "rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2"
    result = _classify(fen_before, "g2g4", best_uci="b1c3",
                       eval_before=0, eval_after=-9999)
    assert "allowed_counterplay" in result.tags
    assert "Qh4#" in result.explanations["allowed_counterplay"]


def test_allowed_counterplay_no_fire_when_best_allows_mate_too():
    # Played == best: the mating reply exists after the best move as
    # well, so the played move is not uniquely at fault.
    fen_before = "rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2"
    result = _classify(fen_before, "g2g4", best_uci="g2g4",
                       eval_before=0, eval_after=-9999)
    assert "allowed_counterplay" not in result.tags


# ---------------------------------------------------------------------------
# passive_piece
# ---------------------------------------------------------------------------


def test_passive_piece_real_case_30():
    # Bh4 strands the bishop on the edge (5 squares -> 2); Be3 has 7.
    record, color = _fixture_case(30)
    result = classify_record(record, color)
    assert "passive_piece" in result.tags
    assert "5 squares to 2" in result.explanations["passive_piece"]


def test_passive_piece_no_fire_when_move_activates():
    # Nd5 INCREASES the knight's mobility: not passive.
    record, color = _fixture_case(2)
    record = dict(record, uci="c3d5", fen_after=_after(record["fen_before"], "c3d5"),
                  best_move_uci="e1c1")
    result = classify_record(record, color)
    assert "passive_piece" not in result.tags


def test_passive_piece_no_fire_when_best_retreats_too():
    # Both the played move (Ng1) and the best move (Nh2) retreat the
    # knight to a low-mobility square: no activity contrast, no tag.
    start = chess.Board().fen()
    fen_before = _after(_after(_after(start, "e2e4"), "e7e5"), "g1f3")
    fen_before = _after(fen_before, "b8c6")
    result = _classify(fen_before, "f3g1", best_uci="f3h2",
                       eval_before=20, eval_after=-180)
    assert "passive_piece" not in result.tags


# ---------------------------------------------------------------------------
# endgame_technique
# ---------------------------------------------------------------------------


def test_endgame_technique_check_supports_promotion_real_case_37():
    # Rg3+ gains the tempo to queen the h-pawn; Rd5 does not check.
    record, color = _fixture_case(37)
    result = classify_record(record, color)
    assert "endgame_technique" in result.tags
    assert "queen" in result.explanations["endgame_technique"]


def test_endgame_technique_king_activation_real_case_32():
    # Kd4 activates the king (5 squares -> 8); h5 ignores it.
    record, color = _fixture_case(32)
    result = classify_record(record, color)
    assert "endgame_technique" in result.tags
    assert "king" in result.explanations["endgame_technique"].lower()


def test_endgame_technique_no_fire_in_middlegame():
    # Same #37 position with the fullmove counter rewound to move 20: the
    # endgame gate (move > 30) blocks the tag.
    record, color = _fixture_case(37)
    fen = record["fen_before"]
    parts = fen.split(" ")
    parts[-1] = "20"
    fen20 = " ".join(parts)
    record = dict(record, fen_before=fen20,
                  fen_after=_after(fen20, record["uci"]))
    result = classify_record(record, color)
    assert "endgame_technique" not in result.tags


def test_endgame_technique_no_fire_when_played_checks_too():
    # The played move IS the checking best move: no technique missed.
    record, color = _fixture_case(37)
    record = dict(record, uci=record["best_move_uci"],
                  fen_after=_after(record["fen_before"], record["best_move_uci"]))
    result = classify_record(record, color)
    assert "endgame_technique" not in result.tags


# ---------------------------------------------------------------------------
# missed_development
# ---------------------------------------------------------------------------


def test_missed_development_real_case_21():
    # Be7 develops the last minor; Qc7 moves the queen instead.
    record, color = _fixture_case(21)
    result = classify_record(record, color)
    assert "missed_development" in result.tags


def test_missed_development_no_fire_when_played_develops():
    # The played move IS the developing move.
    record, color = _fixture_case(21)
    record = dict(record, uci=record["best_move_uci"],
                  fen_after=_after(record["fen_before"], record["best_move_uci"]))
    result = classify_record(record, color)
    assert "missed_development" not in result.tags


def test_missed_development_no_fire_late_in_game():
    # Same #21 position with the fullmove counter at 20: past the
    # opening-development window (move <= 12).
    record, color = _fixture_case(21)
    fen = record["fen_before"]
    parts = fen.split(" ")
    parts[-1] = "20"
    fen20 = " ".join(parts)
    record = dict(record, fen_before=fen20,
                  fen_after=_after(fen20, record["uci"]))
    result = classify_record(record, color)
    assert "missed_development" not in result.tags


# ---------------------------------------------------------------------------
# missed_retreat
# ---------------------------------------------------------------------------


def test_missed_retreat_real_case_20():
    # The d6 bishop is under fire from the b5 knight; Bb8 carries it to
    # safety, a6 leaves it there.
    record, color = _fixture_case(20)
    result = classify_record(record, color)
    assert "missed_retreat" in result.tags
    assert "d6" in result.explanations["missed_retreat"]


def test_missed_retreat_no_fire_when_piece_not_attacked():
    # Rb8 moves a rook that is not under attack: no retreat needed.
    record, color = _fixture_case(20)
    record = dict(record, best_move_uci="a8b8")
    result = classify_record(record, color)
    assert "missed_retreat" not in result.tags


def test_missed_retreat_no_fire_when_played_rescues():
    # The played move IS the retreat to safety.
    record, color = _fixture_case(20)
    record = dict(record, uci=record["best_move_uci"],
                  fen_after=_after(record["fen_before"], record["best_move_uci"]))
    result = classify_record(record, color)
    assert "missed_retreat" not in result.tags


# ---------------------------------------------------------------------------
# missed_exchange
# ---------------------------------------------------------------------------


def test_missed_exchange_real_case_17():
    # fxe4 removes the central pawn at no cost; h4 ignores the centre.
    record, color = _fixture_case(17)
    result = classify_record(record, color)
    assert "missed_exchange" in result.tags
    assert "e4" in result.explanations["missed_exchange"]


def test_missed_exchange_no_fire_off_centre():
    # Qxa2 wins a pawn, but a2 is not a central square: not an exchange.
    fen = "4k3/8/8/8/8/8/p7/3QK3 w - - 0 1"
    result = _classify(fen, "d1d2", best_uci="d1a2",
                       eval_before=100, eval_after=-100)
    assert "missed_exchange" not in result.tags


def test_missed_exchange_no_fire_when_played_takes_it():
    # The played move IS the central capture.
    record, color = _fixture_case(17)
    record = dict(record, uci=record["best_move_uci"],
                  fen_after=_after(record["fen_before"], record["best_move_uci"]))
    result = classify_record(record, color)
    assert "missed_exchange" not in result.tags


# ---------------------------------------------------------------------------
# missed_discovery
# ---------------------------------------------------------------------------


def test_missed_discovery_real_case_29():
    # dxc6 vacates d5, opening the c4 bishop's diagonal to f7.
    record, color = _fixture_case(29)
    result = classify_record(record, color)
    assert "missed_discovery" in result.tags
    assert "f7" in result.explanations["missed_discovery"]


def test_missed_discovery_no_fire_without_opened_line():
    # Be3 moves the bishop but opens no slider line onto anything.
    record, color = _fixture_case(29)
    record = dict(record, best_move_uci="g5e3")
    result = classify_record(record, color)
    assert "missed_discovery" not in result.tags


def test_missed_discovery_no_fire_when_played_opens_it():
    # The played move IS the line-opening move.
    record, color = _fixture_case(29)
    record = dict(record, uci=record["best_move_uci"],
                  fen_after=_after(record["fen_before"], record["best_move_uci"]))
    result = classify_record(record, color)
    assert "missed_discovery" not in result.tags


# ---------------------------------------------------------------------------
# weakened_defense
# ---------------------------------------------------------------------------


def test_weakened_defense_real_case_23():
    # e5 carries away a defender of the attacked d5 pawn (2 -> 1).
    record, color = _fixture_case(23)
    result = classify_record(record, color)
    assert "weakened_defense" in result.tags
    assert "d5" in result.explanations["weakened_defense"]


def test_weakened_defense_no_fire_when_defense_kept():
    # The played move IS the defense-keeping move.
    record, color = _fixture_case(23)
    record = dict(record, uci=record["best_move_uci"],
                  fen_after=_after(record["fen_before"], record["best_move_uci"]))
    result = classify_record(record, color)
    assert "weakened_defense" not in result.tags


def test_weakened_defense_no_fire_when_best_drops_it_too():
    # Best == played: the best move drops the defense as well, so the
    # played move is not uniquely at fault.
    record, color = _fixture_case(23)
    record = dict(record, best_move_uci=record["uci"])
    result = classify_record(record, color)
    assert "weakened_defense" not in result.tags


# ---------------------------------------------------------------------------
# fallback: played move == best move is search noise, not a mistake
# ---------------------------------------------------------------------------


def test_fallback_played_is_best_move_is_noise():
    # Case #5: played Nd5 IS the engine's best move. It stays unclassified
    # (no pattern), but the explanation must say it was the best move.
    record, color = _fixture_case(5)
    result = classify_record(record, color)
    assert result.primary == UNCLASSIFIED
    expl = result.explanations[UNCLASSIFIED]
    assert "engine's best move" in expl
    assert "search instability" in expl


# ---------------------------------------------------------------------------
# training-set regression: the 37 real unclassified rapid cases
# ---------------------------------------------------------------------------


def test_training_set_unclassified_rate():
    """Classifier v3 must name at least 30 of the 37 cases v2 could not.

    Baseline (v2): 37/37 unclassified. The 7 residuals are individually
    analyzed (engine noise, 3-4 ply tactics, quiet prophylaxis) and must
    stay unclassified rather than gain invented tags — so this asserts
    the measured ceiling, not zero.
    """
    cases = json.loads(FIXTURE.read_text())
    assert len(cases) == 37
    unclassified = 0
    seen_tags: set[str] = set()
    for case in cases:
        color = chess.WHITE if case["user_color"] == "white" else chess.BLACK
        record = {
            "fen_before": case["fen_before"],
            "uci": case["uci"],
            "fen_after": case["fen_after"],
            "best_move_uci": case["best_uci"],
            "eval_before_cp": case["eval_before"],
            "eval_after_cp": case["eval_after"],
        }
        result = classify_record(record, color)
        seen_tags.update(result.tags)
        if result.primary == UNCLASSIFIED:
            unclassified += 1
    assert unclassified <= 7, f"{unclassified}/37 unclassified (ceiling 7)"
    for tag in (
        "missed_development",
        "missed_exchange",
        "missed_discovery",
        "missed_retreat",
        "weakened_defense",
        "allowed_counterplay",
        "passive_piece",
        "endgame_technique",
    ):
        assert tag in seen_tags, f"new tag {tag} never fires on the training set"


def test_all_new_tags_have_priority_entries():
    from app.analyzer.classifier import TAG_PRIORITY

    for tag in (
        "missed_development",
        "missed_exchange",
        "missed_discovery",
        "missed_retreat",
        "weakened_defense",
        "allowed_counterplay",
        "passive_piece",
        "endgame_technique",
    ):
        assert tag in TAG_PRIORITY
        # Positional tags sit below missed_mate/missed_tactic, above
        # time_scramble_panic.
        assert TAG_PRIORITY.index(tag) > TAG_PRIORITY.index("missed_tactic")
        assert TAG_PRIORITY.index(tag) < TAG_PRIORITY.index("time_scramble_panic")
