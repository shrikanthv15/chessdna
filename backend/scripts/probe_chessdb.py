"""Probe chessdb.cn as a possible second eval tier.

Sequential probes of ~20 real middlegame FENs (from the training-set
fixture). Records latency, hit rate, whether eval/depth are returned,
and any rate limiting. Read-only research; small N, polite delays.
"""
import json
import statistics
import sys
import time
import urllib.parse

import httpx

sys.path.insert(0, ".")

URL = "https://www.chessdb.cn/cdb.php"


def main() -> None:
    cases = json.load(open("tests/fixtures/unclassified_rapid_v2.json"))
    middlegame = [c for c in cases if c["phase"] == "middlegame"][:20]
    print(f"probing {len(middlegame)} middlegame FENs")
    latencies: list[float] = []
    hits = 0
    with httpx.Client(timeout=10.0, headers={"User-Agent": "ChessDNA-research/1.0"}) as client:
        for i, case in enumerate(middlegame):
            fen = case["fen_before"]
            params = {"action": "querybest", "board": fen}
            t0 = time.monotonic()
            try:
                resp = client.get(URL, params=params)
                dt = time.monotonic() - t0
                latencies.append(dt)
                body = resp.text.strip()
                print(f"[{i+1:2d}] {resp.status_code} {dt*1000:6.0f}ms :: {body[:200]!r}")
                if resp.status_code == 200 and body.startswith("move:"):
                    hits += 1
            except httpx.HTTPError as exc:
                dt = time.monotonic() - t0
                latencies.append(dt)
                print(f"[{i+1:2d}] ERROR {dt*1000:6.0f}ms :: {exc}")
            time.sleep(0.5)
    print(f"\nhits: {hits}/{len(middlegame)}")
    if latencies:
        print(f"latency p50: {statistics.median(latencies)*1000:.0f}ms, "
              f"p90: {sorted(latencies)[int(0.9*len(latencies))-1]*1000:.0f}ms, "
              f"max: {max(latencies)*1000:.0f}ms")


if __name__ == "__main__":
    main()
