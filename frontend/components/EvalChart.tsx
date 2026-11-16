"use client";

import { useMemo } from "react";
import { clampCp, moveNumberForPly, type EvalSwing } from "@/lib/replay";
import { formatEval } from "@/lib/format";
import type { EvalPoint } from "@/lib/types";

interface EvalChartProps {
  series: EvalPoint[];
  currentPly: number;
  totalPlies: number;
  /** Plies (positions after N half-moves) where this game's blunders landed. */
  blunderPlies: number[];
  swings: { gain: EvalSwing | null; loss: EvalSwing | null };
  onSelectPly: (ply: number) => void;
}

const W = 600;
const H = 116;
const PAD_L = 30;
const PAD_R = 10;
const PAD_T = 12;
const PAD_B = 20;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;
const MID_Y = PAD_T + PLOT_H / 2;

/** Eval chart: White's perspective, clamped to ±1000cp. Click to jump the
 *  board to that ply. Blunder plies are rose dots; the cursor tracks the
 *  board position. Grid/label/cursor colors come from CSS variables so the
 *  chart follows the light/dark theme (see globals.css). */
export default function EvalChart({
  series,
  currentPly,
  totalPlies,
  blunderPlies,
  swings,
  onSelectPly,
}: EvalChartProps) {
  const points = useMemo(() => {
    const byPly = new Map<number, number>();
    for (const p of series) byPly.set(p.ply, p.cp);
    return [...byPly.entries()]
      .map(([ply, cp]) => ({ ply, cp }))
      .sort((a, b) => a.ply - b.ply);
  }, [series]);

  const maxPly = Math.max(totalPlies, points[points.length - 1]?.ply ?? 0, 1);
  const xFor = (ply: number) => PAD_L + (ply / maxPly) * PLOT_W;
  const yFor = (cp: number) => MID_Y - (clampCp(cp) / 1000) * (PLOT_H / 2);

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${xFor(p.ply).toFixed(1)},${yFor(p.cp).toFixed(1)}`)
    .join(" ");
  const areaPath =
    points.length > 0
      ? `${linePath} L${xFor(points[points.length - 1].ply).toFixed(1)},${MID_Y} L${xFor(points[0].ply).toFixed(1)},${MID_Y} Z`
      : "";

  const cpAt = (ply: number): number | null => {
    let best: EvalPoint | null = null;
    for (const p of points) {
      if (p.ply <= ply && (best === null || p.ply >= best.ply)) best = p;
    }
    return best ? best.cp : null;
  };

  function handleClick(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const svgX = frac * W;
    const ply = Math.round(((svgX - PAD_L) / PLOT_W) * maxPly);
    onSelectPly(Math.max(0, Math.min(totalPlies, ply)));
  }

  const swingChip = (swing: EvalSwing | null, kind: "gain" | "loss") => {
    if (!swing || Math.abs(swing.deltaCp) < 100) return null;
    const signed = formatEval(swing.deltaCp);
    return (
      <button
        key={kind}
        type="button"
        onClick={() => onSelectPly(swing.ply)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] tabular-nums transition-colors ${
          kind === "gain"
            ? "border-emerald-600/30 bg-emerald-600/[0.07] text-emerald-700 hover:border-emerald-600/50 dark:border-emerald-500/30 dark:bg-emerald-500/[0.07] dark:text-emerald-300 dark:hover:border-emerald-500/50"
            : "border-rose-600/30 bg-rose-600/[0.07] text-rose-700 hover:border-rose-600/50 dark:border-rose-500/30 dark:bg-rose-500/[0.07] dark:text-rose-300 dark:hover:border-rose-500/50"
        }`}
        title={`Jump to move ${moveNumberForPly(swing.ply)}`}
      >
        {kind === "gain" ? "▲ Win was here" : "▼ Lost here"}
        <span className="text-stone-500 dark:text-zinc-400">
          move {moveNumberForPly(swing.ply)} · {signed} swing
        </span>
      </button>
    );
  };

  return (
    <div>
      <p className="mb-1 text-right text-[11px] text-stone-500 dark:text-zinc-500">
        Evaluation from White&rsquo;s perspective · click the chart to jump
      </p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full cursor-pointer select-none"
        onClick={handleClick}
        role="img"
        aria-label="Evaluation chart — click to jump to a position"
      >
        {/* Y gridlines + labels (White's perspective) */}
        {[1000, 0, -1000].map((cp) => (
          <g key={cp}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yFor(cp)}
              y2={yFor(cp)}
              stroke="var(--chart-grid)"
              strokeWidth={cp === 0 ? 1.5 : 1}
            />
            <text
              x={PAD_L - 5}
              y={yFor(cp) + 3}
              textAnchor="end"
              fill="var(--chart-label)"
              fontSize="9"
              fontFamily="monospace"
            >
              {cp === 0 ? "0" : cp > 0 ? "+10" : "−10"}
            </text>
          </g>
        ))}
        {/* X labels: first / middle / last move. The last label is
            end-anchored so it isn't clipped by the viewBox edge. */}
        {[0, Math.round(maxPly / 2), maxPly].map((ply) => (
          <text
            key={ply}
            x={xFor(ply)}
            y={H - 6}
            textAnchor={ply === 0 ? "start" : ply === maxPly ? "end" : "middle"}
            fill="var(--chart-label)"
            fontSize="9"
            fontFamily="monospace"
          >
            {ply === 0 ? "start" : `move ${moveNumberForPly(ply)}`}
          </text>
        ))}

        {/* Eval area + line */}
        {points.length > 1 && (
          <>
            <path d={areaPath} fill="#34d399" fillOpacity={0.08} />
            <path
              d={linePath}
              fill="none"
              stroke="#10b981"
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </>
        )}
        {points.length === 1 && (
          <circle cx={xFor(points[0].ply)} cy={yFor(points[0].cp)} r={3} fill="#10b981" />
        )}

        {/* Blunder markers */}
        {blunderPlies.map((ply) => {
          const cp = cpAt(ply);
          if (cp === null) return null;
          return (
            <circle
              key={ply}
              cx={xFor(ply)}
              cy={yFor(cp)}
              r={4}
              fill="#fb7185"
              stroke="var(--paper)"
              strokeWidth={1.5}
            />
          );
        })}

        {/* Swing markers */}
        {swings.gain && Math.abs(swings.gain.deltaCp) >= 100 && (
          <circle
            cx={xFor(swings.gain.ply)}
            cy={yFor(cpAt(swings.gain.ply) ?? 0)}
            r={4}
            fill="#059669"
            stroke="#a7f3d0"
            strokeWidth={1}
          />
        )}
        {swings.loss && Math.abs(swings.loss.deltaCp) >= 100 && (
          <circle
            cx={xFor(swings.loss.ply)}
            cy={yFor(cpAt(swings.loss.ply) ?? 0)}
            r={4}
            fill="#e11d48"
            stroke="#fecdd3"
            strokeWidth={1}
          />
        )}

        {/* Cursor at the board's current ply */}
        <line
          x1={xFor(currentPly)}
          x2={xFor(currentPly)}
          y1={PAD_T}
          y2={PAD_T + PLOT_H}
          stroke="var(--chart-cursor)"
          strokeWidth={1}
          strokeOpacity={0.7}
        />
        {cpAt(currentPly) !== null && (
          <circle
            cx={xFor(currentPly)}
            cy={yFor(cpAt(currentPly) as number)}
            r={3.5}
            fill="var(--paper)"
            stroke="var(--chart-cursor)"
            strokeWidth={1.5}
          />
        )}
      </svg>

      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-stone-400 dark:text-zinc-600">
          Eval, White&apos;s perspective · click the chart to jump
        </span>
        <span className="ml-auto flex flex-wrap gap-1.5">
          {swingChip(swings.gain, "gain")}
          {swingChip(swings.loss, "loss")}
        </span>
      </div>
    </div>
  );
}
