"""Measure Lichess cloud-eval hit rate by ply band on real games.

Fetches 5 recent blitz games for chess.com user hikaru, walks every ply,
and probes cloud_eval.lookup with a FRESH cache dir so every unique
position goes to HTTP (no stale disk hits inflating the rate). Reports
hit rate in bands 0-24, 25-40, 41-60, 60+.

Read-only research: does not touch the production cache.
"""
import asyncio
import sys
import tempfile
import time
from collections import Counter

import chess
import chess.pgn
import io

sys.path.insert(0, ".")
from app.services.cloud_eval import CloudEvalClient  # noqa: E402
from app.services.fetcher import fetch_games  # noqa: E402


def band(ply: int) -> str:
    if ply <= 24:
        return "0-24"
    if ply <= 40:
        return "25-40"
    if ply <= 60:
        return "41-60"
    return "60+"


async def main() -> None:
    games = await fetch_games("chesscom", "hikaru", "blitz", 5)
    print(f"fetched {len(games)} games")
    with tempfile.TemporaryDirectory(prefix="cloud_probe_") as tmp:
        client = CloudEvalClient(cache_dir=tmp)
        hits: Counter[str] = Counter()
        total: Counter[str] = Counter()
        t0 = time.monotonic()
        for game in games:
            pgn = chess.pgn.read_game(io.StringIO(game["pgn"]))
            board = pgn.board()
            for ply, move in enumerate(pgn.mainline_moves()):
                board.push(move)
                # lookup() takes the board AFTER the move; ply index here
                # is the position's ply (1-based after the push).
                result = client.lookup(board)
                b = band(ply + 1)
                total[b] += 1
                if result is not None:
                    hits[b] += 1
        elapsed = time.monotonic() - t0
    print(f"probed {sum(total.values())} positions in {elapsed:.1f}s")
    print(f"client stats: {client.stats}")
    for b in ("0-24", "25-40", "41-60", "60+"):
        n = total[b]
        h = hits[b]
        print(f"  ply {b:>5}: {h:3d}/{n:3d} = {100.0 * h / n:.1f}%" if n else f"  ply {b:>5}: no positions")
    print(f"  TOTAL: {sum(hits.values())}/{sum(total.values())} = "
          f"{100.0 * sum(hits.values()) / sum(total.values()):.1f}%")


if __name__ == "__main__":
    asyncio.run(main())
