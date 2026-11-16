"use client";

import { useMemo, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import {
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Eye,
  EyeOff,
  Lightbulb,
  RotateCcw,
  Swords,
  Timer,
  XCircle,
} from "lucide-react";
import {
  formatClock,
  formatEval,
  formatWinProbDrop,
  phaseDisplay,
  tagLabel,
} from "@/lib/format";
import type { Blunder } from "@/lib/types";

interface BlunderBoardProps {
  blunders: Blunder[];
}

type ViewMode = "start" | "played" | "best";

/** Apply a UCI move (e.g. "e2e4", "e7e8q") to a FEN; returns the new FEN or null. */
function applyUci(fen: string, uci: string): string | null {
  try {
    const game = new Chess(fen);
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    game.move({ from, to, promotion });
    return game.fen();
  } catch {
    return null;
  }
}

function uciSquares(uci: string): { from: string; to: string } {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4) };
}

export default function BlunderBoard({ blunders }: BlunderBoardProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [view, setView] = useState<ViewMode>("start");
  const [showArrow, setShowArrow] = useState(false);
  const [tryMode, setTryMode] = useState(false);
  const [tryState, setTryState] = useState<"idle" | "success" | "wrong">("idle");
  const [attempts, setAttempts] = useState(0);
  const [solvedFen, setSolvedFen] = useState<string | null>(null);

  const blunder = blunders[selectedIdx];

  const turn = useMemo(() => {
    if (!blunder) return "w";
    try {
      return new Chess(blunder.fen).turn();
    } catch {
      return "w";
    }
  }, [blunder]);

  function selectBlunder(idx: number) {
    setSelectedIdx(idx);
    setView("start");
    setShowArrow(false);
    setTryMode(false);
    setTryState("idle");
    setAttempts(0);
    setSolvedFen(null);
  }

  function enterTryMode() {
    setTryMode(true);
    setView("start");
    setTryState("idle");
    setAttempts(0);
    setSolvedFen(null);
    setShowArrow(false);
  }

  function exitTryMode() {
    setTryMode(false);
    setTryState("idle");
    setSolvedFen(null);
  }

  if (!blunder) {
    return (
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <Swords className="h-4 w-4 text-zinc-400" />
          <h2 className="font-display text-lg font-bold text-zinc-50">
            Fix your blunders
          </h2>
        </div>
        <p className="mt-6 rounded-lg border border-dashed border-zinc-800 px-4 py-8 text-center text-sm text-zinc-500">
          No major blunders found in this sample — nothing to replay. Nice
          playing.
        </p>
      </section>
    );
  }

  // --- Derived board state ---
  const playedFen = applyUci(blunder.fen, blunder.move_played_uci);
  const bestFen = applyUci(blunder.fen, blunder.best_move_uci);

  const displayFen =
    tryMode && solvedFen
      ? solvedFen
      : view === "played"
        ? (playedFen ?? blunder.fen)
        : view === "best"
          ? (bestFen ?? blunder.fen)
          : blunder.fen;

  const orientation: "white" | "black" =
    blunder.player_color === "black" ? "black" : "white";

  // Arrows: best-move arrow (emerald) or played-move arrow (rose).
  const arrows: { startSquare: string; endSquare: string; color: string }[] = [];
  if (tryMode && solvedFen) {
    const sq = uciSquares(blunder.best_move_uci);
    arrows.push({ startSquare: sq.from, endSquare: sq.to, color: "#34d399" });
  } else if (showArrow && !tryMode) {
    if (view === "played") {
      const sq = uciSquares(blunder.move_played_uci);
      arrows.push({ startSquare: sq.from, endSquare: sq.to, color: "#fb7185" });
    } else {
      const sq = uciSquares(blunder.best_move_uci);
      arrows.push({ startSquare: sq.from, endSquare: sq.to, color: "#34d399" });
    }
  }

  // Highlight the from/to squares of the move currently on display.
  const squareStyles: Record<string, React.CSSProperties> = {};
  if (!tryMode || solvedFen) {
    const shownUci =
      view === "played" ? blunder.move_played_uci : blunder.best_move_uci;
    const sq = uciSquares(shownUci);
    const tint =
      view === "played" ? "rgba(251, 113, 133, 0.35)" : "rgba(52, 211, 153, 0.35)";
    if (view !== "start" || (tryMode && solvedFen)) {
      squareStyles[sq.from] = { backgroundColor: tint };
      squareStyles[sq.to] = { backgroundColor: tint };
    }
  }

  function handlePieceDrop({
    sourceSquare,
    targetSquare,
  }: {
    piece: { pieceType: string };
    sourceSquare: string;
    targetSquare: string | null;
  }): boolean {
    if (!tryMode || !targetSquare || tryState === "success") return false;
    try {
      const game = new Chess(blunder.fen);
      const move = game.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: "q",
      });
      const playedUci = move.from + move.to + (move.promotion ?? "");
      if (playedUci === blunder.best_move_uci) {
        setSolvedFen(game.fen());
        setTryState("success");
        return true;
      }
      setAttempts((n) => n + 1);
      setTryState("wrong");
      return false; // snap back — not the engine move
    } catch {
      return false; // illegal move — snap back
    }
  }

  const bestTarget = uciSquares(blunder.best_move_uci).to;
  const clock = formatClock(blunder.clock_seconds);

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 sm:p-6">
      <div className="flex items-center gap-2">
        <Swords className="h-4 w-4 text-zinc-400" />
        <h2 className="font-display text-lg font-bold text-zinc-50">
          Fix your blunders
        </h2>
      </div>
      <p className="mt-1 text-sm text-zinc-500">
        Your actual worst moments, replayable. Find the move Stockfish wanted.
      </p>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[300px_1fr]">
        {/* Blunder list */}
        <ol className="max-h-[560px] space-y-2 overflow-y-auto pr-1">
          {blunders.map((b, i) => (
            <li key={`${b.fen}-${i}`}>
              <button
                type="button"
                onClick={() => selectBlunder(i)}
                aria-current={i === selectedIdx}
                className={`w-full rounded-lg border px-3.5 py-3 text-left transition-colors ${
                  i === selectedIdx
                    ? "border-emerald-500/50 bg-emerald-500/[0.08]"
                    : "border-zinc-800 bg-zinc-950/60 hover:border-zinc-700"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-zinc-500 tabular-nums">
                    Move {b.move_number} · {phaseDisplay(b.phase)}
                  </span>
                  <ChevronRight
                    className={`h-3.5 w-3.5 shrink-0 ${i === selectedIdx ? "text-emerald-400" : "text-zinc-600"}`}
                  />
                </div>
                <div className="mt-1.5 font-mono text-sm tabular-nums">
                  <span className="text-rose-300">{b.move_played}</span>
                  <span className="mx-1.5 text-zinc-600">→</span>
                  <span className="text-emerald-300">{b.best_move}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-zinc-300">
                    {tagLabel(b.tag)}
                  </span>
                  <span className="font-mono text-[11px] text-zinc-500 tabular-nums">
                    {formatEval(b.eval_before_cp)} →{" "}
                    {formatEval(b.eval_after_cp)}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ol>

        {/* Board + controls */}
        <div>
          <div className="mx-auto w-full max-w-[520px]">
            <div className="overflow-hidden rounded-lg border border-zinc-800">
              <Chessboard
                options={{
                  position: displayFen,
                  boardOrientation: orientation,
                  allowDragging: tryMode && tryState !== "success",
                  canDragPiece: ({ piece }) =>
                    piece.pieceType[0] === turn,
                  onPieceDrop: handlePieceDrop,
                  arrows,
                  squareStyles,
                  allowDrawingArrows: false,
                  showNotation: true,
                  animationDurationInMs: 200,
                }}
              />
            </div>
          </div>

          {/* Controls */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="flex gap-1 rounded-lg bg-zinc-950 p-1">
              {(
                [
                  { value: "start", label: "Position" },
                  { value: "played", label: "Your move" },
                  { value: "best", label: "Best move" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  disabled={tryMode}
                  onClick={() => setView(opt.value)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40 ${
                    view === opt.value && !tryMode
                      ? "bg-zinc-800 text-zinc-50 shadow"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              disabled={tryMode}
              onClick={() => setShowArrow((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-700 disabled:opacity-40"
            >
              {showArrow ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
              {showArrow ? "Hide arrow" : "Show best move"}
            </button>

            {tryMode ? (
              <button
                type="button"
                onClick={exitTryMode}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-700"
              >
                <RotateCcw className="h-4 w-4" />
                Exit practice
              </button>
            ) : (
              <button
                type="button"
                onClick={enterTryMode}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-bold text-zinc-950 transition-colors hover:bg-emerald-400"
              >
                Try it yourself
              </button>
            )}
          </div>

          {/* Try-mode feedback */}
          {tryMode && (
            <div className="mt-3">
              {tryState === "success" ? (
                <p className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  Correct — <span className="font-mono">{blunder.best_move}</span>
                  {attempts > 0 && (
                    <span className="text-emerald-300/80">
                      (after {attempts} {attempts === 1 ? "miss" : "misses"})
                    </span>
                  )}
                </p>
              ) : tryState === "wrong" ? (
                <p className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                  <XCircle className="h-4 w-4 shrink-0" />
                  Not the engine&apos;s choice — try again.
                  {attempts >= 2 && (
                    <span className="inline-flex items-center gap-1 text-rose-200/90">
                      <Lightbulb className="h-3.5 w-3.5" />
                      Hint: the key move lands on{" "}
                      <span className="font-mono font-bold">{bestTarget}</span>
                    </span>
                  )}
                </p>
              ) : (
                <p className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-400">
                  Drag a piece to play the move you think Stockfish wanted.
                </p>
              )}
            </div>
          )}

          {/* Blunder details */}
          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-sm tabular-nums">
              <span className="text-zinc-400">
                Eval{" "}
                <span className="text-zinc-100">
                  {formatEval(blunder.eval_before_cp)}
                </span>{" "}
                →{" "}
                <span className="text-rose-300">
                  {formatEval(blunder.eval_after_cp)}
                </span>
              </span>
              <span className="text-zinc-400">
                Win prob{" "}
                <span className="font-bold text-rose-300">
                  −{formatWinProbDrop(blunder.win_prob_drop)}
                </span>
              </span>
              {clock && (
                <span className="inline-flex items-center gap-1 text-zinc-400">
                  <Timer className="h-3.5 w-3.5" />
                  {clock} left
                </span>
              )}
            </div>

            <p className="mt-2.5 text-sm leading-relaxed text-zinc-300">
              {blunder.explanation}
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {blunder.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-zinc-300"
                >
                  {tagLabel(t)}
                </span>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-800/80 pt-3 text-xs text-zinc-500">
              <span>
                vs <span className="font-mono text-zinc-300">{blunder.opponent}</span>{" "}
                as {blunder.player_color}
              </span>
              {blunder.game_url && (
                <a
                  href={blunder.game_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300"
                >
                  View full game
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>

            <p className="mt-3 font-mono text-[11px] leading-relaxed break-all text-zinc-600">
              {blunder.fen}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
