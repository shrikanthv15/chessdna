"use client";

import { Clock3, GraduationCap, Swords } from "lucide-react";
import { tagLabel } from "@/lib/format";
import { fenKey } from "@/lib/replay";
import type { Blunder, PracticeEntry, PracticeFocus } from "@/lib/types";

interface PracticeSectionProps {
  plan: PracticeEntry[];
  blunders: Blunder[];
  /** The parent assigns the focus nonce (monotonic counter). */
  onTrainPosition: (focus: Omit<PracticeFocus, "nonce">) => void;
}

/** Find the blunder a practice FEN belongs to (FEN match on board+turn+
 *  castling+ep). Returns the engine best move in UCI, or null when the
 *  position doesn't resolve to a known blunder. */
function bestMoveForFen(
  fen: string,
  blunders: Blunder[],
): string | null {
  const key = fenKey(fen);
  const match = blunders.find((b) => fenKey(b.fen) === key);
  return match && match.best_move_uci ? match.best_move_uci : null;
}

export default function PracticeSection({
  plan,
  blunders,
  onTrainPosition,
}: PracticeSectionProps) {
  if (plan.length === 0) return null;

  return (
    <section className="rounded-xl border border-stone-200 bg-white p-5 sm:p-6 dark:border-zinc-800 dark:bg-zinc-900/50">
      <div className="flex items-center gap-2">
        <GraduationCap className="h-4 w-4 text-stone-500 dark:text-zinc-400" />
        <h2 className="font-display text-lg font-bold text-stone-900 dark:text-zinc-50">
          What to practice
        </h2>
      </div>
      <p className="mt-1 text-sm text-stone-500 dark:text-zinc-500">
        Targeted drills for your actual leaks — built from the positions where
        you went wrong. Train a position on the board above.
      </p>

      <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {plan.map((entry) => {
          const totalMinutes = entry.drills.reduce(
            (sum, d) => sum + (d.minutes_per_day || 0),
            0,
          );
          return (
            <article
              key={entry.tag}
              className="flex flex-col rounded-lg border border-stone-200 bg-stone-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-950/60"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-display text-[15px] leading-snug font-bold text-stone-900 dark:text-zinc-50">
                  {entry.title}
                </h3>
                <span className="rounded-full bg-stone-200 px-2 py-0.5 text-[11px] font-medium text-stone-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {tagLabel(entry.tag)}
                </span>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-stone-600 dark:text-zinc-400">
                {entry.why}
              </p>

              <ul className="mt-3 space-y-2.5">
                {entry.drills.map((drill) => (
                  <li key={drill.title} className="flex gap-2.5">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-emerald-500" />
                    <div>
                      <p className="text-sm font-medium text-stone-900 dark:text-zinc-100">
                        {drill.title}
                        {drill.minutes_per_day > 0 && (
                          <span className="ml-2 inline-flex items-center gap-1 font-mono text-[11px] font-normal text-stone-500 tabular-nums dark:text-zinc-500">
                            <Clock3 className="h-3 w-3" />
                            {drill.minutes_per_day} min/day
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-[13px] leading-relaxed text-stone-500 dark:text-zinc-500">
                        {drill.detail}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="mt-auto pt-4">
                {entry.positions.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 border-t border-stone-200 pt-3 dark:border-zinc-800/80">
                    <span className="mr-1 inline-flex items-center gap-1.5 text-xs font-medium text-stone-600 dark:text-zinc-400">
                      <Swords className="h-3.5 w-3.5" />
                      Train these positions:
                    </span>
                    {entry.positions.map((fen, i) => (
                      <button
                        key={`${fenKey(fen)}-${i}`}
                        type="button"
                        onClick={() =>
                          onTrainPosition({
                            fen,
                            bestMoveUci: bestMoveForFen(fen, blunders),
                            label: `${entry.title} — position ${i + 1} of ${entry.positions.length}`,
                          })
                        }
                        className="rounded-full border border-stone-300 bg-white px-2.5 py-1 font-mono text-[11px] text-stone-700 transition-colors hover:border-emerald-600/50 hover:text-emerald-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-emerald-500/50 dark:hover:text-emerald-300"
                      >
                        Position {i + 1}
                      </button>
                    ))}
                  </div>
                )}
                {totalMinutes > 0 && (
                  <p className="mt-2.5 font-mono text-[11px] text-stone-400 tabular-nums dark:text-zinc-600">
                    About {totalMinutes} min/day total
                  </p>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
