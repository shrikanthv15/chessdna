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
MAX_BLUNDERS = 24
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
    "missed_mate": "Missed Mate",
    "missed_tactic": "Missed Tactic",
    "missed_defense": "Missed Defense",
    "left_piece_hanging": "Left Piece Hanging",
    "king_safety": "King Safety",
    "missed_development": "Missed Development",
    "missed_exchange": "Missed Exchange",
    "missed_discovery": "Missed Discovery",
    "missed_retreat": "Missed Retreat",
    "weakened_defense": "Weakened Defense",
    "allowed_counterplay": "Allowed Counterplay",
    "passive_piece": "Passive Piece",
    "endgame_technique": "Endgame Technique",
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
    "missed_mate": (
        "A forced checkmate was on the board and the move missed it. When "
        "you have a big advantage, check every checking move before "
        "settling — mates hide in forcing lines."
    ),
    "missed_tactic": (
        "The engine's best move won material or forked two pieces, and the "
        "move played missed it. Before settling on a quiet move, scan for "
        "captures, checks, and forks."
    ),
    "missed_defense": (
        "The opponent had an active threat — a piece they could profitably "
        "capture, or mate in one — and the move neither answered it nor "
        "created a bigger threat of your own. Always ask what the last "
        "move is threatening."
    ),
    "left_piece_hanging": (
        "The move left one of your own pieces attacked and undefended. "
        "Every move needs a final scan: what did I just leave en prise?"
    ),
    "king_safety": (
        "A pawn moved out of the shelter in front of the king, inviting a "
        "new attack on the king's vicinity. Pawns in front of your "
        "castled king don't move for free."
    ),
    "missed_development": (
        "In the opening, the best move developed a new piece while the "
        "move played didn't. Every opening move should develop a piece, "
        "control the centre, or get the king safe — moves that do none of "
        "these hand your opponent free tempi."
    ),
    "missed_exchange": (
        "The best move captured a central pawn or piece at no material "
        "cost, and the move played left it standing. Central captures "
        "that win material for free are rarely wrong — check the centre "
        "before playing a quiet move."
    ),
    "missed_discovery": (
        "The best move opened a line for a bishop, rook, or queen behind "
        "it, creating a discovered attack the move played missed. Before "
        "moving a piece, look at what lines it is currently blocking."
    ),
    "missed_retreat": (
        "A piece was under attack and the best move carried it to safety, "
        "but the move played left it under fire. When a piece is "
        "attacked, the first candidate is always the move that saves it."
    ),
    "weakened_defense": (
        "The move carried away a defender of an attacked piece, dropping "
        "its defense to a single piece while the best move kept the "
        "defense intact. Before moving a piece, check what it is "
        "defending."
    ),
    "allowed_counterplay": (
        "After the move played, the opponent had a reply that created a "
        "concrete threat or mate in one — a reply the best move "
        "prevented. Always ask what your opponent's best reply is before "
        "you commit."
    ),
    "passive_piece": (
        "The move sent a piece to a square with far fewer options while "
        "the best move kept it active. Pieces on the edge of the board "
        "do less work — keep them central and mobile."
    ),
    "endgame_technique": (
        "In the endgame, the best move used a concrete technique — "
        "checking to support a pawn about to queen, or activating the "
        "king — and the move played did neither. Endgames are won by "
        "king activity and passed pawns, not by waiting."
    ),
    "unclassified": (
        "Tactical oversights that didn't match a single recurring pattern."
    ),
}

# Practice-plan titles per blind-spot tag.
PRACTICE_TITLES = {
    "missed_mate": "Stop Missing Checkmate",
    "missed_tactic": "Spot the Tactics You're Missing",
    "missed_defense": "Answer Threats Before They Land",
    "abandoned_defender": "Check What Your Piece Defends",
    "missed_opponent_threat": "Read the Opponent's Last Move",
    "hope_chess_hanging_piece": "Attack Without Leaving Pieces Hanging",
    "left_piece_hanging": "Stop Leaving Pieces En Prise",
    "backward_or_long_range_blindness": "See the Whole Board",
    "king_safety": "Protect Your King",
    "missed_development": "Develop Every Opening Move",
    "missed_exchange": "Take the Free Central Captures",
    "missed_discovery": "Spot Discovered Attacks",
    "missed_retreat": "Save Attacked Pieces First",
    "weakened_defense": "Don't Weaken Your Own Defense",
    "allowed_counterplay": "Stop the Opponent's Best Reply",
    "passive_piece": "Keep Pieces Active",
    "endgame_technique": "Master Endgame Technique",
    "time_scramble_panic": "Fix Your Clock Management",
    "conversion_collapse": "Convert Winning Positions",
    "unclassified": "Sharpen General Calculation",
}

# Concrete drills per blind-spot tag, written for 400-1800 players.
# Each drill: title, detail (what to actually do), minutes_per_day.
PRACTICE_DRILLS: dict[str, list[dict[str, Any]]] = {
    "missed_mate": [
        {
            "title": "Mate-in-1 sprint",
            "detail": "Solve 20 mate-in-1 puzzles against the clock. For each position, list every checking move first, then ask if the king has an escape square.",
            "minutes_per_day": 10,
        },
        {
            "title": "Six mating patterns",
            "detail": "Drill back-rank, smothered, Anastasia's, Blackburne's, Boden's, and corridor mates until you spot each in under 5 seconds.",
            "minutes_per_day": 10,
        },
        {
            "title": "Check every check",
            "detail": "In every sharp position in your games, spend 10 seconds listing all your checking moves and whether any of them mate — before playing a quiet move.",
            "minutes_per_day": 5,
        },
    ],
    "missed_tactic": [
        {
            "title": "Forks first",
            "detail": "Solve 15 fork puzzles a day (knight forks especially). For each one, name both attacked pieces out loud before moving.",
            "minutes_per_day": 15,
        },
        {
            "title": "Hanging-piece scan",
            "detail": "After every opponent move in your games, list every enemy piece that is undefended. Do it out loud for 10 games until it's automatic.",
            "minutes_per_day": 10,
        },
        {
            "title": "Deflection and decoy",
            "detail": "Work through 10 puzzles where the key idea is deflection, decoy, or a discovered attack. Focus on the forcing move that makes the tactic work.",
            "minutes_per_day": 10,
        },
    ],
    "missed_defense": [
        {
            "title": "What did they just threaten?",
            "detail": "After every opponent move, pause and say the threat out loud — checks, captures, and mate threats — before touching a piece. Do this for every game this week.",
            "minutes_per_day": 5,
        },
        {
            "title": "Defensive puzzles",
            "detail": "Solve 'find the only defense' puzzles: positions where exactly one move saves material. If you find a second move that works, the puzzle is too easy.",
            "minutes_per_day": 10,
        },
        {
            "title": "Blunder-check ritual",
            "detail": "Before every move: checks, captures, attacks on your pieces. Write the three words on a sticky note until the scan is automatic.",
            "minutes_per_day": 5,
        },
    ],
    "abandoned_defender": [
        {
            "title": "What does this piece defend?",
            "detail": "Before moving any piece, name everything it currently defends. Drill with 10 positions: find the overloaded defender and the tactic that exploits it.",
            "minutes_per_day": 10,
        },
        {
            "title": "Deflection puzzles",
            "detail": "Solve puzzles where the key idea is luring a defender away — then flip the board and find the defense against the same idea.",
            "minutes_per_day": 10,
        },
    ],
    "missed_opponent_threat": [
        {
            "title": "Last-move threat drill",
            "detail": "Replay 5 of your losses. At each opponent move, write down the threat before looking at the reply you played.",
            "minutes_per_day": 15,
        },
        {
            "title": "Opponent's plan first",
            "detail": "In puzzles, spend the first 30 seconds finding the opponent's idea, not yours. Most missed threats are missed because you never looked for them.",
            "minutes_per_day": 10,
        },
    ],
    "hope_chess_hanging_piece": [
        {
            "title": "Safety scan before strikes",
            "detail": "Before any check or capture, scan all of your own pieces for undefended ones. Drill: 10 positions, find the refutation of the tempting attack.",
            "minutes_per_day": 10,
        },
        {
            "title": "Quiet moves win",
            "detail": "Play 5 rapid games where you ban checks and captures for the first 10 moves unless they win material cleanly. Learn what quiet, safe moves feel like.",
            "minutes_per_day": 15,
        },
    ],
    "left_piece_hanging": [
        {
            "title": "En prise radar",
            "detail": "After choosing a candidate move, ask: what did I just leave hanging? Drill with 15 positions: spot the piece left en prise after each candidate.",
            "minutes_per_day": 10,
        },
        {
            "title": "Two-move safety",
            "detail": "Calculate one full move deeper on every candidate: your move, their reply, your recapture. If anything hangs at the end of the line, pick another move.",
            "minutes_per_day": 10,
        },
    ],
    "backward_or_long_range_blindness": [
        {
            "title": "Edge-to-edge scan",
            "detail": "Before moving, trace every open diagonal and file to the edge of the board. Drill: 10 positions, find the far-away attacker you would have missed.",
            "minutes_per_day": 10,
        },
        {
            "title": "Quiet move puzzles",
            "detail": "Solve puzzles whose key move is a retreat or a far-away piece move. Train yourself to consider moves that don't touch the action.",
            "minutes_per_day": 10,
        },
    ],
    "king_safety": [
        {
            "title": "Shelter discipline",
            "detail": "Rule: never push a pawn in front of your castled king without calculating the opponent's new attacks. Review 5 of your games and flag every shelter push.",
            "minutes_per_day": 10,
        },
        {
            "title": "Attack the king",
            "detail": "Study 10 classic king-side attacks (Greek gift, h-file storms, bishop sacrifices on h7). You defend better when you recognize the patterns coming at you.",
            "minutes_per_day": 10,
        },
    ],
    "time_scramble_panic": [
        {
            "title": "Play with increment",
            "detail": "Switch your blitz games to 3+2 or 5+3 for two weeks. The increment removes pure flagging panic and forces real decisions instead of pre-moves.",
            "minutes_per_day": 20,
        },
        {
            "title": "30-second mate-in-2",
            "detail": "Solve mate-in-2 puzzles with a 30-second timer to train fast, accurate calculation under pressure.",
            "minutes_per_day": 10,
        },
        {
            "title": "Bank time in the opening",
            "detail": "Play your first 10 moves from preparation and principles in under 2 minutes total, saving a real time buffer for the middlegame complications.",
            "minutes_per_day": 5,
        },
    ],
    "conversion_collapse": [
        {
            "title": "Trade when ahead",
            "detail": "Rule: when up a piece or +3, trade pieces (not pawns) at every safe chance. Play 5 games applying only this rule and watch the wins pile up.",
            "minutes_per_day": 15,
        },
        {
            "title": "Winning endgames",
            "detail": "Drill rook-and-pawn vs rook and queen vs rook technique until conversion is automatic, not improvised.",
            "minutes_per_day": 15,
        },
        {
            "title": "Simplify, don't complicate",
            "detail": "Review your lost winning positions. For each, find the one simplifying move that kept the win — usually a trade you declined.",
            "minutes_per_day": 10,
        },
    ],
    "unclassified": [
        {
            "title": "Calculation ladder",
            "detail": "Solve 10 puzzles a day, calculating each line to the end before moving a piece. No guessing, no hoping — see it through.",
            "minutes_per_day": 15,
        },
        {
            "title": "Whole-board scan",
            "detail": "Before every move, spend 5 seconds scanning all four corners for checks, captures, and threats you haven't noticed yet.",
            "minutes_per_day": 5,
        },
    ],
    "missed_development": [
        {
            "title": "Development race",
            "detail": "Play 5 rapid games where your only goal is all four minor pieces out and castled by move 10. Count how many opening moves develop something.",
            "minutes_per_day": 15,
        },
        {
            "title": "One-move rule",
            "detail": "Never move the same piece twice before move 10 unless it wins material or stops mate. Review your last 5 games and flag every repeat move.",
            "minutes_per_day": 10,
        },
        {
            "title": "Centre first",
            "detail": "Solve 10 opening positions: for each, name the developing move before checking the engine. Prefer moves that develop AND control e4, d4, e5, or d5.",
            "minutes_per_day": 10,
        },
    ],
    "missed_exchange": [
        {
            "title": "Centre captures scan",
            "detail": "After every opponent move, ask: can I capture anything on d4, e4, d5, or e5 for free? Do it out loud for 10 games until it is automatic.",
            "minutes_per_day": 10,
        },
        {
            "title": "Trade evaluation",
            "detail": "Work through 10 positions where a central trade is possible. For each, count attackers and defenders on the square before deciding.",
            "minutes_per_day": 10,
        },
        {
            "title": "Pawn tension timing",
            "detail": "Study 5 master games in your openings and note every central pawn tension and when it was resolved. Imitate the timing in your own games.",
            "minutes_per_day": 10,
        },
    ],
    "missed_discovery": [
        {
            "title": "Line-opening puzzles",
            "detail": "Solve 15 discovered-attack puzzles. For each, name the piece that moves and the slider behind it before playing the move.",
            "minutes_per_day": 15,
        },
        {
            "title": "What's behind it?",
            "detail": "In your games, before moving any piece, ask what line it is blocking and what it would uncover. Do it for 10 games.",
            "minutes_per_day": 10,
        },
        {
            "title": "Battery building",
            "detail": "Practice placing a bishop or queen behind a knight or pawn, then playing the uncovering move. Set up 10 positions against the engine.",
            "minutes_per_day": 10,
        },
    ],
    "missed_retreat": [
        {
            "title": "Attacked-piece check",
            "detail": "After every opponent move, list your attacked pieces. If one is attacked, find the safest square first, then consider everything else.",
            "minutes_per_day": 10,
        },
        {
            "title": "Retreat squares",
            "detail": "Solve 10 puzzles where the only good move saves an attacked piece. Name the attacker and the safe square out loud.",
            "minutes_per_day": 10,
        },
        {
            "title": "Safe-square scan",
            "detail": "In 5 of your recent losses, find every move where you left an attacked piece standing. Replay the game with the retreat played instead.",
            "minutes_per_day": 10,
        },
    ],
    "weakened_defense": [
        {
            "title": "Defender audit",
            "detail": "Before every move, name what your piece currently defends. If it is the only defender of an attacked piece, don't move it without a replacement.",
            "minutes_per_day": 10,
        },
        {
            "title": "Deflection puzzles",
            "detail": "Solve 10 puzzles where the key idea is luring or removing a defender. Focus on spotting which piece holds the position together.",
            "minutes_per_day": 10,
        },
        {
            "title": "Two defenders rule",
            "detail": "In your games, aim for every attacked piece to have two defenders. Review your last 5 games and count the single-defender moments.",
            "minutes_per_day": 10,
        },
    ],
    "allowed_counterplay": [
        {
            "title": "Opponent's best reply",
            "detail": "Before playing any move in a sharp position, spend 15 seconds finding your opponent's best reply. If it creates a threat, find a move that stops it.",
            "minutes_per_day": 15,
        },
        {
            "title": "Candidate plus reply",
            "detail": "For 10 positions from your games, write down your candidate move AND the opponent's best reply before checking with the engine.",
            "minutes_per_day": 10,
        },
        {
            "title": "Prophylaxis study",
            "detail": "Study 3 annotated master games focusing on prophylactic moves — moves that stop the opponent's idea before it starts.",
            "minutes_per_day": 10,
        },
    ],
    "passive_piece": [
        {
            "title": "Activity count",
            "detail": "After every move in your games, count how many squares your moved piece controls. Aim for 6+ for minor pieces in the middlegame.",
            "minutes_per_day": 10,
        },
        {
            "title": "Edge-piece audit",
            "detail": "Review your last 5 games and flag every piece that ended on the a- or h-file or the first two ranks. Find the active alternative.",
            "minutes_per_day": 10,
        },
        {
            "title": "Centralization drills",
            "detail": "Solve 10 puzzles where the key is centralizing a knight or bishop. Name the outpost square before moving.",
            "minutes_per_day": 10,
        },
    ],
    "endgame_technique": [
        {
            "title": "King activation",
            "detail": "Play 10 king-and-pawn endgames against the engine. Your only goal: centralize the king before pushing pawns.",
            "minutes_per_day": 15,
        },
        {
            "title": "Passed-pawn push",
            "detail": "Drill rook endgames with a passed pawn: learn when to push, when to check, and when to bring the king. 15 minutes a day.",
            "minutes_per_day": 15,
        },
        {
            "title": "Cut-off practice",
            "detail": "Set up 5 positions where the king must cut off the enemy king. Practice until the cut-off squares are automatic.",
            "minutes_per_day": 10,
        },
    ],
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
                # Game identity + full-game context (v2, additive).
                "game_id": game.get("game_id", ""),
                "game_date": game.get("game_date"),
                "time_control": game.get("time_class", ""),
                "result": game.get("result", ""),
                "eco": game.get("eco", ""),
                "eco_name": game.get("eco_name", "Unknown Opening"),
                "moves_san": game.get("moves_san", []),
                "moves_uci": game.get("moves_uci", []),
                "eval_series": game.get("eval_series", []),
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

    # Loss breakdown: where did the lost games actually break? The
    # decisive swing of a lost game is its biggest blunder (max cp_loss;
    # ties go to the earliest — moves are in game order and max() keeps
    # the first maximal element). Lost games with no blunder-level move
    # have no decisive swing and are counted separately.
    by_phase_counts: Counter[str] = Counter()
    by_cause_counts: Counter[str] = Counter()
    time_trouble_losses = 0
    losses_without_blunder = 0
    eco_loss: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"games": 0, "losses": 0, "names": Counter()}
    )
    for analysis in analyses:
        game = analysis["game"]
        eco = game["eco"] or "???"
        slot = eco_loss[eco]
        slot["games"] += 1
        slot["names"][game["eco_name"] or "Unknown Opening"] += 1
        if game["result"] != "loss":
            continue
        slot["losses"] += 1
        game_blunders = [m for m in analysis["moves"] if m["severity"] == "blunder"]
        if not game_blunders:
            losses_without_blunder += 1
            continue
        decisive = max(game_blunders, key=lambda m: m["cp_loss"])
        by_phase_counts[decisive["phase"]] += 1
        by_cause_counts[decisive.get("primary", "unclassified")] += 1
        if "time_scramble_panic" in decisive.get("tags", []):
            time_trouble_losses += 1
    by_eco_loss = [
        {
            "eco": eco,
            "eco_name": slot["names"].most_common(1)[0][0],
            "played": slot["games"],
            "lost": slot["losses"],
            "loss_rate": round(100.0 * slot["losses"] / slot["games"], 1),
        }
        for eco, slot in eco_loss.items()
        if slot["losses"] > 0
    ]
    by_eco_loss.sort(key=lambda e: (-e["lost"], -e["played"]))
    loss_breakdown = {
        "by_phase": {
            "opening": by_phase_counts.get("opening", 0),
            "middlegame": by_phase_counts.get("middlegame", 0),
            "endgame": by_phase_counts.get("endgame", 0),
        },
        "by_cause": dict(by_cause_counts),
        "by_eco": by_eco_loss,
        "time_trouble_losses": time_trouble_losses,
        # Same winning-position definition as ``conversion`` above:
        # max_eval_cp >= +300 (user perspective) and the game was not won.
        "conversion_collapses": conv["losses"] + conv["draws"],
        "losses_without_blunder": losses_without_blunder,
    }

    for move in all_moves:
        move.pop("_game", None)

    practice_plan = _build_practice_plan(flagged, blind_spots, conv)

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
        "loss_breakdown": loss_breakdown,
        "top_blind_spot": top_blind_spot,
        "practice_plan": practice_plan,
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
    }


def _plan_why(
    tag: str,
    entry: dict[str, Any],
    moves: list[dict[str, Any]],
    flagged_total: int,
    conversion: dict[str, Any],
) -> str:
    """1-2 sentences tying the plan entry to the player's own numbers."""
    label = BLIND_SPOT_LABELS.get(tag, tag).lower()
    base = (
        f"{entry['count']} of your {flagged_total} blunders "
        f"({entry['pct']}%) were {label}."
    )
    if tag == "time_scramble_panic":
        low = sum(1 for m in moves if (m.get("clock_seconds") or 999) < 25)
        if low:
            return (
                f"{base} {low} of them came with under 25 seconds left on "
                f"the clock."
            )
    if tag == "conversion_collapse" and conversion.get("winning_positions"):
        return (
            f"{base} You reached a winning position in "
            f"{conversion['winning_positions']} games but converted only "
            f"{conversion['conversion_rate']}% of them."
        )
    if tag == "missed_mate":
        return f"{base} Each one was a forced mate you had on the board and missed."
    if moves:
        worst_phase = Counter(m["phase"] for m in moves).most_common(1)[0][0]
        return f"{base} Most of them happened in the {worst_phase}."
    return base


def _build_practice_plan(
    flagged: list[dict[str, Any]],
    blind_spots: list[dict[str, Any]],
    conversion: dict[str, Any],
) -> list[dict[str, Any]]:
    """Top-3 practice plan: one entry per worst blind-spot tag.

    Ordered by severity (blunder count, ties broken by tag priority).
    ``unclassified`` is excluded unless it is genuinely the top tag —
    i.e. it outnumbers every real pattern (or is the only pattern).
    """
    if not flagged:
        return []
    counts = {b["tag"]: b for b in blind_spots}
    real = [b for b in blind_spots if b["tag"] != "unclassified"]
    real.sort(
        key=lambda b: (
            -b["count"],
            TAG_PRIORITY.index(b["tag"]) if b["tag"] in TAG_PRIORITY else 99,
        )
    )
    unc = counts.get("unclassified")
    include_unc = unc is not None and (
        not real or unc["count"] > real[0]["count"]
    )
    picks = ([unc] + real[:2]) if include_unc else real[:3]

    plan: list[dict[str, Any]] = []
    for entry in picks:
        tag = entry["tag"]
        moves = [m for m in flagged if tag in m.get("tags", [])]
        moves.sort(key=lambda m: m["win_prob_drop"], reverse=True)
        plan.append(
            {
                "tag": tag,
                "title": PRACTICE_TITLES.get(
                    tag, BLIND_SPOT_LABELS.get(tag, tag)
                ),
                "why": _plan_why(tag, entry, moves, len(flagged), conversion),
                "drills": PRACTICE_DRILLS.get(tag, PRACTICE_DRILLS["unclassified"]),
                "positions": [m["fen_before"] for m in moves[:4]],
            }
        )
    return plan
