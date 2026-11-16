"""Classifier evaluation harness over the 37-case rapid training set.

The fixture (tests/fixtures/unclassified_rapid_v2.json) holds real
blunder-level moves from Shrikanth's 25-game rapid run that classifier v2
left unclassified (37 of 81 flagged moves, 45.7%). This script runs
``classify_record`` over every case and reports the unclassified rate,
per-tag counts, and per-case tags.

Usage (from backend/):
    .venv/bin/python scripts/eval_classifier.py

Exit code 0 always; the numbers are the point, not a pass/fail gate.
The baseline (classifier v2) is 37/37 unclassified — every case in the
fixture was selected BECAUSE v2 could not name it.
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

import chess

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.analyzer.classifier import UNCLASSIFIED, classify_record  # noqa: E402

FIXTURE = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "unclassified_rapid_v2.json"


def case_to_record(case: dict) -> dict:
    """Map a fixture case to the engine-record shape classify_record takes.

    Fixture evals are user-perspective (cp_loss == eval_before - eval_after
    for every case, verified); the fixture carries no reply / previous-move
    context, so those fields are None — the same information a fresh
    sparring classification would have.
    """
    return {
        "fen_before": case["fen_before"],
        "uci": case["uci"],
        "fen_after": case["fen_after"],
        "reply_uci": None,
        "fen_after_reply": None,
        "opp_prev_uci": None,
        "fen_before_opp_move": None,
        "clock_seconds": case.get("clock"),
        "move_time_seconds": case.get("move_time"),
        "best_move_uci": case.get("best_uci"),
        "eval_before_cp": case["eval_before"],
        "eval_after_cp": case["eval_after"],
    }


def main() -> None:
    cases = json.loads(FIXTURE.read_text())
    tag_counts: Counter[str] = Counter()
    primary_counts: Counter[str] = Counter()
    unclassified = 0
    rows = []
    for idx, case in enumerate(cases, start=1):
        user_color = chess.WHITE if case["user_color"] == "white" else chess.BLACK
        result = classify_record(case_to_record(case), user_color)
        for tag in result.tags:
            tag_counts[tag] += 1
        primary_counts[result.primary] += 1
        if result.primary == UNCLASSIFIED:
            unclassified += 1
        rows.append(
            f"#{idx:2d} {case['game_date']} vs {case['opponent']:<18} "
            f"move {case['move_number']:>2} {case['san']:<7} "
            f"(best {case['best_san']:<7}) {case['cp_loss']:>3}cp "
            f"{case['phase']:<10} -> {', '.join(result.tags)}"
        )
    total = len(cases)
    print(f"cases: {total}")
    print(f"unclassified: {unclassified} ({100.0 * unclassified / total:.1f}%)")
    print()
    print("per-tag counts (a move can carry several tags):")
    for tag, count in tag_counts.most_common():
        print(f"  {tag:<38} {count}")
    print()
    print("primary counts:")
    for tag, count in primary_counts.most_common():
        print(f"  {tag:<38} {count}")
    print()
    print("per-case tags:")
    for row in rows:
        print("  " + row)


if __name__ == "__main__":
    main()
