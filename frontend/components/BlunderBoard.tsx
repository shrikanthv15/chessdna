"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  ExternalLink,
  Eye,
  EyeOff,
  Lightbulb,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Swords,
  Timer,
  XCircle,
} from "lucide-react";
import EvalChart from "./EvalChart";
import {
  formatClock,
  formatEval,
  formatGameDate,
  formatWinProbDrop,
  phaseDisplay,
  resultLetter,
  tagLabel,
  timeControlDisplay,
} from "@/lib/format";
import {
  blunderPlyFromMove,
  buildFenList,
  computeSwings,
  evalAtPly,
  findBlunderPly,
  groupBlundersByGame,
  moveNumberForPly,
  type GameGroup,
} from "@/lib/replay";
import type { Blunder, PracticeFocus } from "@/lib/types";

interface BlunderBoardProps {
  blunders: Blunder[];
  /** A practice position requested from the practice section. */
  practiceFocus?: PracticeFocus | null;
}

type ViewMode = "start" | "played" | "best";

/** Apply a UCI move (e.g. "e2e4", "e7e8q") to a FEN; returns the new FEN or null. */
function applyUci(fen: string, uci: string): string | null {
  if (!uci || uci.length < 4) return null;
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

function turnOf(fen: string): "w" | "b" {
  try {
    return new Chess(fen).turn();
  } catch {
    return "w";
  }
}

/** Ply of the blunder move inside its game's FEN list (position BEFORE it). */
function plyForBlunder(fens: string[], b: Blunder): number {
  return findBlunderPly(
    fens,
    b.fen,
    blunderPlyFromMove(b.move_number, b.player_color),
  );
}

const AUTOPLAY_MS = 800;

export default function BlunderBoard({
  blunders,
  practiceFocus,
}: BlunderBoardProps) {
  const [gameFilterKey, setGameFilterKey] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [ply, setPly] = useState(0);
  const [view, setView] = useState<ViewMode>("start");
  const [showArrow, setShowArrow] = useState(false);
  const [tryMode, setTryMode] = useState(false);
  const [tryState, setTryState] = useState<"idle" | "success" | "wrong">("idle");
  const [attempts, setAttempts] = useState(0);
  const [solvedFen, setSolvedFen] = useState<string | null>(null);
  const [autoPlaying, setAutoPlaying] = useState(false);
  const [positionMode, setPositionMode] = useState<{
    fen: string;
    bestMoveUci: string | null;
    label: string;
  } | null>(null);
  const [consumedFocusNonce, setConsumedFocusNonce] = useState<number | null>(
    null,
  );
  const moveListRef = useRef<HTMLDivElement | null>(null);

  // Practice positions requested from the practice section: adjust state
  // during render when a new focus arrives (the documented React pattern
  // for resetting state when a prop changes — not an effect).
  if (practiceFocus && practiceFocus.nonce !== consumedFocusNonce) {
    setConsumedFocusNonce(practiceFocus.nonce);
    setPositionMode({
      fen: practiceFocus.fen,
      bestMoveUci: practiceFocus.bestMoveUci,
      label: practiceFocus.label,
    });
    setTryMode(practiceFocus.bestMoveUci !== null);
    setView("start");
    setShowArrow(false);
    setTryState("idle");
    setAttempts(0);
    setSolvedFen(null);
    setAutoPlaying(false);
  }

  const groups = useMemo(() => groupBlundersByGame(blunders), [blunders]);

  // FEN list per game group: index N = position after N half-moves.
  const groupFens = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const g of groups) {
      map.set(g.key, buildFenList(g.movesUci, g.movesSan));
    }
    return map;
  }, [groups]);

  const safeIdx = Math.min(selectedIdx, Math.max(0, blunders.length - 1));
  const blunder = blunders[safeIdx];
  const group: GameGroup | undefined = groups.find((g) =>
    g.blunderIndices.includes(safeIdx),
  );
  const fallbackFen = blunder?.fen ?? new Chess().fen();
  const fens = useMemo(
    () => (group ? (groupFens.get(group.key) ?? [fallbackFen]) : [fallbackFen]),
    [group, groupFens, fallbackFen],
  );
  const hasReplay = fens.length > 1;
  const totalPlies = fens.length - 1;
  const blunderPly = hasReplay && blunder ? plyForBlunder(fens, blunder) : 0;

  // All blunder plies in this game (chart markers + move-list marks).
  const gameBlunderPlies = useMemo(() => {
    if (!group || !hasReplay) return [] as number[];
    const set = new Set<number>();
    for (const i of group.blunderIndices) {
      set.add(plyForBlunder(fens, blunders[i]));
    }
    return [...set];
  }, [group, hasReplay, fens, blunders]);

  const swings = useMemo(
    () =>
      blunder
        ? computeSwings(group?.evalSeries, blunder.player_color)
        : { gain: null, loss: null },
    [group, blunder],
  );

  const visibleIndices = useMemo(() => {
    if (!gameFilterKey) return blunders.map((_, i) => i);
    return groups.find((g) => g.key === gameFilterKey)?.blunderIndices ?? [];
  }, [gameFilterKey, groups, blunders]);

  // --- Practice positions from the practice section are applied during
  // render above (see consumedFocusNonce). ---

  function resetPuzzleState() {
    setView("start");
    setShowArrow(false);
    setTryMode(false);
    setTryState("idle");
    setAttempts(0);
    setSolvedFen(null);
    setAutoPlaying(false);
  }

  function selectBlunder(idx: number) {
    const target = blunders[idx];
    const targetGroup = groups.find((g) => g.blunderIndices.includes(idx));
    const targetFens = targetGroup
      ? (groupFens.get(targetGroup.key) ?? [target.fen])
      : [target.fen];
    setSelectedIdx(idx);
    setPositionMode(null);
    resetPuzzleState();
    setPly(targetFens.length > 1 ? plyForBlunder(targetFens, target) : 0);
  }

  function selectGameFilter(key: string | null) {
    setGameFilterKey(key);
    if (key) {
      const g = groups.find((x) => x.key === key);
      if (g && !g.blunderIndices.includes(safeIdx) && g.blunderIndices.length > 0) {
        selectBlunder(g.blunderIndices[0]);
      }
    }
  }

  function enterTryMode() {
    if (!positionMode) setPly(blunderPly);
    setTryMode(true);
    setView("start");
    setTryState("idle");
    setAttempts(0);
    setSolvedFen(null);
    setShowArrow(false);
    setAutoPlaying(false);
  }

  function exitTryMode() {
    setTryMode(false);
    setTryState("idle");
    setSolvedFen(null);
  }

  function exitPositionMode() {
    setPositionMode(null);
    exitTryMode();
    setShowArrow(false);
  }

  // --- Replay navigation ---
  const navEnabled = hasReplay && !tryMode && !positionMode;

  function goToPly(next: number) {
    if (tryMode || positionMode) return; // puzzle stays put while solving
    setAutoPlaying(false);
    setPly(Math.max(0, Math.min(totalPlies, next)));
  }

  // Auto-play advances one ply per tick until the end of the game; reaching
  // the end simply stops scheduling (isPlaying derives to false).
  const isPlaying = autoPlaying && ply < totalPlies;

  function toggleAutoplay() {
    if (!navEnabled) return;
    if (isPlaying) {
      setAutoPlaying(false);
    } else {
      if (ply >= totalPlies) setPly(0);
      setAutoPlaying(true);
    }
  }

  useEffect(() => {
    if (!isPlaying) return;
    const t = setTimeout(
      () => setPly((p) => Math.min(p + 1, totalPlies)),
      AUTOPLAY_MS,
    );
    return () => clearTimeout(t);
  }, [isPlaying, totalPlies]);

  function handleBoardKeyDown(e: React.KeyboardEvent) {
    if (!navEnabled) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      goToPly(ply - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      goToPly(ply + 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      goToPly(0);
    } else if (e.key === "End") {
      e.preventDefault();
      goToPly(totalPlies);
    }
  }

  // Keep the current move visible in the move list.
  useEffect(() => {
    const container = moveListRef.current;
    if (!container || ply === 0) return;
    const active = container.querySelector(`[data-ply="${ply}"]`);
    active?.scrollIntoView({ block: "nearest" });
  }, [ply]);

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
  const atBlunder = !hasReplay || ply === blunderPly;
  const anchorFen = hasReplay ? fens[blunderPly] : blunder.fen;
  const playedFen = applyUci(anchorFen, blunder.move_played_uci);
  const bestFen = applyUci(anchorFen, blunder.best_move_uci);

  const displayFen = positionMode
    ? (solvedFen ?? positionMode.fen)
    : tryMode && solvedFen
      ? solvedFen
      : atBlunder && view === "played"
        ? (playedFen ?? anchorFen)
        : atBlunder && view === "best"
          ? (bestFen ?? anchorFen)
          : atBlunder
            ? anchorFen
            : fens[ply];

  const orientation: "white" | "black" = positionMode
    ? turnOf(positionMode.fen) === "b"
      ? "black"
      : "white"
    : blunder.player_color === "black"
      ? "black"
      : "white";

  const turn = turnOf(displayFen);

  // The puzzle being solved in try-it-yourself mode.
  const puzzle = tryMode
    ? positionMode
      ? { fen: positionMode.fen, bestMoveUci: positionMode.bestMoveUci }
      : { fen: blunder.fen, bestMoveUci: blunder.best_move_uci }
    : null;

  // Arrows: best-move arrow (emerald) or played-move arrow (rose).
  const arrows: { startSquare: string; endSquare: string; color: string }[] = [];
  if (positionMode) {
    if (positionMode.bestMoveUci && (solvedFen || showArrow)) {
      const sq = uciSquares(positionMode.bestMoveUci);
      arrows.push({ startSquare: sq.from, endSquare: sq.to, color: "#34d399" });
    }
  } else if (tryMode && solvedFen) {
    const sq = uciSquares(blunder.best_move_uci);
    arrows.push({ startSquare: sq.from, endSquare: sq.to, color: "#34d399" });
  } else if (showArrow && !tryMode && atBlunder) {
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
  if (positionMode) {
    // no square highlights on a standalone practice position
  } else if (!tryMode || solvedFen) {
    if (atBlunder && (view !== "start" || (tryMode && solvedFen))) {
      const shownUci =
        view === "played" ? blunder.move_played_uci : blunder.best_move_uci;
      const sq = uciSquares(shownUci);
      const tint =
        view === "played"
          ? "rgba(251, 113, 133, 0.35)"
          : "rgba(52, 211, 153, 0.35)";
      squareStyles[sq.from] = { backgroundColor: tint };
      squareStyles[sq.to] = { backgroundColor: tint };
    } else if (!atBlunder && ply > 0 && group?.movesUci?.[ply - 1]) {
      // Last-move highlight while stepping through the game.
      const sq = uciSquares(group.movesUci[ply - 1]);
      squareStyles[sq.from] = { backgroundColor: "rgba(250, 204, 21, 0.22)" };
      squareStyles[sq.to] = { backgroundColor: "rgba(250, 204, 21, 0.22)" };
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
    if (!puzzle || !puzzle.bestMoveUci || !targetSquare || tryState === "success")
      return false;
    try {
      const game = new Chess(puzzle.fen);
      const move = game.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: "q",
      });
      const playedUci = move.from + move.to + (move.promotion ?? "");
      if (playedUci === puzzle.bestMoveUci) {
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

  const hintTarget = puzzle?.bestMoveUci
    ? uciSquares(puzzle.bestMoveUci).to
    : null;
  const clock = formatClock(blunder.clock_seconds);
  const gameDate = formatGameDate(group?.gameDate);
  const ecoLabel = group?.ecoName ?? group?.eco ?? null;

  // Eval readout for the current position (White's perspective).
  const seriesEval = hasReplay ? evalAtPly(group?.evalSeries, ply) : null;
  const readoutEval =
    seriesEval ?? (atBlunder ? blunder.eval_before_cp : null);

  // Move-list rows from SAN (clamped to the FEN list actually built).
  const sanMoves = (group?.movesSan ?? []).slice(0, totalPlies);
  const moveRows: { n: number; white: string | null; black: string | null }[] = [];
  for (let i = 0; i < sanMoves.length; i += 2) {
    moveRows.push({
      n: i / 2 + 1,
      white: sanMoves[i] ?? null,
      black: sanMoves[i + 1] ?? null,
    });
  }

  const resultChip = (result: GameGroup["result"]) => {
    if (!result) return null;
    const styles =
      result === "win"
        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
        : result === "loss"
          ? "border-rose-500/30 bg-rose-500/10 text-rose-300"
          : "border-zinc-700 bg-zinc-800/60 text-zinc-300";
    return (
      <span
        className={`rounded border px-1.5 py-px font-mono text-[11px] font-bold ${styles}`}
        title={result === "win" ? "Won" : result === "loss" ? "Lost" : "Drawn"}
      >
        {resultLetter(result)}
      </span>
    );
  };

  return (
    <section
      id="game-replay"
      className="scroll-mt-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 sm:p-6"
    >
      <div className="flex items-center gap-2">
        <Swords className="h-4 w-4 text-zinc-400" />
        <h2 className="font-display text-lg font-bold text-zinc-50">
          Fix your blunders
        </h2>
      </div>
      <p className="mt-1 text-sm text-zinc-500">
        Play through the full game, see where it turned, and find the move
        Stockfish wanted.
      </p>

      {/* Game filter */}
      {groups.length > 1 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => selectGameFilter(null)}
            aria-pressed={gameFilterKey === null}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              gameFilterKey === null
                ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-300"
                : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
            }`}
          >
            All games · {blunders.length}
          </button>
          {groups.map((g) => {
            const active = gameFilterKey === g.key;
            const date = formatGameDate(g.gameDate);
            return (
              <button
                key={g.key}
                type="button"
                onClick={() => selectGameFilter(g.key)}
                aria-pressed={active}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  active
                    ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-300"
                    : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                }`}
              >
                vs {g.opponent}
                {date && <span className="text-zinc-500">{date}</span>}
                <span className="font-mono text-[11px] text-zinc-500">
                  {g.blunderIndices.length}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)_240px]">
        {/* Blunder list */}
        <ol className="max-h-[560px] space-y-2 overflow-y-auto pr-1">
          {visibleIndices.map((i) => {
            const b = blunders[i];
            const bGroup = groups.find((g) => g.blunderIndices.includes(i));
            const bDate = formatGameDate(bGroup?.gameDate);
            const active = i === safeIdx;
            return (
              <li key={`${b.fen}-${i}`}>
                <button
                  type="button"
                  onClick={() => selectBlunder(i)}
                  aria-current={active}
                  className={`w-full rounded-lg border px-3.5 py-3 text-left transition-colors ${
                    active
                      ? "border-emerald-500/50 bg-emerald-500/[0.08]"
                      : "border-zinc-800 bg-zinc-950/60 hover:border-zinc-700"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-zinc-500 tabular-nums">
                      Move {b.move_number} · {phaseDisplay(b.phase)}
                    </span>
                    <span className="flex items-center gap-1.5">
                      {resultChip(bGroup?.result)}
                      <ChevronRight
                        className={`h-3.5 w-3.5 shrink-0 ${active ? "text-emerald-400" : "text-zinc-600"}`}
                      />
                    </span>
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
                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-zinc-800/70 pt-2 text-[11px] text-zinc-500">
                    <span>
                      vs <span className="font-mono text-zinc-300">{b.opponent}</span>
                    </span>
                    {bDate && <span>{bDate}</span>}
                    {bGroup?.timeControl && (
                      <span>{timeControlDisplay(bGroup.timeControl)}</span>
                    )}
                    {bGroup?.eco && (
                      <span className="font-mono">{bGroup.eco}</span>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
          {visibleIndices.length === 0 && (
            <li className="rounded-lg border border-dashed border-zinc-800 px-4 py-6 text-center text-sm text-zinc-500">
              No blunders in this game.
            </li>
          )}
        </ol>

        {/* Board + controls */}
        <div
          onKeyDown={handleBoardKeyDown}
          tabIndex={navEnabled ? 0 : undefined}
          className="rounded-lg focus:outline-none"
        >
          {/* Game identity header / practice banner */}
          {positionMode ? (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.06] px-3.5 py-2.5">
              <p className="text-sm text-zinc-200">
                <span className="font-semibold text-emerald-300">Practicing:</span>{" "}
                {positionMode.label}
              </p>
              <button
                type="button"
                onClick={exitPositionMode}
                className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-600"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to game
              </button>
            </div>
          ) : (
            <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
              <span className="font-semibold text-zinc-100">
                vs <span className="font-mono">{blunder.opponent}</span>
              </span>
              {gameDate && <span className="text-zinc-400">{gameDate}</span>}
              {group?.timeControl && (
                <span className="text-zinc-400">
                  {timeControlDisplay(group.timeControl)}
                </span>
              )}
              {resultChip(group?.result)}
              {ecoLabel && (
                <span className="text-zinc-400">
                  {group?.eco && (
                    <span className="font-mono text-zinc-500">{group.eco} </span>
                  )}
                  {group?.ecoName ?? ""}
                </span>
              )}
              {group?.gameUrl && (
                <a
                  href={group.gameUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300"
                >
                  Original game
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          )}

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

          {/* Position readout */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-zinc-400 tabular-nums">
            {positionMode ? (
              <span>Practice position · {turn === "w" ? "White" : "Black"} to move</span>
            ) : (
              <>
                <span>
                  {ply === 0
                    ? "Starting position"
                    : `Move ${moveNumberForPly(ply)} · ${turn === "w" ? "White" : "Black"} to move`}
                </span>
                {readoutEval !== null && (
                  <span>
                    Eval{" "}
                    <span className="font-semibold text-zinc-100">
                      {formatEval(readoutEval)}
                    </span>
                  </span>
                )}
                {hasReplay && (
                  <span className="text-zinc-600">
                    {ply}/{totalPlies} plies
                  </span>
                )}
              </>
            )}
          </div>

          {/* Replay navigation */}
          {hasReplay && !positionMode && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-0.5 rounded-lg bg-zinc-950 p-1">
                <button
                  type="button"
                  disabled={!navEnabled}
                  onClick={() => goToPly(0)}
                  aria-label="First position"
                  className="rounded-md p-1.5 text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-40"
                >
                  <SkipBack className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  disabled={!navEnabled}
                  onClick={() => goToPly(ply - 1)}
                  aria-label="Previous move"
                  className="rounded-md p-1.5 text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-40"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  disabled={!navEnabled}
                  onClick={toggleAutoplay}
                  aria-label={isPlaying ? "Pause auto-play" : "Auto-play game"}
                  className="rounded-md p-1.5 text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-40"
                >
                  {isPlaying ? (
                    <Pause className="h-4 w-4" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                </button>
                <button
                  type="button"
                  disabled={!navEnabled}
                  onClick={() => goToPly(ply + 1)}
                  aria-label="Next move"
                  className="rounded-md p-1.5 text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-40"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  disabled={!navEnabled}
                  onClick={() => goToPly(totalPlies)}
                  aria-label="Last position"
                  className="rounded-md p-1.5 text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-40"
                >
                  <SkipForward className="h-4 w-4" />
                </button>
              </div>
              <button
                type="button"
                disabled={!navEnabled}
                onClick={() => {
                  goToPly(blunderPly);
                  setView("start");
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-700 disabled:opacity-40"
              >
                <Crosshair className="h-4 w-4" />
                Jump to blunder
              </button>
              <span className="hidden text-[11px] text-zinc-600 sm:inline">
                ← → keys step through the game
              </span>
            </div>
          )}

          {/* Eval chart */}
          {hasReplay && !positionMode && group?.evalSeries && group.evalSeries.length > 0 && (
            <div
              className={`mt-4 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 ${
                tryMode ? "pointer-events-none opacity-60" : ""
              }`}
            >
              <EvalChart
                series={group.evalSeries}
                currentPly={ply}
                totalPlies={totalPlies}
                blunderPlies={gameBlunderPlies.map((p) => p + 1)}
                swings={swings}
                onSelectPly={goToPly}
              />
            </div>
          )}

          {/* View controls */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {!positionMode && (
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
                    disabled={tryMode || !atBlunder}
                    title={
                      !atBlunder
                        ? "Available at the blunder position — use Jump to blunder"
                        : undefined
                    }
                    onClick={() => setView(opt.value)}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40 ${
                      view === opt.value && !tryMode && atBlunder
                        ? "bg-zinc-800 text-zinc-50 shadow"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}

            {(!positionMode && atBlunder) ||
            (positionMode && positionMode.bestMoveUci) ? (
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
            ) : null}

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
              (!positionMode || positionMode.bestMoveUci) && (
                <button
                  type="button"
                  onClick={enterTryMode}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-bold text-zinc-950 transition-colors hover:bg-emerald-400"
                >
                  Try it yourself
                </button>
              )
            )}
          </div>

          {/* Try-mode feedback */}
          {tryMode && (
            <div className="mt-3">
              {tryState === "success" ? (
                <p className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  Correct
                  {puzzle?.bestMoveUci && !positionMode && (
                    <>
                      {" "}
                      — <span className="font-mono">{blunder.best_move}</span>
                    </>
                  )}
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
                  {attempts >= 2 && hintTarget && (
                    <span className="inline-flex items-center gap-1 text-rose-200/90">
                      <Lightbulb className="h-3.5 w-3.5" />
                      Hint: the key move lands on{" "}
                      <span className="font-mono font-bold">{hintTarget}</span>
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
          {positionMode && !positionMode.bestMoveUci && !tryMode && (
            <p className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-400">
              No engine best move was stored for this position — study the
              position, then go back to the game for full context.
            </p>
          )}

          {/* Blunder details */}
          {!positionMode && (
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
                  vs{" "}
                  <span className="font-mono text-zinc-300">{blunder.opponent}</span>{" "}
                  as {blunder.player_color}
                </span>
                {gameDate && <span>{gameDate}</span>}
                {group?.gameUrl && (
                  <a
                    href={group.gameUrl}
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
          )}
        </div>

        {/* Move list */}
        {hasReplay && !positionMode && sanMoves.length > 0 && (
          <div className="lg:col-span-2 xl:col-span-1">
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">
                Moves
              </h3>
              <span className="font-mono text-[11px] text-zinc-600 tabular-nums">
                {sanMoves.length} half-moves
              </span>
            </div>
            <div
              ref={moveListRef}
              className="max-h-[560px] overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/60 py-1"
            >
              {moveRows.map((row) => (
                <div
                  key={row.n}
                  className="grid grid-cols-[2.5rem_1fr_1fr] items-stretch text-sm"
                >
                  <span className="px-2 py-1 text-right font-mono text-xs leading-6 text-zinc-600 tabular-nums">
                    {row.n}.
                  </span>
                  {(
                    [
                      { san: row.white, moveIndex: (row.n - 1) * 2 },
                      { san: row.black, moveIndex: (row.n - 1) * 2 + 1 },
                    ] as const
                  ).map(({ san, moveIndex }) => {
                    if (!san) return <span key={moveIndex} />;
                    const reachesPly = moveIndex + 1;
                    const isActive = ply === reachesPly;
                    const isBlunder = gameBlunderPlies.includes(moveIndex);
                    return (
                      <button
                        key={moveIndex}
                        type="button"
                        data-ply={reachesPly}
                        disabled={!navEnabled}
                        onClick={() => goToPly(reachesPly)}
                        className={`px-2 py-1 text-left font-mono tabular-nums transition-colors disabled:cursor-default ${
                          isActive
                            ? "bg-emerald-500/15 font-bold text-emerald-200"
                            : isBlunder
                              ? "font-semibold text-rose-300 hover:bg-zinc-800/70"
                              : "text-zinc-300 hover:bg-zinc-800/70"
                        }`}
                        title={isBlunder ? "Blunder — click to see it" : undefined}
                      >
                        {san}
                        {isBlunder && (
                          <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-rose-400 align-middle" />
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
              Click any move to jump there. Rose dots mark this game&apos;s
              blunders.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
