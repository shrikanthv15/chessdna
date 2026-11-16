"""Time 5-game analysis before/after the two-pass change.

Cloud eval is DISABLED here on purpose: it isolates the pure local
engine cost (and the pass-2 surcharge) from cache state, so before/after
runs are directly comparable. Depth 13 = the UI default.
"""
import asyncio
import sys
import time

sys.path.insert(0, ".")
from app.analyzer.engine import EngineAnalyzer  # noqa: E402
from app.config import settings  # noqa: E402
from app.services.fetcher import fetch_games  # noqa: E402


async def main() -> None:
    games = await fetch_games("chesscom", "hikaru", "blitz", 5)
    print(f"fetched {len(games)} games; stockfish={settings.STOCKFISH_PATH}")
    total = 0.0
    total_blunders = 0
    with EngineAnalyzer(settings.STOCKFISH_PATH, depth=13, cloud_enabled=False) as analyzer:
        for i, game in enumerate(games):
            t0 = time.monotonic()
            analysis = analyzer.analyze_game(game)
            dt = time.monotonic() - t0
            total += dt
            blunders = sum(1 for m in analysis["moves"] if m["severity"] == "blunder")
            total_blunders += blunders
            deep = sum(1 for m in analysis["moves"] if "deep_eval" in m)
            print(f"  game {i+1}: {dt:5.1f}s  moves={len(analysis['moves']):3d} "
                  f"blunders={blunders} deep={deep}")
    print(f"TOTAL: {total:.1f}s for {len(games)} games, {total_blunders} blunders "
          f"(extrapolated 25-game fresh run: {total * 5:.0f}s single-worker)")


if __name__ == "__main__":
    asyncio.run(main())
