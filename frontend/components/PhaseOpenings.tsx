"use client";

import { BookOpen, Clock3 } from "lucide-react";
import { formatPct } from "@/lib/format";
import type { OpeningStat, PlayerDNA } from "@/lib/types";

interface PhaseOpeningsProps {
  result: PlayerDNA;
}

const PHASES: { key: keyof PlayerDNA["phase_mistakes"]; label: string; moves: string }[] = [
  { key: "opening", label: "Opening", moves: "Moves 1–10" },
  { key: "middlegame", label: "Middlegame", moves: "Moves 11–30" },
  { key: "endgame", label: "Endgame", moves: "Move 31+" },
];

export default function PhaseOpenings({ result }: PhaseOpeningsProps) {
  const totalPhase = PHASES.reduce((sum, p) => sum + result.phase_mistakes[p.key], 0);
  const maxPhase = Math.max(1, ...PHASES.map((p) => result.phase_mistakes[p.key]));

  const worstOpenings = [...result.openings]
    .sort((a, b) => a.score_pct - b.score_pct)
    .slice(0, 6);

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {/* Phase distribution */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <Clock3 className="h-4 w-4 text-zinc-400" />
          <h2 className="font-display text-lg font-bold text-zinc-50">
            Where points leak
          </h2>
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          Flagged mistakes by game phase.
        </p>

        {totalPhase === 0 ? (
          <p className="mt-6 rounded-lg border border-dashed border-zinc-800 px-4 py-6 text-center text-sm text-zinc-500">
            No flagged mistakes in this sample.
          </p>
        ) : (
          <div className="mt-6 space-y-4">
            {PHASES.map((phase) => {
              const count = result.phase_mistakes[phase.key];
              const share = (count / totalPhase) * 100;
              return (
                <div key={phase.key}>
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm font-semibold text-zinc-100">
                      {phase.label}{" "}
                      <span className="font-mono text-xs font-normal text-zinc-500">
                        {phase.moves}
                      </span>
                    </span>
                    <span className="font-mono text-sm text-zinc-400 tabular-nums">
                      {count} · {formatPct(share, 1)}
                    </span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-emerald-400 transition-all duration-700"
                      style={{ width: `${(count / maxPhase) * 100}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-6 border-t border-zinc-800/80 pt-4">
          <p className="font-mono text-xs leading-relaxed text-zinc-500 tabular-nums">
            Avg. centipawn loss{" "}
            <span className="font-semibold text-zinc-300">
              {result.avg_centipawn_loss.toFixed(1)}
            </span>{" "}
            · {result.accuracy.blunders} blunders ·{" "}
            {result.accuracy.mistakes} mistakes ·{" "}
            {result.accuracy.inaccuracies} inaccuracies across{" "}
            {result.accuracy.total_user_moves.toLocaleString()} moves
          </p>
        </div>
      </section>

      {/* Opening leaks */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-zinc-400" />
          <h2 className="font-display text-lg font-bold text-zinc-50">
            Lowest-scoring openings
          </h2>
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          Your worst results by ECO code in this sample.
        </p>

        {worstOpenings.length === 0 ? (
          <p className="mt-6 rounded-lg border border-dashed border-zinc-800 px-4 py-6 text-center text-sm text-zinc-500">
            No opening data available for these games.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs tracking-wide text-zinc-500 uppercase">
                  <th className="py-2 pr-3 font-medium">ECO</th>
                  <th className="py-2 pr-3 font-medium">Opening</th>
                  <th className="py-2 pr-3 text-right font-medium">G</th>
                  <th className="py-2 pr-3 text-right font-medium">W/L/D</th>
                  <th className="py-2 text-right font-medium">Score</th>
                </tr>
              </thead>
              <tbody>
                {worstOpenings.map((op: OpeningStat, i) => (
                  <tr
                    key={`${op.eco}-${op.name}`}
                    className={`border-b border-zinc-800/60 last:border-0 ${
                      i === 0 ? "bg-rose-500/[0.06] text-zinc-100" : "text-zinc-300"
                    }`}
                  >
                    <td className="py-2.5 pr-3 font-mono text-xs text-zinc-400">
                      {op.eco}
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className="line-clamp-1">{op.name}</span>
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono tabular-nums">
                      {op.games}
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono text-xs whitespace-nowrap tabular-nums">
                      {op.wins}/{op.losses}/{op.draws}
                    </td>
                    <td
                      className={`py-2.5 text-right font-mono font-semibold tabular-nums ${
                        i === 0 ? "text-rose-300" : "text-zinc-200"
                      }`}
                    >
                      {formatPct(op.score_pct, 1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
