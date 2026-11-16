"""Player DNA aggregator.

Turns per-game engine analyses (with blind-spot tags attached) into the
PlayerDNA JSON summary the dashboard renders. See the API contract in
``app/main.py`` / README for the exact shape.

Conventions:
* rates and percentages are 0..100 floats, rounded to 1 decimal;
* ``blind_spots`` counts *every* tag on a flagged move, so percentages can
  sum to more than 100% — a move can fail in more than one way;
* ``phase_mistakes`` counts blunder-level moves by game phase;
* ``conversion_collapse`` is attached here (game-level): the worst blunder
  of a game the user was winning (+300cp) but failed to win.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any

from .classifier import TAG_PRIORITY

WINNING_EVAL_CP = 300
MAX_BLUNDERS = 8
MAX_OPENINGS = 8
MIN_OPENING_GAMES = 2
CPL_CAP = 1000

BLIND_SPOT_LABELS = {
    "abandoned_defender": "Abandoned Defender",
    "backward_or_long_range_blindness": "Backward / Long-Range Blindness",
    "missed_opponent_threat": "Missed Opponent Threat",
    "hope_chess_hanging_piece": "Hope Chess — Hanging Piece",
    "time_scramble_panic": "Time Scramble Panic",
    "conversion_collapse": "Conversion Collapse",
    "unclassified": "Unclassified",
}

BLIND_SPOT_EXPLANATIONS = {
    "abandoned_defender": (
        "You moved a piece that was the only defender of another piece or "
        "square, and the opponent immediately captured what you left behind. "
        "Before moving a piece, check what it is currently defending."
    ),
    "backward_or_long_range_blindness": (
        "The punishment came from a quiet backward retreat or a bishop, "
        "rook, or queen striking from four or more squares away. You are "
        "tracking the action in front of you but missing far-away pieces."
    ),
    "missed_opponent_threat": (
        "Your opponent created a direct threat on their last move — an "
        "attacked, undefended piece or mate in one — and you played an "
        "unrelated move instead of answering it. Always ask what the last "
        "move is threatening before you reply."
    ),
    "hope_chess_hanging_piece": (
        "You played an aggressive move or a check while one of your own "
        "pieces was left completely undefended. Attacking moves still need "
        "a safety check on your own pieces."
    ),
    "time_scramble_panic": (
        "These blunders happened with under 25 seconds on the clock, or "
        "were played in under 2 seconds in a critical position. The fix is "
        "clock management: keep a time buffer for the complicated moments."
    ),
    "conversion_collapse": (
        "You reached a winning position (+3.0 or better) and still lost or "
        "drew the game. Winning positions need simplification and "
        "technique, not more complications."
    ),
    "unclassified": (
        "Tactical oversights that didn't match a single recurring pattern."
    ),
}


def _attach_conversion_collapse(analyses: list[dict[str, Any]]) -> None:
    """Mutate analyses in place: for every game the user was winning but
    failed to win, tag that game's worst blunder with conversion_collapse."""
    for analysis in analyses:
        game = analysis["game"]
        if analysis["max_eval_cp"] < WINNING_EVAL_CP:
            continue
        if game["result"] == "win":
            continue
        blunders = [m for m in analysis["moves"] if m["severity"] == "blunder"]
        if not blunders:
            continue
        worst = max(blunders, key=lambda m: m["win_prob_drop"])
        tags = worst.setdefault("tags", [])
        if "conversion_collapse" not in tags:
            tags.append("conversion_collapse")
            worst.setdefault("explanations", {})["conversion_collapse"] = (
                f"You were winning this game (+{analysis['max_eval_cp'] / 100:.1f}) "
                f"and let it slip to a {game['result']}."
            )
            # Recompute primary by priority (conversion_collapse is lowest).
            ordered = [t for t in TAG_PRIORITY if t in tags]
            worst["primary"] = ordered[0] if ordered else worst.get("primary", "unclassified")


def build_player_dna(
    username: str,
    platform: str,
    time_control: str,
    games_requested: int,
    analyses: list[dict[str, Any]],
) -> dict[str, Any]:
    """Build the PlayerDNA summary from per-game analyses.

    Each analysis is ``{"game": {...}, "moves": [...], "max_eval_cp": int}``
    where moves already carry ``severity``, ``tags``, ``primary`` and
    ``explanations`` (classifier output merged into the engine records).
    """
    _attach_conversion_collapse(analyses)

    record: dict[str, dict[str, int]] = {
        "white": {"wins": 0, "losses": 0, "draws": 0},
        "black": {"wins": 0, "losses": 0, "draws": 0},
    }
    all_moves: list[dict[str, Any]] = []
    flagged: list[dict[str, Any]] = []
    for analysis in analyses:
        game = analysis["game"]
        color = game["user_color"]
        key = {"win": "wins", "loss": "losses", "draw": "draws"}[game["result"]]
        record[color][key] += 1
        for move in analysis["moves"]:
            move["_game"] = game
            all_moves.append(move)
            if move["severity"] == "blunder":
                flagged.append(move)

    def win_rate(color: str) -> float:
        r = record[color]
        total = r["wins"] + r["losses"] + r["draws"]
        return round(100.0 * r["wins"] / total, 1) if total else 0.0

    total_games = len(analyses)
    total_wins = record["white"]["wins"] + record["black"]["wins"]

    # Average centipawn loss: only losses count, capped per move.
    if all_moves:
        losses = [min(max(m["cp_loss"], 0), CPL_CAP) for m in all_moves]
        avg_cpl = round(sum(losses) / len(losses), 1)
    else:
        avg_cpl = 0.0

    severity_counts = Counter(m["severity"] for m in all_moves)
    phase_mistakes = {"opening": 0, "middlegame": 0, "endgame": 0}
    for move in flagged:
        phase_mistakes[move["phase"]] += 1

    # Openings: group by ECO, min games, worst score first.
    by_eco: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"games": 0, "wins": 0, "losses": 0, "draws": 0, "names": Counter()}
    )
    for analysis in analyses:
        game = analysis["game"]
        eco = game["eco"] or "???"
        slot = by_eco[eco]
        slot["games"] += 1
        slot[{"win": "wins", "loss": "losses", "draw": "draws"}[game["result"]]] += 1
        slot["names"][game["eco_name"]] += 1
    openings = []
    for eco, slot in by_eco.items():
        if slot["games"] < MIN_OPENING_GAMES:
            continue
        score = (slot["wins"] + 0.5 * slot["draws"]) / slot["games"] * 100
        openings.append(
            {
                "eco": eco,
                "name": slot["names"].most_common(1)[0][0],
                "games": slot["games"],
                "wins": slot["wins"],
                "losses": slot["losses"],
                "draws": slot["draws"],
                "score_pct": round(score, 1),
            }
        )
    openings.sort(key=lambda o: (o["score_pct"], -o["games"]))
    openings = openings[:MAX_OPENINGS]

    # Blind spots: count every tag on flagged moves.
    tag_counts: Counter[str] = Counter()
    for move in flagged:
        for tag in move.get("tags", []):
            tag_counts[tag] += 1
    flagged_total = len(flagged) or 1
    blind_spots = [
        {
            "tag": tag,
            "label": BLIND_SPOT_LABELS.get(tag, tag),
            "count": count,
            "pct": round(100.0 * count / flagged_total, 1),
            "explanation": BLIND_SPOT_EXPLANATIONS.get(tag, ""),
        }
        for tag, count in tag_counts.most_common()
    ]
    # Top leak = highest-count REAL pattern. "unclassified" stays in the
    # breakdown bars for honesty, but must never be the headline leak.
    real_spots = [b for b in blind_spots if b["tag"] != "unclassified"]
    top_blind_spot = real_spots[0]["tag"] if real_spots else "none"

    # Top blunders by win-probability drop.
    ranked = sorted(flagged, key=lambda m: m["win_prob_drop"], reverse=True)[:MAX_BLUNDERS]
    blunders = []
    for move in ranked:
        game = move["_game"]
        explanations = move.get("explanations", {})
        primary = move.get("primary", "unclassified")
        blunders.append(
            {
                "fen": move["fen_before"],
                "move_played": move["san"],
                "move_played_uci": move["uci"],
                "best_move": move["best_move_san"] or "",
                "best_move_uci": move["best_move_uci"] or "",
                "eval_before_cp": move["eval_before_cp"],
                "eval_after_cp": move["eval_after_cp"],
                "win_prob_drop": move["win_prob_drop"],
                "tag": primary,
                "tags": move.get("tags", []),
                "explanation": explanations.get(primary, ""),
                "game_url": game["url"],
                "move_number": move["move_number"],
                "phase": move["phase"],
                "clock_seconds": move.get("clock_seconds"),
                "player_color": game["user_color"],
                "opponent": game["opponent"],
            }
        )

    # Conversion: games reaching a winning eval, and how they ended.
    winning = [a for a in analyses if a["max_eval_cp"] >= WINNING_EVAL_CP]
    conv = {"winning_positions": len(winning), "wins": 0, "draws": 0, "losses": 0}
    for analysis in winning:
        conv[{"win": "wins", "loss": "losses", "draw": "draws"}[analysis["game"]["result"]]] += 1
    conv["conversion_rate"] = (
        round(100.0 * conv["wins"] / conv["winning_positions"], 1)
        if conv["winning_positions"]
        else 0.0
    )

    for move in all_moves:
        move.pop("_game", None)

    return {
        "username": username,
        "platform": platform,
        "time_control": time_control,
        "games_analyzed": total_games,
        "games_requested": games_requested,
        "record": record,
        "win_rate": {
            "white": win_rate("white"),
            "black": win_rate("black"),
            "overall": round(100.0 * total_wins / total_games, 1) if total_games else 0.0,
        },
        "avg_centipawn_loss": avg_cpl,
        "accuracy": {
            "blunders": severity_counts.get("blunder", 0),
            "mistakes": severity_counts.get("mistake", 0),
            "inaccuracies": severity_counts.get("inaccuracy", 0),
            "total_user_moves": len(all_moves),
        },
        "phase_mistakes": phase_mistakes,
        "openings": openings,
        "blind_spots": blind_spots,
        "blunders": blunders,
        "conversion": conv,
        "top_blind_spot": top_blind_spot,
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
    }
