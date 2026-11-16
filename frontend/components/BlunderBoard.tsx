"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  ExternalLink,
  Eye,
  EyeOff,
  Flag,
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
import EvalBar from "./EvalBar";
import EvalChart from "./EvalChart";
import {
  evaluatePlayedMove,
  evaluatePosition,
  stopBrowserEngine,
  type MoveFeedback,
  type PositionEval,
} from "@/lib/engine";
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
import { useTheme } from "@/lib/theme";
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

/** Pawn-unit loss of a blunder from the user's perspective (stored evals
 *  are already user-perspective). */
function cpLossPawns(b: Blunder): number {
  return Math.max(0, (b.eval_before_cp - b.eval_after_cp) / 100);
}

/** Terminal status of a position, or null when the game continues. */
function gameOverStatus(fen: string): string | null {
  try {
    const game = new Chess(fen);
    if (game.isCheckmate()) {
      return game.turn() === "w" ? "Checkmate — Black wins" : "Checkmate — White wins";
    }
    if (game.isStalemate()) return "Stalemate — draw";
    if (game.isThreefoldRepetition()) return "Draw by threefold repetition";
    if (game.isInsufficientMaterial()) return "Draw — insufficient material";
    if (game.isDraw()) return "Draw";
  } catch {
    return null;
  }
  return null;
}

const AUTOPLAY_MS = 800;
const ENGINE_REPLY_DELAY_MS = 450;

interface SparringState {
  label: string;
  userColor: "w" | "b";
  startFen: string;
}

interface SparMove {
  san: string;
  uci: string;
  by: "user" | "engine";
  evalAfterCpWhite: number | null;
}

export default function BlunderBoard({
  blunders,
  practiceFocus,
}: BlunderBoardProps) {
  const { theme } = useTheme();
  const [gameFilterKey, setGameFilterKey] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [ply, setPly] = useState(0);
  const [view, setView] = useState<ViewMode>("start");
  const [showArrow, setShowArrow] = useState(false);
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

  // --- Try-it-yourself state (fixed v3 behavior: any legal move stands,
  // eval + why after the attempt, engine reply shown, best move is a hint,
  // never a gate). ---
  const [tryMode, setTryMode] = useState(false);
  const [tryAttemptFen, setTryAttemptFen] = useState<string | null>(null);
  const [tryFeedback, setTryFeedback] = useState<MoveFeedback | null>(null);
  const [tryPending, setTryPending] = useState(false);
  const [tryError, setTryError] = useState<string | null>(null);
  const [tryReply, setTryReply] = useState<PositionEval | null>(null);
  const [attempts, setAttempts] = useState(0);

  // --- Sparring state ("play vs Stockfish" from any position). ---
  const [sparring, setSparring] = useState<SparringState | null>(null);
  const [sparFen, setSparFen] = useState<string>(new Chess().fen());
  const [sparMoves, setSparMoves] = useState<SparMove[]>([]);
  const [sparEvalCpWhite, setSparEvalCpWhite] = useState<number | null>(null);
  const [sparBest, setSparBest] = useState<PositionEval | null>(null);
  const [sparThinking, setSparThinking] = useState(false);
  const [sparFeedback, setSparFeedback] = useState<MoveFeedback | null>(null);
  const [sparError, setSparError] = useState<string | null>(null);
  const [sparAutoplay, setSparAutoplay] = useState(false);
  const [sparOver, setSparOver] = useState<string | null>(null);
  /** Monotonic session id: async engine callbacks ignore stale sessions. */
  const sparSeq = useRef(0);

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
    setTryAttemptFen(null);
    setTryFeedback(null);
    setTryError(null);
    setTryReply(null);
    setAttempts(0);
    setAutoPlaying(false);
    // A new practice position ends any sparring line (same resets as
    // exitSparring, inline because this block runs during render).
    sparSeq.current += 1;
    stopBrowserEngine();
    setSparring(null);
    setSparMoves([]);
    setSparEvalCpWhite(null);
    setSparBest(null);
    setSparThinking(false);
    setSparFeedback(null);
    setSparError(null);
    setSparAutoplay(false);
    setSparOver(null);
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

  // Open on the first blunder position, not the starting position — the
  // user comes here to see where the game turned (render-time init, the
  // same documented pattern as the practice-focus block above).
  const plyInitRef = useRef(false);
  if (!plyInitRef.current && blunder && hasReplay) {
    plyInitRef.current = true;
    setPly(blunderPly);
  }

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

  const focusedGroup = gameFilterKey
    ? groups.find((g) => g.key === gameFilterKey)
    : undefined;

  // --- Sparring lifecycle ---
  const exitSparring = useCallback(() => {
    sparSeq.current += 1;
    stopBrowserEngine();
    setSparring(null);
    setSparMoves([]);
    setSparEvalCpWhite(null);
    setSparBest(null);
    setSparThinking(false);
    setSparFeedback(null);
    setSparError(null);
    setSparAutoplay(false);
    setSparOver(null);
  }, []);

  function enterSparring(fen: string, userColor: "w" | "b", label: string) {
    sparSeq.current += 1;
    const seq = sparSeq.current;
    setTryMode(false);
    setTryAttemptFen(null);
    setTryFeedback(null);
    setTryError(null);
    setTryReply(null);
    setAutoPlaying(false);
    setShowArrow(false);
    setSparring({ label, userColor, startFen: fen });
    setSparFen(fen);
    setSparMoves([]);
    setSparFeedback(null);
    setSparError(null);
    setSparAutoplay(false);
    setSparOver(gameOverStatus(fen));
    setSparThinking(false);
    setSparBest(null);
    // Seed the eval bar: one position eval, best effort. The engine-turn
    // effect below handles the reply when it's the engine's move.
    setSparEvalCpWhite(null);
    void evaluatePosition(fen)
      .then((ev) => {
        if (sparSeq.current !== seq) return;
        setSparEvalCpWhite(ev.evalCpWhite);
        setSparBest(ev);
      })
      .catch(() => {
        if (sparSeq.current !== seq) return;
        setSparError(
          "No engine available — the in-browser Stockfish failed to load and the backend engine endpoint is unreachable. Sparring needs one of them; replay and analysis above still work.",
        );
      });
  }

  // Engine-turn driver: whenever it's the engine's move (opponent's turn,
  // or autoplay where it plays both sides), ask the engine and play the
  // reply after a short delay so the user sees "Stockfish is thinking…".
  useEffect(() => {
    if (!sparring || sparOver || sparThinking || sparError) return;
    const turn = turnOf(sparFen);
    const engineTurn = sparAutoplay || turn !== sparring.userColor;
    if (!engineTurn) return;
    const seq = sparSeq.current;
    const fenAtStart = sparFen;
    const timer = setTimeout(() => {
      setSparThinking(true);
      void evaluatePosition(fenAtStart)
        .then(async (ev) => {
          if (sparSeq.current !== seq) return;
          const nextFen = applyUci(fenAtStart, ev.bestMoveUci);
          if (!nextFen) {
            setSparError("Stockfish suggested a move this board can't play — sparring stopped here.");
            setSparThinking(false);
            return;
          }
          const over = gameOverStatus(nextFen);
          // Eval of the resulting position (for the bar + move list).
          let evalAfter: number | null = null;
          let nextBest: PositionEval | null = null;
          try {
            nextBest = await evaluatePosition(nextFen);
            evalAfter = nextBest.evalCpWhite;
          } catch {
            // Keep the move; the bar just won't update this ply.
          }
          if (sparSeq.current !== seq) return;
          setSparMoves((moves) => [
            ...moves,
            { san: ev.bestMoveSan, uci: ev.bestMoveUci, by: "engine", evalAfterCpWhite: evalAfter },
          ]);
          setSparFen(nextFen);
          if (evalAfter !== null) setSparEvalCpWhite(evalAfter);
          if (nextBest) setSparBest(nextBest);
          setSparOver(over);
          setSparThinking(false);
        })
        .catch(() => {
          if (sparSeq.current !== seq) return;
          setSparError(
            "The engine stopped answering — the in-browser Stockfish and the backend endpoint are both unreachable. Your sparring line so far is kept below.",
          );
          setSparThinking(false);
        });
    }, ENGINE_REPLY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [sparring, sparFen, sparOver, sparThinking, sparError, sparAutoplay]);

  // Stop the browser engine when the board unmounts.
  useEffect(() => () => stopBrowserEngine(), []);

  // --- Selection / navigation ---
  function resetPuzzleState() {
    setView("start");
    setShowArrow(false);
    setTryMode(false);
    setTryAttemptFen(null);
    setTryFeedback(null);
    setTryError(null);
    setTryReply(null);
    setAttempts(0);
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
    exitSparring();
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
    exitSparring();
    setTryMode(true);
    setView("start");
    setTryAttemptFen(null);
    setTryFeedback(null);
    setTryError(null);
    setTryReply(null);
    setAttempts(0);
    setShowArrow(false);
    setAutoPlaying(false);
  }

  function exitTryMode() {
    setTryMode(false);
    setTryAttemptFen(null);
    setTryFeedback(null);
    setTryError(null);
    setTryReply(null);
    setTryPending(false);
  }

  function exitPositionMode() {
    setPositionMode(null);
    exitTryMode();
    setShowArrow(false);
  }

  // --- Replay navigation ---
  const navEnabled = hasReplay && !tryMode && !positionMode && !sparring;

  function goToPly(next: number) {
    if (tryMode || positionMode || sparring) return;
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
      <section className="rounded-xl border border-stone-200 bg-white p-5 sm:p-6 dark:border-zinc-800 dark:bg-zinc-900/50">
        <div className="flex items-center gap-2">
          <Swords className="h-4 w-4 text-stone-500 dark:text-zinc-400" />
          <h2 className="font-display text-lg font-bold text-stone-900 dark:text-zinc-50">
            Fix your blunders
          </h2>
        </div>
        <p className="mt-6 rounded-lg border border-dashed border-stone-300 px-4 py-8 text-center text-sm text-stone-500 dark:border-zinc-800 dark:text-zinc-500">
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

  // The puzzle being solved in try-it-yourself mode.
  const puzzle = tryMode
    ? positionMode
      ? { fen: positionMode.fen, bestMoveUci: positionMode.bestMoveUci }
      : { fen: blunder.fen, bestMoveUci: blunder.best_move_uci }
    : null;

  const displayFen = sparring
    ? sparFen
    : positionMode
      ? (tryAttemptFen ?? positionMode.fen)
      : tryMode && tryAttemptFen
        ? tryAttemptFen
        : tryMode && puzzle
          ? puzzle.fen
          : atBlunder && view === "played"
            ? (playedFen ?? anchorFen)
            : atBlunder && view === "best"
              ? (bestFen ?? anchorFen)
              : atBlunder
                ? anchorFen
                : fens[ply];

  const orientation: "white" | "black" = sparring
    ? sparring.userColor === "b"
      ? "black"
      : "white"
    : positionMode
      ? turnOf(positionMode.fen) === "b"
        ? "black"
        : "white"
      : blunder.player_color === "black"
        ? "black"
        : "white";

  const turn = turnOf(displayFen);

  // Arrows: best-move arrow (emerald) or played-move arrow (rose).
  const arrows: { startSquare: string; endSquare: string; color: string }[] = [];
  if (sparring) {
    // Hint arrow only on request — sparring is a game, not a puzzle.
    if (showArrow && sparBest) {
      const sq = uciSquares(sparBest.bestMoveUci);
      arrows.push({ startSquare: sq.from, endSquare: sq.to, color: "#34d399" });
    }
  } else if (positionMode) {
    if (positionMode.bestMoveUci && (tryAttemptFen || showArrow)) {
      const sq = uciSquares(positionMode.bestMoveUci);
      arrows.push({ startSquare: sq.from, endSquare: sq.to, color: "#34d399" });
    }
    if (tryReply && tryAttemptFen) {
      const sq = uciSquares(tryReply.bestMoveUci);
      arrows.push({ startSquare: sq.from, endSquare: sq.to, color: "#f59e0b" });
    }
  } else if (tryMode) {
    if (showArrow && blunder.best_move_uci) {
      const sq = uciSquares(blunder.best_move_uci);
      arrows.push({ startSquare: sq.from, endSquare: sq.to, color: "#34d399" });
    }
    if (tryReply && tryAttemptFen) {
      const sq = uciSquares(tryReply.bestMoveUci);
      arrows.push({ startSquare: sq.from, endSquare: sq.to, color: "#f59e0b" });
    }
  } else if (showArrow && atBlunder) {
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
  if (sparring) {
    const last = sparMoves[sparMoves.length - 1];
    if (last) {
      const sq = uciSquares(last.uci);
      const tint =
        last.by === "user"
          ? "rgba(52, 211, 153, 0.30)"
          : "rgba(250, 204, 21, 0.28)";
      squareStyles[sq.from] = { backgroundColor: tint };
      squareStyles[sq.to] = { backgroundColor: tint };
    }
  } else if (positionMode) {
    if (tryAttemptFen && tryFeedback) {
      const sq = uciSquares(tryFeedback.playedUci);
      const tint =
        tryFeedback.cpLossUser <= 30
          ? "rgba(52, 211, 153, 0.35)"
          : "rgba(251, 113, 133, 0.35)";
      squareStyles[sq.from] = { backgroundColor: tint };
      squareStyles[sq.to] = { backgroundColor: tint };
    }
  } else if (tryMode) {
    if (tryAttemptFen && tryFeedback) {
      const sq = uciSquares(tryFeedback.playedUci);
      const tint =
        tryFeedback.cpLossUser <= 30
          ? "rgba(52, 211, 153, 0.35)"
          : "rgba(251, 113, 133, 0.35)";
      squareStyles[sq.from] = { backgroundColor: tint };
      squareStyles[sq.to] = { backgroundColor: tint };
    }
  } else if (atBlunder && view !== "start") {
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

  // --- Try-it-yourself: any LEGAL move stands. Illegal moves snap back
  // (chess.js rejects them). After the attempt, eval + why + engine reply.
  async function handleTryDrop(
    sourceSquare: string,
    targetSquare: string,
  ): Promise<boolean> {
    if (!puzzle || tryFeedback || tryPending) return false;
    let move;
    let afterFen: string;
    try {
      const game = new Chess(puzzle.fen);
      move = game.move({ from: sourceSquare, to: targetSquare, promotion: "q" });
      afterFen = game.fen();
    } catch {
      return false; // illegal — snap back
    }
    const uci = move.from + move.to + (move.promotion ?? "");
    setTryAttemptFen(afterFen);
    setTryPending(true);
    setTryError(null);
    setAttempts((n) => n + 1);
    try {
      const fb = await evaluatePlayedMove(puzzle.fen, uci);
      setTryFeedback(fb);
      // Engine reply from the resulting position (best effort — the
      // feedback stands on its own if this fails).
      try {
        const reply = await evaluatePosition(afterFen);
        setTryReply(reply);
      } catch {
        // reply unavailable; feedback panel notes it
      }
    } catch {
      // Both engines unreachable: fall back to the stored analysis when
      // this puzzle is a known blunder, and say so honestly.
      if (!positionMode) {
        const whiteFactor = blunder.player_color === "black" ? -1 : 1;
        const matchesPlayed = uci === blunder.move_played_uci;
        const evalBeforeWhite = whiteFactor * blunder.eval_before_cp;
        const evalAfterWhite = matchesPlayed
          ? whiteFactor * blunder.eval_after_cp
          : evalBeforeWhite;
        setTryFeedback({
          fen: puzzle.fen,
          turn: turnOf(puzzle.fen),
          evalCpWhite: evalBeforeWhite,
          bestMoveUci: blunder.best_move_uci,
          bestMoveSan: blunder.best_move,
          pvSan: [],
          source: "backend",
          playedSan: move.san,
          playedUci: uci,
          evalBeforeCpWhite: evalBeforeWhite,
          evalAfterCpWhite: evalAfterWhite,
          cpLossUser: matchesPlayed
            ? Math.max(0, blunder.eval_before_cp - blunder.eval_after_cp)
            : 0,
          winProbDrop: matchesPlayed ? blunder.win_prob_drop : 0,
          tags: blunder.tags ?? [],
          primary: blunder.tag ?? null,
          explanations: [blunder.explanation],
          stored: true,
        });
        setTryError(
          "Live engine eval is unavailable right now, so this verdict uses the stored analysis from your diagnostic run.",
        );
      } else {
        setTryError(
          "Live engine eval is unavailable right now — the in-browser Stockfish failed to load and the backend engine endpoint is unreachable. The best-move hint still works.",
        );
      }
    } finally {
      setTryPending(false);
    }
    return true;
  }

  function retryTry() {
    setTryAttemptFen(null);
    setTryFeedback(null);
    setTryError(null);
    setTryReply(null);
    setShowArrow(false);
  }

  // --- Sparring: any LEGAL move stands; the engine replies automatically.
  async function handleSparDrop(
    sourceSquare: string,
    targetSquare: string,
  ): Promise<boolean> {
    if (!sparring || sparOver || sparThinking || sparAutoplay) return false;
    if (turnOf(sparFen) !== sparring.userColor) return false;
    const preFen = sparFen;
    let move;
    let afterFen: string;
    try {
      const game = new Chess(preFen);
      move = game.move({ from: sourceSquare, to: targetSquare, promotion: "q" });
      afterFen = game.fen();
    } catch {
      return false; // illegal — snap back
    }
    const uci = move.from + move.to + (move.promotion ?? "");
    const seq = sparSeq.current;
    // Optimistic board update: the move lands immediately; the eval
    // catches up below. Without this the piece snaps back for seconds
    // while the engine thinks.
    setSparThinking(true);
    setSparError(null);
    setSparFeedback(null);
    setSparMoves((moves) => [
      ...moves,
      { san: move.san, uci, by: "user", evalAfterCpWhite: null },
    ]);
    setSparFen(afterFen);
    setSparOver(gameOverStatus(afterFen));
    try {
      const fb = await evaluatePlayedMove(preFen, uci);
      if (sparSeq.current !== seq) return true;
      setSparFeedback(fb);
      setSparEvalCpWhite(fb.evalAfterCpWhite);
      setSparBest(null);
      setSparMoves((moves) =>
        moves.map((m, i) =>
          i === moves.length - 1
            ? { ...m, evalAfterCpWhite: fb.evalAfterCpWhite }
            : m,
        ),
      );
    } catch {
      if (sparSeq.current !== seq) return true;
      // Engine unreachable mid-game: the move stays on the board (it was
      // legal) and sparring stops here with an honest message.
      setSparError(
        "The engine stopped answering, so Stockfish can't reply — your move stands on the board. End sparring and try again, or keep the line as a record.",
      );
    } finally {
      if (sparSeq.current === seq) setSparThinking(false);
    }
    return true;
  }

  function handlePieceDrop({
    sourceSquare,
    targetSquare,
  }: {
    piece: { pieceType: string };
    sourceSquare: string;
    targetSquare: string | null;
  }): boolean {
    if (!targetSquare) return false;
    if (sparring) {
      void handleSparDrop(sourceSquare, targetSquare);
      // Return the legality verdict synchronously: re-check with chess.js
      // so illegal drags snap back immediately while the async eval runs.
      try {
        new Chess(sparFen).move({ from: sourceSquare, to: targetSquare, promotion: "q" });
        return true;
      } catch {
        return false;
      }
    }
    if (tryMode) {
      void handleTryDrop(sourceSquare, targetSquare);
      if (!puzzle) return false;
      try {
        new Chess(puzzle.fen).move({ from: sourceSquare, to: targetSquare, promotion: "q" });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  // Which color may be dragged: the side to move in try mode; the user's
  // color (on their turn) in sparring; nothing in replay.
  const draggableColor: "w" | "b" | null = sparring
    ? sparOver || sparThinking || sparAutoplay
      ? null
      : sparring.userColor
    : tryMode && !tryFeedback && !tryPending
      ? turnOf(puzzle?.fen ?? displayFen)
      : null;
  const allowDragging = draggableColor !== null;

  const hintTarget = puzzle?.bestMoveUci
    ? uciSquares(puzzle.bestMoveUci).to
    : null;
  const clock = formatClock(blunder.clock_seconds);
  const gameDate = formatGameDate(group?.gameDate);
  const ecoLabel = group?.ecoName ?? group?.eco ?? null;

  // Eval readout for the current position, from the USER's perspective so
  // it agrees with the detail panel. The series is White's perspective,
  // so flip it when the user played Black.
  const seriesEval = hasReplay ? evalAtPly(group?.evalSeries, ply) : null;
  const readoutEval =
    seriesEval !== null
      ? (blunder.player_color === "black" ? -seriesEval : seriesEval)
      : (atBlunder ? blunder.eval_before_cp : null);

  // Eval-bar inputs per mode (bar always shows White-perspective cp).
  const barEvalCpWhite = sparring
    ? sparEvalCpWhite
    : tryMode && tryFeedback
      ? tryFeedback.evalAfterCpWhite
      : tryMode && !positionMode
        ? (blunder.player_color === "black" ? -blunder.eval_before_cp : blunder.eval_before_cp)
        : positionMode
          ? null
          : seriesEval;
  const showEvalBar = barEvalCpWhite !== null || sparring;
  const userEvalLabel =
    barEvalCpWhite === null
      ? undefined
      : formatEval(
          (sparring ? sparring.userColor : blunder.player_color) === "black"
            ? -barEvalCpWhite
            : barEvalCpWhite,
        );

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

  // Board square colors follow the theme: warm wood on light, the classic
  // green/cream on dark.
  const squareColors =
    theme === "dark"
      ? { light: "#ebecd0", dark: "#739552" }
      : { light: "#f0d9b5", dark: "#b58863" };

  const resultChip = (result: GameGroup["result"]) => {
    if (!result) return null;
    const styles =
      result === "win"
        ? "border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
        : result === "loss"
          ? "border-rose-600/30 bg-rose-600/10 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300"
          : "border-stone-300 bg-stone-100 text-stone-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300";
    return (
      <span
        className={`rounded border px-1.5 py-px font-mono text-[11px] font-bold ${styles}`}
        title={result === "win" ? "Won" : result === "loss" ? "Lost" : "Drawn"}
      >
        {resultLetter(result)}
      </span>
    );
  };

  // Sparring move-list rows (SAN pairs) from the recorded line, starting
  // at the start position's move number / side to move.
  const sparRows: { n: number; white: string | null; black: string | null }[] = [];
  {
    let startTurn: "w" | "b" = "w";
    let startN = 1;
    try {
      const g = new Chess(sparring?.startFen ?? sparFen);
      startTurn = g.turn();
      startN = g.moveNumber();
    } catch {
      // fall back to move 1, White to move
    }
    let n = startN;
    let i = 0;
    if (startTurn === "b" && sparMoves.length > 0) {
      sparRows.push({ n, white: null, black: sparMoves[0].san });
      n += 1;
      i = 1;
    }
    for (; i < sparMoves.length; i += 2) {
      sparRows.push({
        n,
        white: sparMoves[i].san,
        black: sparMoves[i + 1]?.san ?? null,
      });
      n += 1;
    }
  }

  // --- Shared feedback panel: eval delta + best move + PV + WHY. Used by
  // try-it-yourself and sparring. Never invents a WHY: when the browser
  // engine answered (no classifier), it says the verdict is eval-only.
  function renderMoveFeedback(fb: MoveFeedback) {
    const moverIsBlack = fb.turn === "b";
    const before = moverIsBlack ? -fb.evalBeforeCpWhite : fb.evalBeforeCpWhite;
    const after = moverIsBlack ? -fb.evalAfterCpWhite : fb.evalAfterCpWhite;
    const delta = after - before;
    const verdict =
      fb.cpLossUser <= 30
        ? { label: "Good move", cls: "border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200" }
        : fb.cpLossUser <= 80
          ? { label: "Inaccuracy", cls: "border-amber-600/30 bg-amber-600/10 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200" }
          : fb.cpLossUser <= 150
            ? { label: "Mistake", cls: "border-orange-600/30 bg-orange-600/10 text-orange-700 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-200" }
            : { label: "Blunder", cls: "border-rose-600/30 bg-rose-600/10 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200" };
    return (
      <div className="rounded-lg border border-stone-200 bg-stone-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-stone-900 dark:text-zinc-100">
            You played <span className="font-mono">{fb.playedSan}</span>
          </span>
          {!fb.stored && (
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${verdict.cls}`}>
              {verdict.label}
            </span>
          )}
          {fb.primary && (
            <span className="rounded-full bg-stone-200 px-2 py-0.5 text-[11px] font-medium text-stone-700 dark:bg-zinc-800 dark:text-zinc-300">
              {tagLabel(fb.primary)}
            </span>
          )}
        </div>
        <p className="mt-2 font-mono text-sm tabular-nums text-stone-600 dark:text-zinc-400">
          Eval{" "}
          <span className="font-semibold text-stone-900 dark:text-zinc-100">{formatEval(before)}</span>
          {" → "}
          <span className={`font-semibold ${delta < -30 ? "text-rose-600 dark:text-rose-300" : "text-stone-900 dark:text-zinc-100"}`}>
            {formatEval(after)}
          </span>
          {delta !== 0 && (
            <span className={delta < 0 ? "text-rose-600 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-300"}>
              {" "}({delta > 0 ? "+" : ""}{(delta / 100).toFixed(2)}
              {fb.winProbDrop > 0 && `, win prob −${formatWinProbDrop(fb.winProbDrop)}`})
            </span>
          )}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-stone-700 dark:text-zinc-300">
          Best was <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-300">{fb.bestMoveSan}</span>
          {fb.pvSan.length > 1 && (
            <>
              {" "}— Stockfish&apos;s line:{" "}
              <span className="font-mono text-[13px]">{fb.pvSan.join(" ")}</span>
            </>
          )}
        </p>
        {fb.explanations.length > 0 ? (
          fb.explanations.slice(0, 2).map((ex, i) => (
            <p key={i} className="mt-2 text-sm leading-relaxed text-stone-600 dark:text-zinc-400">
              {ex}
            </p>
          ))
        ) : fb.source === "browser" ? (
          <p className="mt-2 text-sm leading-relaxed text-stone-500 dark:text-zinc-500">
            No classifier explanation for this one — the verdict above is
            eval-only (the backend engine endpoint didn&apos;t answer, so
            your browser&apos;s Stockfish evaluated it). The PV line is what
            Stockfish would play from here.
          </p>
        ) : (
          <p className="mt-2 text-sm leading-relaxed text-stone-500 dark:text-zinc-500">
            No classifier explanation was returned for this one — the eval
            and PV line above are what Stockfish says about the position.
          </p>
        )}
        {fb.tags.length > 1 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {fb.tags.map((t) => (
              <span
                key={t}
                className="rounded-full bg-stone-200 px-2 py-0.5 text-[11px] font-medium text-stone-700 dark:bg-zinc-800 dark:text-zinc-300"
              >
                {tagLabel(t)}
              </span>
            ))}
          </div>
        )}
        <p className="mt-3 font-mono text-[11px] text-stone-400 dark:text-zinc-600">
          {fb.stored
            ? "From the stored diagnostic analysis — live engine eval was unavailable."
            : fb.source === "browser"
              ? "Evaluated in your browser by Stockfish — no server load."
              : "Evaluated by the backend Stockfish + classifier."}
        </p>
      </div>
    );
  }

  const focusedTotalLoss = focusedGroup
    ? focusedGroup.blunderIndices.reduce((sum, i) => sum + cpLossPawns(blunders[i]), 0)
    : 0;

  return (
    <section
      id="game-replay"
      className="scroll-mt-6 rounded-xl border border-stone-200 bg-white p-3 sm:p-6 dark:border-zinc-800 dark:bg-zinc-900/50"
    >
      <div className="flex items-center gap-2">
        <Swords className="h-4 w-4 text-stone-500 dark:text-zinc-400" />
        <h2 className="font-display text-lg font-bold text-stone-900 dark:text-zinc-50">
          Fix your blunders
        </h2>
      </div>
      <p className="mt-1 text-sm text-stone-500 dark:text-zinc-500">
        Play through the full game, see where it turned, find the move
        Stockfish wanted — or play the position out against the engine.
      </p>

      {/* Game filter */}
      {groups.length > 1 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => selectGameFilter(null)}
            aria-pressed={gameFilterKey === null}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              gameFilterKey === null
                ? "border-emerald-600/50 bg-emerald-600/10 text-emerald-700 dark:border-emerald-500/60 dark:bg-emerald-500/10 dark:text-emerald-300"
                : "border-stone-300 bg-white text-stone-600 hover:border-stone-400 hover:text-stone-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-200"
            }`}
          >
            All games · {blunders.length}
          </button>
          {groups.map((g) => {
            const active = gameFilterKey === g.key;
            const date = formatGameDate(g.gameDate);
            const moveCount = g.movesSan ? Math.ceil(g.movesSan.length / 2) : null;
            return (
              <button
                key={g.key}
                type="button"
                onClick={() => selectGameFilter(g.key)}
                aria-pressed={active}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? "border-emerald-600/50 bg-emerald-600/10 text-emerald-700 dark:border-emerald-500/60 dark:bg-emerald-500/10 dark:text-emerald-300"
                    : "border-stone-300 bg-white text-stone-600 hover:border-stone-400 hover:text-stone-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-200"
                }`}
              >
                vs {g.opponent}
                {date && <span className="text-stone-400 dark:text-zinc-500">{date}</span>}
                {g.result && (
                  <span className="font-mono text-[11px] text-stone-500 dark:text-zinc-400">
                    {resultLetter(g.result)}
                  </span>
                )}
                {moveCount !== null && (
                  <span className="text-stone-400 dark:text-zinc-500">{moveCount} moves</span>
                )}
                <span className="font-mono text-[11px] text-stone-400 dark:text-zinc-500">
                  {g.blunderIndices.length}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Single-game view: every issue in the focused game at a glance. */}
      {focusedGroup && (
        <div className="mt-4 rounded-lg border border-emerald-600/25 bg-emerald-600/[0.05] p-4 dark:border-emerald-500/25 dark:bg-emerald-500/[0.06]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-stone-800 dark:text-zinc-200">
              <span className="font-semibold">One game:</span> vs{" "}
              <span className="font-mono">{focusedGroup.opponent}</span>
              {formatGameDate(focusedGroup.gameDate) && (
                <span className="text-stone-500 dark:text-zinc-400"> · {formatGameDate(focusedGroup.gameDate)}</span>
              )}
              {focusedGroup.timeControl && (
                <span className="text-stone-500 dark:text-zinc-400"> · {timeControlDisplay(focusedGroup.timeControl)}</span>
              )}{" "}
              {resultChip(focusedGroup.result)}
            </p>
            <button
              type="button"
              onClick={() => selectGameFilter(null)}
              className="inline-flex items-center gap-1.5 rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 transition-colors hover:border-stone-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-zinc-600"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              All games
            </button>
          </div>
          <p className="mt-1.5 text-[13px] text-stone-600 dark:text-zinc-400">
            {focusedGroup.blunderIndices.length} flagged{" "}
            {focusedGroup.blunderIndices.length === 1 ? "move" : "moves"} ·{" "}
            {focusedTotalLoss.toFixed(1)} pawns of eval lost across them
            {focusedGroup.ecoName ? ` · ${focusedGroup.ecoName}` : ""}
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {focusedGroup.blunderIndices.map((i) => {
              const b = blunders[i];
              const active = i === safeIdx;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => selectBlunder(i)}
                  aria-pressed={active}
                  className={`rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors ${
                    active
                      ? "border-emerald-600/50 bg-emerald-600/15 font-bold text-emerald-800 dark:border-emerald-500/60 dark:bg-emerald-500/15 dark:text-emerald-200"
                      : "border-stone-300 bg-white text-stone-600 hover:border-stone-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:border-zinc-700"
                  }`}
                  title={`${tagLabel(b.tag)} — ${formatEval(b.eval_before_cp)} → ${formatEval(b.eval_after_cp)}`}
                >
                  Move {b.move_number} · −{cpLossPawns(b).toFixed(1)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_264px]">
        {/* Blunder list — below the board on phones, left column on laptop+. */}
        <ol className="order-2 max-h-[340px] space-y-2 overflow-y-auto pr-1 lg:order-1 lg:max-h-[680px]">
          <li className="px-0.5 text-xs font-semibold tracking-wide text-stone-400 uppercase dark:text-zinc-500">
            {focusedGroup
              ? `Issues in this game · ${visibleIndices.length}`
              : `Worst mistakes · ${visibleIndices.length}`}
          </li>
          {visibleIndices.map((i) => {
            const b = blunders[i];
            const bGroup = groups.find((g) => g.blunderIndices.includes(i));
            const bDate = formatGameDate(bGroup?.gameDate);
            const active = i === safeIdx;
            return (
              <li key={`${b.fen}-${i}`}>
                <div
                  className={`flex items-stretch overflow-hidden rounded-lg border transition-colors ${
                    active
                      ? "border-emerald-600/50 bg-emerald-600/[0.07] dark:border-emerald-500/50 dark:bg-emerald-500/[0.08]"
                      : "border-stone-200 bg-stone-50/60 hover:border-stone-300 dark:border-zinc-800 dark:bg-zinc-950/60 dark:hover:border-zinc-700"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => selectBlunder(i)}
                    aria-current={active}
                    className="min-w-0 flex-1 px-3.5 py-3 text-left"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-stone-500 tabular-nums dark:text-zinc-500">
                        Move {b.move_number} · {phaseDisplay(b.phase)}
                      </span>
                      <span className="flex items-center gap-1.5">
                        {resultChip(bGroup?.result)}
                        <ChevronRight
                          className={`h-3.5 w-3.5 shrink-0 ${active ? "text-emerald-600 dark:text-emerald-400" : "text-stone-300 dark:text-zinc-600"}`}
                        />
                      </span>
                    </div>
                    <div className="mt-1.5 font-mono text-sm tabular-nums">
                      <span className="text-rose-600 dark:text-rose-300">{b.move_played}</span>
                      <span className="mx-1.5 text-stone-300 dark:text-zinc-600">→</span>
                      <span className="text-emerald-700 dark:text-emerald-300">{b.best_move}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <span className="rounded-full bg-stone-200 px-2 py-0.5 text-[11px] font-medium text-stone-700 dark:bg-zinc-800 dark:text-zinc-300">
                        {tagLabel(b.tag)}
                      </span>
                      <span className="font-mono text-[11px] text-stone-500 tabular-nums dark:text-zinc-500">
                        {formatEval(b.eval_before_cp)} →{" "}
                        {formatEval(b.eval_after_cp)}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-stone-200 pt-2 text-[11px] text-stone-500 dark:border-zinc-800/70 dark:text-zinc-500">
                      <span>
                        vs <span className="font-mono text-stone-700 dark:text-zinc-300">{b.opponent}</span>
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
                  <button
                    type="button"
                    onClick={() =>
                      enterSparring(
                        b.fen,
                        b.player_color === "black" ? "b" : "w",
                        `Blunder vs ${b.opponent}, move ${b.move_number}`,
                      )
                    }
                    title="Play this position vs Stockfish"
                    aria-label={`Play move ${b.move_number} vs ${b.opponent} against Stockfish`}
                    className="flex w-11 shrink-0 flex-col items-center justify-center gap-0.5 border-l border-stone-200 text-stone-500 transition-colors hover:bg-emerald-600/10 hover:text-emerald-700 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-300"
                  >
                    <Bot className="h-4 w-4" />
                    <span className="text-[10px] font-semibold">Play</span>
                  </button>
                </div>
              </li>
            );
          })}
          {visibleIndices.length === 0 && (
            <li className="rounded-lg border border-dashed border-stone-300 px-4 py-6 text-center text-sm text-stone-500 dark:border-zinc-800 dark:text-zinc-500">
              No blunders in this game.
            </li>
          )}
        </ol>

        {/* Board + controls — first on phones, middle column on laptop+. */}
        <div
          onKeyDown={handleBoardKeyDown}
          tabIndex={navEnabled ? 0 : undefined}
          className="order-1 rounded-lg focus:outline-none lg:order-2"
        >
          {/* Banners: sparring / practice / game identity */}
          {sparring ? (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-600/25 bg-emerald-600/[0.06] px-3.5 py-2.5 dark:border-emerald-500/25 dark:bg-emerald-500/[0.06]">
              <p className="text-sm text-stone-800 dark:text-zinc-200">
                <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700 dark:text-emerald-300">
                  <Bot className="h-4 w-4" />
                  Sparring vs Stockfish:
                </span>{" "}
                {sparring.label} · you play{" "}
                {sparring.userColor === "w" ? "White" : "Black"}
              </p>
              <button
                type="button"
                onClick={exitSparring}
                className="inline-flex items-center gap-1.5 rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 transition-colors hover:border-stone-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-zinc-600"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to analysis
              </button>
            </div>
          ) : positionMode ? (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-600/25 bg-emerald-600/[0.06] px-3.5 py-2.5 dark:border-emerald-500/25 dark:bg-emerald-500/[0.06]">
              <p className="text-sm text-stone-800 dark:text-zinc-200">
                <span className="font-semibold text-emerald-700 dark:text-emerald-300">Practicing:</span>{" "}
                {positionMode.label}
              </p>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() =>
                    enterSparring(
                      positionMode.fen,
                      turnOf(positionMode.fen),
                      positionMode.label,
                    )
                  }
                  className="inline-flex items-center gap-1.5 rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 transition-colors hover:border-stone-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-zinc-600"
                >
                  <Bot className="h-3.5 w-3.5" />
                  Play vs Stockfish
                </button>
                <button
                  type="button"
                  onClick={exitPositionMode}
                  className="inline-flex items-center gap-1.5 rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 transition-colors hover:border-stone-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-zinc-600"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back to game
                </button>
              </div>
            </div>
          ) : (
            <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
              <span className="font-semibold text-stone-900 dark:text-zinc-100">
                vs <span className="font-mono">{blunder.opponent}</span>
              </span>
              {gameDate && <span className="text-stone-500 dark:text-zinc-400">{gameDate}</span>}
              {group?.timeControl && (
                <span className="text-stone-500 dark:text-zinc-400">
                  {timeControlDisplay(group.timeControl)}
                </span>
              )}
              {resultChip(group?.result)}
              {ecoLabel && (
                <span className="text-stone-500 dark:text-zinc-400">
                  {group?.eco && (
                    <span className="font-mono text-stone-400 dark:text-zinc-500">{group.eco} </span>
                  )}
                  {group?.ecoName ?? ""}
                </span>
              )}
              {group?.gameUrl && (
                <a
                  href={group.gameUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-300"
                >
                  Original game
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          )}

          {/* Board + eval bar (the bar hides on phones — the numeric eval
              readout below carries the same information, and the board
              gets the full width). */}
          <div className="flex items-stretch gap-2 sm:gap-3">
            {showEvalBar && (
              <div className="hidden sm:flex">
                <EvalBar
                  evalCpWhite={barEvalCpWhite}
                  orientation={orientation}
                  userLabel={userEvalLabel}
                />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="mx-auto w-full max-w-[640px] overflow-hidden rounded-lg border border-stone-300 shadow-sm dark:border-zinc-800">
                <Chessboard
                  options={{
                    position: displayFen,
                    boardOrientation: orientation,
                    allowDragging,
                    canDragPiece: ({ piece }) =>
                      draggableColor !== null &&
                      piece.pieceType[0].toLowerCase() === draggableColor,
                    onPieceDrop: handlePieceDrop,
                    arrows,
                    squareStyles,
                    darkSquareStyle: { backgroundColor: squareColors.dark },
                    lightSquareStyle: { backgroundColor: squareColors.light },
                    allowDrawingArrows: false,
                    showNotation: true,
                    animationDurationInMs: 200,
                  }}
                />
              </div>
            </div>
          </div>

          {/* Position readout */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-stone-500 tabular-nums dark:text-zinc-400">
            {sparring ? (
              <>
                <span>
                  {sparOver
                    ? sparOver
                    : sparThinking
                      ? "Stockfish is thinking…"
                      : sparAutoplay
                        ? "Engine playing both sides…"
                        : turnOf(sparFen) === sparring.userColor
                          ? "Your move"
                          : "Stockfish to move"}
                </span>
                {sparEvalCpWhite !== null && (
                  <span>
                    Eval{" "}
                    <span className="font-semibold text-stone-900 dark:text-zinc-100">
                      {formatEval(
                        sparring.userColor === "b" ? -sparEvalCpWhite : sparEvalCpWhite,
                      )}
                    </span>
                    {" "}(you)
                  </span>
                )}
                <span className="text-stone-400 dark:text-zinc-600">
                  {sparMoves.length} {sparMoves.length === 1 ? "move" : "moves"} played
                </span>
              </>
            ) : tryMode ? (
              <>
                <span>
                  {tryAttemptFen
                    ? `Your attempt · ${turn === "w" ? "White" : "Black"} to move`
                    : `Try position · ${turn === "w" ? "White" : "Black"} to move`}
                </span>
                {tryFeedback && (
                  <span>
                    Eval{" "}
                    <span className="font-semibold text-stone-900 dark:text-zinc-100">
                      {formatEval(
                        (tryFeedback.turn === "b" ? -1 : 1) *
                          tryFeedback.evalAfterCpWhite,
                      )}
                    </span>
                  </span>
                )}
              </>
            ) : positionMode ? (
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
                    <span className="font-semibold text-stone-900 dark:text-zinc-100">
                      {formatEval(readoutEval)}
                    </span>
                  </span>
                )}
                {hasReplay && (
                  <span className="text-stone-400 dark:text-zinc-600">
                    {ply}/{totalPlies} plies
                  </span>
                )}
              </>
            )}
          </div>

          {/* Replay navigation */}
          {hasReplay && !positionMode && !sparring && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-0.5 rounded-lg bg-stone-100 p-1 dark:bg-zinc-950">
                <button
                  type="button"
                  disabled={!navEnabled}
                  onClick={() => goToPly(0)}
                  aria-label="First position"
                  className="rounded-md p-2 text-stone-700 transition-colors hover:bg-stone-200 disabled:opacity-40 sm:p-1.5 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  <SkipBack className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  disabled={!navEnabled}
                  onClick={() => goToPly(ply - 1)}
                  aria-label="Previous move"
                  className="rounded-md p-2 text-stone-700 transition-colors hover:bg-stone-200 disabled:opacity-40 sm:p-1.5 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  disabled={!navEnabled}
                  onClick={toggleAutoplay}
                  aria-label={isPlaying ? "Pause auto-play" : "Auto-play game"}
                  className="rounded-md p-2 text-stone-700 transition-colors hover:bg-stone-200 disabled:opacity-40 sm:p-1.5 dark:text-zinc-300 dark:hover:bg-zinc-800"
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
                  className="rounded-md p-2 text-stone-700 transition-colors hover:bg-stone-200 disabled:opacity-40 sm:p-1.5 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  disabled={!navEnabled}
                  onClick={() => goToPly(totalPlies)}
                  aria-label="Last position"
                  className="rounded-md p-2 text-stone-700 transition-colors hover:bg-stone-200 disabled:opacity-40 sm:p-1.5 dark:text-zinc-300 dark:hover:bg-zinc-800"
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
                className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 transition-colors hover:border-stone-400 disabled:opacity-40 sm:py-1.5 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-zinc-700"
              >
                <Crosshair className="h-4 w-4" />
                Jump to blunder
              </button>
              <button
                type="button"
                disabled={!navEnabled}
                onClick={() =>
                  enterSparring(
                    fens[ply],
                    blunder.player_color === "black" ? "b" : "w",
                    ply === 0
                      ? `vs ${blunder.opponent}, starting position`
                      : `vs ${blunder.opponent}, move ${moveNumberForPly(ply)}`,
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-bold text-white transition-colors hover:bg-emerald-500 disabled:opacity-40 sm:py-1.5 dark:bg-emerald-500 dark:text-zinc-950 dark:hover:bg-emerald-400"
              >
                <Bot className="h-4 w-4" />
                Play from here
              </button>
              <span className="hidden text-[11px] text-stone-400 lg:inline dark:text-zinc-600">
                ← → keys step through the game
              </span>
            </div>
          )}

          {/* Eval chart */}
          {hasReplay && !positionMode && !sparring && group?.evalSeries && group.evalSeries.length > 0 && (
            <div
              className={`mt-4 rounded-lg border border-stone-200 bg-stone-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-950/60 ${
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

          {/* Sparring controls */}
          {sparring && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={sparOver !== null}
                onClick={() => setShowArrow((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 transition-colors hover:border-stone-400 disabled:opacity-40 sm:py-1.5 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-zinc-700"
              >
                {showArrow ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                {showArrow ? "Hide hint" : "Show best move"}
              </button>
              <button
                type="button"
                disabled={sparOver !== null || sparError !== null}
                onClick={() => setSparAutoplay((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 transition-colors hover:border-stone-400 disabled:opacity-40 sm:py-1.5 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-zinc-700"
              >
                {sparAutoplay ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                {sparAutoplay ? "Stop engine" : "Engine plays on"}
              </button>
              <button
                type="button"
                disabled={sparOver !== null}
                onClick={() => {
                  stopBrowserEngine();
                  setSparAutoplay(false);
                  setSparThinking(false);
                  setSparOver("You resigned — Stockfish takes the sparring line.");
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 transition-colors hover:border-stone-400 disabled:opacity-40 sm:py-1.5 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-zinc-700"
              >
                <Flag className="h-4 w-4" />
                Resign
              </button>
              <button
                type="button"
                onClick={exitSparring}
                className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 transition-colors hover:border-stone-400 sm:py-1.5 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-zinc-700"
              >
                <RotateCcw className="h-4 w-4" />
                End sparring
              </button>
            </div>
          )}

          {/* Sparring error / game-over / feedback */}
          {sparring && sparError && (
            <p className="mt-3 flex items-center gap-2 rounded-lg border border-rose-600/30 bg-rose-600/10 px-3 py-2 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
              <XCircle className="h-4 w-4 shrink-0" />
              {sparError}
            </p>
          )}
          {sparring && sparOver && !sparError && (
            <p className="mt-3 flex items-center gap-2 rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 text-sm text-stone-700 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-300">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              {sparOver}
            </p>
          )}
          {sparring && sparFeedback && (
            <div className="mt-3">{renderMoveFeedback(sparFeedback)}</div>
          )}
          {sparring && sparThinking && !sparFeedback && sparMoves.length === 0 && (
            <p className="mt-3 animate-pulse rounded-lg border border-stone-200 bg-stone-50/70 px-3 py-2 text-sm text-stone-500 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-400">
              Stockfish is thinking…
            </p>
          )}

          {/* View controls (replay / try modes) */}
          {!sparring && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {!positionMode && (
                <div className="flex gap-1 rounded-lg bg-stone-100 p-1 dark:bg-zinc-950">
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
                          ? "bg-white text-stone-900 shadow dark:bg-zinc-800 dark:text-zinc-50"
                          : "text-stone-500 hover:text-stone-900 dark:text-zinc-400 dark:hover:text-zinc-200"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}

              {((!positionMode && atBlunder) ||
                (positionMode && positionMode.bestMoveUci)) && (
                <button
                  type="button"
                  onClick={() => setShowArrow((v) => !v)}
                  title={tryMode ? "Hint — show the engine move" : undefined}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 transition-colors hover:border-stone-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-zinc-700"
                >
                  {showArrow ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                  {showArrow ? "Hide arrow" : "Show best move"}
                </button>
              )}

              {tryMode ? (
                <>
                  <button
                    type="button"
                    onClick={exitTryMode}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 transition-colors hover:border-stone-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-zinc-700"
                  >
                    <RotateCcw className="h-4 w-4" />
                    Exit practice
                  </button>
                  {tryFeedback && (
                    <button
                      type="button"
                      onClick={retryTry}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 transition-colors hover:border-stone-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-zinc-700"
                    >
                      <RotateCcw className="h-4 w-4" />
                      Try again
                    </button>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  onClick={enterTryMode}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-bold text-white transition-colors hover:bg-emerald-500 dark:bg-emerald-500 dark:text-zinc-950 dark:hover:bg-emerald-400"
                >
                  Try it yourself
                </button>
              )}
            </div>
          )}

          {/* Try-mode feedback: any legal move stands; eval + why + reply. */}
          {tryMode && !sparring && (
            <div className="mt-3 space-y-3">
              {tryPending && !tryFeedback && (
                <p className="animate-pulse rounded-lg border border-stone-200 bg-stone-50/70 px-3 py-2 text-sm text-stone-500 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-400">
                  Evaluating your move…
                </p>
              )}
              {tryError && (
                <p className="flex items-start gap-2 rounded-lg border border-amber-600/30 bg-amber-600/10 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                  <Lightbulb className="mt-0.5 h-4 w-4 shrink-0" />
                  {tryError}
                </p>
              )}
              {tryFeedback && renderMoveFeedback(tryFeedback)}
              {tryFeedback && tryReply && (
                <p className="rounded-lg border border-stone-200 bg-stone-50/70 px-3 py-2 text-sm text-stone-600 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-400">
                  <span className="font-medium text-stone-900 dark:text-zinc-100">
                    Stockfish would reply {tryReply.bestMoveSan}
                  </span>{" "}
                  (amber arrow) — eval{" "}
                  <span className="font-mono">
                    {formatEval(
                      (tryFeedback.turn === "b" ? -1 : 1) * tryReply.evalCpWhite,
                    )}
                  </span>{" "}
                  from your side.{" "}
                  <button
                    type="button"
                    onClick={() =>
                      tryAttemptFen &&
                      enterSparring(
                        tryAttemptFen,
                        tryFeedback.turn,
                        `After ${tryFeedback.playedSan} — play it out`,
                      )
                    }
                    className="font-medium text-emerald-700 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-300"
                  >
                    Play on vs Stockfish →
                  </button>
                </p>
              )}
              {!tryFeedback && !tryPending && (
                <p className="rounded-lg border border-stone-200 bg-stone-50/70 px-3 py-2 text-sm text-stone-500 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-400">
                  Drag a piece to play any legal move — it stays on the board,
                  and Stockfish tells you what it cost and why. Use{" "}
                  <span className="font-medium text-stone-700 dark:text-zinc-200">Show best move</span>{" "}
                  for a hint, not a gate.
                  {attempts >= 2 && hintTarget && (
                    <span className="inline-flex items-center gap-1">
                      <Lightbulb className="h-3.5 w-3.5" />
                      Hint: the key move lands on{" "}
                      <span className="font-mono font-bold">{hintTarget}</span>
                    </span>
                  )}
                </p>
              )}
            </div>
          )}
          {positionMode && !positionMode.bestMoveUci && !tryMode && (
            <p className="mt-3 rounded-lg border border-stone-200 bg-stone-50/70 px-3 py-2 text-sm text-stone-500 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-400">
              No engine best move was stored for this position — try any move
              and the live engine will judge it, or play it out vs Stockfish.
            </p>
          )}

          {/* Blunder details */}
          {!positionMode && !sparring && (
            <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-sm tabular-nums">
                <span className="text-stone-500 dark:text-zinc-400">
                  Eval{" "}
                  <span className="text-stone-900 dark:text-zinc-100">
                    {formatEval(blunder.eval_before_cp)}
                  </span>{" "}
                  →{" "}
                  <span className="text-rose-600 dark:text-rose-300">
                    {formatEval(blunder.eval_after_cp)}
                  </span>
                </span>
                <span className="text-stone-500 dark:text-zinc-400">
                  Win prob{" "}
                  <span className="font-bold text-rose-600 dark:text-rose-300">
                    −{formatWinProbDrop(blunder.win_prob_drop)}
                  </span>
                </span>
                {clock && (
                  <span className="inline-flex items-center gap-1 text-stone-500 dark:text-zinc-400">
                    <Timer className="h-3.5 w-3.5" />
                    {clock} left
                  </span>
                )}
              </div>

              <p className="mt-2.5 text-sm leading-relaxed text-stone-700 dark:text-zinc-300">
                {blunder.explanation}
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {blunder.tags.map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-stone-200 px-2 py-0.5 text-[11px] font-medium text-stone-700 dark:bg-zinc-800 dark:text-zinc-300"
                  >
                    {tagLabel(t)}
                  </span>
                ))}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-stone-200 pt-3 dark:border-zinc-800/80">
                <button
                  type="button"
                  onClick={() =>
                    enterSparring(
                      blunder.fen,
                      blunder.player_color === "black" ? "b" : "w",
                      `Blunder vs ${blunder.opponent}, move ${blunder.move_number}`,
                    )
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-bold text-white transition-colors hover:bg-emerald-500 dark:bg-emerald-500 dark:text-zinc-950 dark:hover:bg-emerald-400"
                >
                  <Bot className="h-4 w-4" />
                  Play from this blunder
                </button>
                <span className="text-xs text-stone-500 dark:text-zinc-500">
                  vs{" "}
                  <span className="font-mono text-stone-700 dark:text-zinc-300">{blunder.opponent}</span>{" "}
                  as {blunder.player_color}
                </span>
                {gameDate && <span className="text-xs text-stone-500 dark:text-zinc-500">{gameDate}</span>}
                {group?.gameUrl && (
                  <a
                    href={group.gameUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-300"
                  >
                    View full game
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>

              <p className="mt-3 font-mono text-[11px] leading-relaxed break-all text-stone-400 dark:text-zinc-600">
                {blunder.fen}
              </p>
            </div>
          )}
        </div>

        {/* Move list (replay) or sparring line */}
        {sparring ? (
          <div className="order-3 lg:col-span-2 xl:col-span-1">
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="text-xs font-semibold tracking-wide text-stone-400 uppercase dark:text-zinc-400">
                Sparring line
              </h3>
              <span className="font-mono text-[11px] text-stone-400 tabular-nums dark:text-zinc-600">
                {sparMoves.length} half-moves
              </span>
            </div>
            <div className="max-h-[560px] overflow-y-auto rounded-lg border border-stone-200 bg-stone-50/70 py-1 dark:border-zinc-800 dark:bg-zinc-950/60">
              {sparRows.length === 0 ? (
                <p className="px-3 py-3 text-sm text-stone-500 dark:text-zinc-500">
                  No moves yet — drag a piece to make your move.
                </p>
              ) : (
                sparRows.map((row) => (
                  <div
                    key={row.n}
                    className="grid grid-cols-[2.5rem_1fr_1fr] items-stretch text-sm"
                  >
                    <span className="px-2 py-1 text-right font-mono text-xs leading-6 text-stone-400 tabular-nums dark:text-zinc-600">
                      {row.n}.
                    </span>
                    <span className="px-2 py-1 font-mono text-stone-800 tabular-nums dark:text-zinc-300">
                      {row.white ?? ""}
                    </span>
                    <span className="px-2 py-1 font-mono text-stone-800 tabular-nums dark:text-zinc-300">
                      {row.black ?? ""}
                    </span>
                  </div>
                ))
              )}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-stone-400 dark:text-zinc-600">
              Engine replies run in your browser when possible, so sparring
              stays fast and off the server. Every move you play gets an
              eval verdict above.
            </p>
          </div>
        ) : (
          hasReplay &&
          !positionMode &&
          sanMoves.length > 0 && (
            <div className="order-3 lg:col-span-2 xl:col-span-1">
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="text-xs font-semibold tracking-wide text-stone-400 uppercase dark:text-zinc-400">
                  Moves
                </h3>
                <span className="font-mono text-[11px] text-stone-400 tabular-nums dark:text-zinc-600">
                  {sanMoves.length} half-moves
                </span>
              </div>
              <div
                ref={moveListRef}
                className="max-h-[560px] overflow-y-auto rounded-lg border border-stone-200 bg-stone-50/70 py-1 dark:border-zinc-800 dark:bg-zinc-950/60"
              >
                {moveRows.map((row) => (
                  <div
                    key={row.n}
                    className="grid grid-cols-[2.5rem_1fr_1fr] items-stretch text-sm"
                  >
                    <span className="px-2 py-1 text-right font-mono text-xs leading-6 text-stone-400 tabular-nums dark:text-zinc-600">
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
                              ? "bg-emerald-600/15 font-bold text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200"
                              : isBlunder
                                ? "font-semibold text-rose-600 hover:bg-stone-200/70 dark:text-rose-300 dark:hover:bg-zinc-800/70"
                                : "text-stone-700 hover:bg-stone-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800/70"
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
              <p className="mt-2 text-[11px] leading-relaxed text-stone-400 dark:text-zinc-600">
                Click any move to jump there. Rose dots mark this game&apos;s
                blunders.
              </p>
            </div>
          )
        )}
      </div>
    </section>
  );
}
