"use client";

import { AlertTriangle, Crosshair, Gamepad2, Trophy } from "lucide-react";
import { formatPct, tagLabel, topClassifiedSpot } from "@/lib/format";
import type { PlayerDNA } from "@/lib/types";

interface KpiCardsProps {
  result: PlayerDNA;
}

export default function KpiCards({ result }: KpiCardsProps) {
  // Headline leak = the backend's top NON-unclassified tag (top_blind_spot),
  // resolved against the breakdown for its share/count. "Unclassified" must
  // never headline this card, even when it's the largest bucket.
  const topSpot = topClassifiedSpot(result.blind_spots, result.top_blind_spot);
  const { wins, losses, draws } = {
    wins: result.record.white.wins + result.record.black.wins,
    losses: result.record.white.losses + result.record.black.losses,
    draws: result.record.white.draws + result.record.black.draws,
  };

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {/* Games analyzed */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">
          <Gamepad2 className="h-4 w-4" />
          Games analyzed
        </div>
        <p className="mt-3 font-mono text-3xl font-bold text-zinc-50 tabular-nums">
          {result.games_analyzed}
        </p>
        <p className="mt-1 font-mono text-xs text-zinc-500 tabular-nums">
          {wins}W · {losses}L · {draws}D
          {result.games_analyzed < result.games_requested &&
            ` (of ${result.games_requested} requested)`}
        </p>
      </div>

      {/* Win rate */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">
          <Trophy className="h-4 w-4" />
          Win rate
        </div>
        <p className="mt-3 font-mono text-3xl font-bold text-zinc-50 tabular-nums">
          {formatPct(result.win_rate.overall, 1)}
        </p>
        <p className="mt-1 font-mono text-xs text-zinc-500 tabular-nums">
          White {formatPct(result.win_rate.white, 1)} · Black{" "}
          {formatPct(result.win_rate.black, 1)}
        </p>
      </div>

      {/* #1 blind spot */}
      <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.06] p-5">
        <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-rose-300/90 uppercase">
          <AlertTriangle className="h-4 w-4" />
          #1 blind-spot leak
        </div>
        {topSpot ? (
          <>
            <p className="mt-3 font-display text-lg leading-snug font-bold text-zinc-50">
              {tagLabel(topSpot.tag, topSpot.label)}
            </p>
            <p className="mt-1 font-mono text-xs text-zinc-500 tabular-nums">
              {formatPct(topSpot.pct, 1)} of flagged mistakes · {topSpot.count}{" "}
              occurrences
            </p>
          </>
        ) : (
          <>
            <p className="mt-3 font-display text-lg leading-snug font-bold text-zinc-50">
              No clear pattern yet
            </p>
            <p className="mt-1 font-mono text-xs text-zinc-500">
              Play more games to surface a recurring habit
            </p>
          </>
        )}
      </div>

      {/* Endgame conversion */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">
          <Crosshair className="h-4 w-4" />
          Winning-position conversion
        </div>
        <p className="mt-3 font-mono text-3xl font-bold text-zinc-50 tabular-nums">
          {formatPct(result.conversion.conversion_rate, 1)}
        </p>
        <p className="mt-1 font-mono text-xs text-zinc-500 tabular-nums">
          {result.conversion.wins}W · {result.conversion.draws}D ·{" "}
          {result.conversion.losses}L from {result.conversion.winning_positions}{" "}
          winning positions
        </p>
      </div>
    </div>
  );
}
