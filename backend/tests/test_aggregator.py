"""Tests for the PlayerDNA aggregator using synthetic analyses."""
from app.analyzer.aggregator import build_player_dna


def _phase(move_number: int) -> str:
    if move_number <= 10:
        return "opening"
    if move_number <= 30:
        return "middlegame"
    return "endgame"


def _move(severity="ok", cp_loss=0, wp_drop=0.0, move_number=5, tags=None,
          primary="unclassified", eval_before=0, eval_after=0):
    return {
        "move_number": move_number,
        "ply": move_number * 2,
        "phase": _phase(move_number),
        "san": "Nf3",
        "uci": "g1f3",
        "eval_before_cp": eval_before,
        "eval_after_cp": eval_after,
        "cp_loss": cp_loss,
        "win_prob_drop": wp_drop,
        "best_move_san": "d4",
        "best_move_uci": "d2d4",
        "fen_before": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "clock_seconds": 120.0,
        "severity": severity,
        "tags": list(tags) if tags else [],
        "primary": primary,
        "explanations": {primary: "explanation"} if tags else {},
    }


def _analysis(color, result, eco, eco_name, moves, max_eval_cp=0):
    return {
        "game": {
            "url": f"https://example.com/{eco}-{result}",
            "user_color": color,
            "result": result,
            "opponent": "opponent",
            "eco": eco,
            "eco_name": eco_name,
            "time_class": "blitz",
        },
        "moves": moves,
        "max_eval_cp": max_eval_cp,
    }


def _dna(analyses, requested=25):
    return build_player_dna(
        username="tester",
        platform="chesscom",
        time_control="blitz",
        games_requested=requested,
        analyses=analyses,
    )


def test_phase_counts_and_accuracy():
    moves = [
        _move("blunder", cp_loss=200, wp_drop=20.0, move_number=5,
              tags=["abandoned_defender"], primary="abandoned_defender"),
        _move("blunder", cp_loss=180, wp_drop=18.0, move_number=15,
              tags=["time_scramble_panic"], primary="time_scramble_panic"),
        _move("blunder", cp_loss=300, wp_drop=30.0, move_number=35,
              tags=["unclassified"], primary="unclassified"),
        _move("mistake", cp_loss=90, move_number=12),
        _move("inaccuracy", cp_loss=50, move_number=8),
        _move("ok", cp_loss=5, move_number=3),
    ]
    dna = _dna([_analysis("white", "loss", "B12", "Caro-Kann", moves)])
    assert dna["phase_mistakes"] == {"opening": 1, "middlegame": 1, "endgame": 1}
    assert dna["accuracy"] == {
        "blunders": 3, "mistakes": 1, "inaccuracies": 1, "total_user_moves": 6,
    }


def test_win_rates_and_record():
    analyses = [
        _analysis("white", "win", "B12", "Caro-Kann", []),
        _analysis("white", "loss", "B12", "Caro-Kann", []),
        _analysis("black", "win", "C50", "Italian", []),
        _analysis("black", "draw", "C50", "Italian", []),
    ]
    dna = _dna(analyses)
    assert dna["record"]["white"] == {"wins": 1, "losses": 1, "draws": 0}
    assert dna["record"]["black"] == {"wins": 1, "losses": 0, "draws": 1}
    assert dna["win_rate"] == {"white": 50.0, "black": 50.0, "overall": 50.0}
    assert dna["games_analyzed"] == 4


def test_avg_centipawn_loss_capped_and_floored():
    moves = [
        _move("blunder", cp_loss=2000, move_number=5),
        _move("ok", cp_loss=-50, move_number=6),  # a gain counts as 0 loss
        _move("ok", cp_loss=100, move_number=7),
    ]
    dna = _dna([_analysis("white", "loss", "B12", "Caro-Kann", moves)])
    # (1000 + 0 + 100) / 3
    assert dna["avg_centipawn_loss"] == round(1100 / 3, 1)


def test_openings_grouped_min_games_worst_first():
    analyses = [
        _analysis("white", "loss", "B12", "Caro-Kann", []),
        _analysis("black", "loss", "B12", "Caro-Kann", []),
        _analysis("white", "win", "C50", "Italian Game", []),
        _analysis("white", "win", "C50", "Italian Game", []),
        _analysis("black", "loss", "C50", "Italian Game", []),
        _analysis("white", "win", "A00", "Polish Opening", []),  # 1 game: excluded
    ]
    dna = _dna(analyses)
    assert [o["eco"] for o in dna["openings"]] == ["B12", "C50"]
    assert dna["openings"][0]["score_pct"] == 0.0
    assert dna["openings"][1]["score_pct"] == round(200 / 3, 1)
    assert dna["openings"][0]["games"] == 2


def test_blind_spot_counts_and_percentages():
    moves = [
        _move("blunder", cp_loss=200, wp_drop=20.0, move_number=5,
              tags=["abandoned_defender"], primary="abandoned_defender"),
        _move("blunder", cp_loss=200, wp_drop=22.0, move_number=8,
              tags=["abandoned_defender", "time_scramble_panic"],
              primary="abandoned_defender"),
        _move("blunder", cp_loss=200, wp_drop=19.0, move_number=12,
              tags=["abandoned_defender"], primary="abandoned_defender"),
        _move("blunder", cp_loss=200, wp_drop=25.0, move_number=20,
              tags=["time_scramble_panic"], primary="time_scramble_panic"),
    ]
    dna = _dna([_analysis("white", "loss", "B12", "Caro-Kann", moves)])
    by_tag = {b["tag"]: b for b in dna["blind_spots"]}
    assert by_tag["abandoned_defender"]["count"] == 3
    assert by_tag["abandoned_defender"]["pct"] == 75.0
    assert by_tag["time_scramble_panic"]["count"] == 2
    assert by_tag["time_scramble_panic"]["pct"] == 50.0
    assert dna["top_blind_spot"] == "abandoned_defender"
    assert dna["blind_spots"][0]["explanation"]


def test_blunder_ranking_by_win_prob_drop():
    moves = [
        _move("blunder", cp_loss=160, wp_drop=10.0, move_number=5,
              tags=["unclassified"], primary="unclassified"),
        _move("blunder", cp_loss=400, wp_drop=30.0, move_number=8,
              tags=["unclassified"], primary="unclassified"),
        _move("blunder", cp_loss=250, wp_drop=20.0, move_number=12,
              tags=["unclassified"], primary="unclassified"),
    ]
    dna = _dna([_analysis("white", "loss", "B12", "Caro-Kann", moves)])
    assert [b["win_prob_drop"] for b in dna["blunders"]] == [30.0, 20.0, 10.0]
    assert len(dna["blunders"]) == 3


def test_conversion_stats_and_collapse_tag():
    collapse_blunder = _move(
        "blunder", cp_loss=500, wp_drop=45.0, move_number=25,
        tags=["unclassified"], primary="unclassified",
    )
    analyses = [
        _analysis("white", "loss", "B12", "Caro-Kann", [collapse_blunder],
                  max_eval_cp=350),
        _analysis("white", "win", "C50", "Italian", [], max_eval_cp=400),
        _analysis("black", "loss", "C50", "Italian", [], max_eval_cp=100),
    ]
    dna = _dna(analyses)
    assert dna["conversion"]["winning_positions"] == 2
    assert dna["conversion"]["wins"] == 1
    assert dna["conversion"]["losses"] == 1
    assert dna["conversion"]["draws"] == 0
    assert dna["conversion"]["conversion_rate"] == 50.0
    # The collapse game's worst blunder carries the conversion_collapse tag.
    assert len(dna["blunders"]) == 1
    assert "conversion_collapse" in dna["blunders"][0]["tags"]
    assert dna["blunders"][0]["tag"] == "conversion_collapse"
    by_tag = {b["tag"]: b for b in dna["blind_spots"]}
    assert by_tag["conversion_collapse"]["count"] == 1


def test_empty_analyses():
    dna = _dna([])
    assert dna["games_analyzed"] == 0
    assert dna["win_rate"] == {"white": 0.0, "black": 0.0, "overall": 0.0}
    assert dna["top_blind_spot"] == "none"
    assert dna["conversion"]["conversion_rate"] == 0.0
    assert dna["blunders"] == []
    assert dna["blind_spots"] == []
