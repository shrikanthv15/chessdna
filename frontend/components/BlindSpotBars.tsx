"use client";

import { EyeOff } from "lucide-react";
import { formatPct, tagLabel } from "@/lib/format";
import type { BlindSpot } from "@/lib/types";

interface BlindSpotBarsProps {
  blindSpots: BlindSpot[];
}

const BAR_COLORS = [
  "bg-rose-400",
  "bg-zinc-500",
  "bg-zinc-500",
  "bg-zinc-600",
  "bg-zinc-600",
  "bg-zinc-700",
];

export default function BlindSpotBars({ blindSpots }: BlindSpotBarsProps) {
  const ranked = [...blindSpots].sort((a, b) => b.pct - a.pct);
  const maxPct = Math.max(1, ...ranked.map((b) => b.pct));

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 sm:p-6">
      <div className="flex items-center gap-2">
        <EyeOff className="h-4 w-4 text-zinc-400" />
        <h2 className="font-display text-lg font-bold text-zinc-50">
          Blind-spot breakdown
        </h2>
      </div>
      <p className="mt-1 text-sm text-zinc-500">
        Every flagged mistake, classified by the thinking habit behind it —
        ranked by share of your errors.
      </p>

      {ranked.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-zinc-800 px-4 py-6 text-center text-sm text-zinc-500">
          No blind-spot patterns detected in this sample. Either you played
          cleanly, or the sample was too small to classify.
        </p>
      ) : (
        <ol className="mt-6 space-y-5">
          {ranked.map((spot, i) => (
            <li key={spot.tag}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="text-sm font-semibold text-zinc-100">
                  <span className="mr-2 font-mono text-xs text-zinc-500 tabular-nums">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {tagLabel(spot.tag, spot.label)}
                </span>
                <span className="font-mono text-sm text-zinc-400 tabular-nums">
                  <span className="font-bold text-zinc-100">
                    {formatPct(spot.pct, 1)}
                  </span>{" "}
                  · {spot.count} {spot.count === 1 ? "time" : "times"}
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className={`h-full rounded-full ${BAR_COLORS[Math.min(i, BAR_COLORS.length - 1)]} transition-all duration-700`}
                  style={{ width: `${(spot.pct / maxPct) * 100}%` }}
                />
              </div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-zinc-500">
                {spot.explanation}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
