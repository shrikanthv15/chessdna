"use client";

import { evalToWhiteShare } from "@/lib/engine";
import { formatEval } from "@/lib/format";

interface EvalBarProps {
  /** Centipawns from White's perspective, or null when unknown. */
  evalCpWhite: number | null;
  /** Board orientation: when Black is at the bottom, the bar flips so the
   *  user's share is always at the bottom. */
  orientation: "white" | "black";
  /** Readout label: eval from the user's perspective, drawn on the bar. */
  userLabel?: string;
}

/** Vertical eval bar that sits beside the board. The bottom fill is the
 *  side at the bottom of the board; its height is that side's win-prob
 *  share (same curve as the backend, so bar and numbers agree). */
export default function EvalBar({ evalCpWhite, orientation, userLabel }: EvalBarProps) {
  const whiteShare = evalCpWhite === null ? 50 : evalToWhiteShare(evalCpWhite);
  // Bottom fill = the share of whoever sits at the bottom of the board.
  const bottomShare = orientation === "white" ? whiteShare : 100 - whiteShare;
  const bottomIsWhite = orientation === "white";

  return (
    <div
      className="relative w-4 shrink-0 self-stretch overflow-hidden rounded-md border border-stone-300 sm:w-5 dark:border-zinc-700"
      role="img"
      aria-label={
        evalCpWhite === null
          ? "Evaluation unknown"
          : `Evaluation ${formatEval(evalCpWhite)} for White`
      }
      title={evalCpWhite === null ? "No eval for this position" : `White: ${formatEval(evalCpWhite)}`}
    >
      {/* Full-height background = the top side's color. */}
      <div className={`absolute inset-0 ${bottomIsWhite ? "bg-stone-900" : "bg-stone-100"}`} />
      {/* Bottom fill = the bottom side's share. */}
      <div
        className={`absolute right-0 bottom-0 left-0 transition-[height] duration-300 ${bottomIsWhite ? "bg-stone-100" : "bg-stone-900"}`}
        style={{ height: `${bottomShare}%` }}
      />
      {userLabel && (
        <span
          className={`absolute right-0 bottom-1.5 left-0 z-10 text-center font-mono text-[9px] leading-none font-bold [writing-mode:vertical-rl] ${
            bottomShare >= 50
              ? bottomIsWhite
                ? "text-stone-900"
                : "text-stone-100"
              : bottomIsWhite
                ? "text-stone-100"
                : "text-stone-900"
          }`}
        >
          {userLabel}
        </span>
      )}
    </div>
  );
}
