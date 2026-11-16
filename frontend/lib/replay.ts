/** Pure helpers for full-game replay: FEN lists, blunder-ply detection,
 *  game grouping, eval-series lookups and swing detection.
 *
 *  Everything here is DOM-free so it can be exercised from node against a
 *  fixture. All functions degrade gracefully when the v2 contract fields
 *  (moves_uci/moves_san/eval_series/game_id/...) are absent.
 */
import { Chess } from "chess.js";
import type { Blunder, EvalPoint, GameResult } from "./types";

/** Clamp for chart display and swing math: mate scores (±10000) collapse. */
export const EVAL_CLAMP_CP = 1000;

export function clampCp(cp: number, limit = EVAL_CLAMP_CP): number {
  return Math.max(-limit, Math.min(limit, cp));
}

/** FEN identity for matching: board + turn + castling + en passant only.
 *  Halfmove/fullmove counters differ between producers for the same position. */
export function fenKey(fen: string): string {
  return fen.trim().split(/\s+/).slice(0, 4).join(" ");
}

/**
 * FEN for every ply of a game: index 0 is the starting position, index N is
 * the position after N half-moves. Prefers UCI moves, falls back to SAN.
 * Stops at the first illegal/unparseable move — the list is then shorter
 * than the move list, and callers must clamp to `fens.length - 1`.
 */
export function buildFenList(
  movesUci: string[] | undefined,
  movesSan: string[] | undefined,
): string[] {
  const game = new Chess();
  const fens = [game.fen()];
  const uci = movesUci && movesUci.length > 0 ? movesUci : null;
  const san = movesSan && movesSan.length > 0 ? movesSan : null;
  if (uci) {
    for (const move of uci) {
      try {
        game.move({
          from: move.slice(0, 2),
          to: move.slice(2, 4),
          promotion: move.length > 4 ? move[4] : undefined,
        });
        fens.push(game.fen());
      } catch {
        break;
      }
    }
  } else if (san) {
    for (const move of san) {
      try {
        game.move(move);
        fens.push(game.fen());
      } catch {
        break;
      }
    }
  }
  return fens;
}

/** Ply index (0-based) of a move from its fullmove number + mover's color:
 *  White's move N is ply (N-1)*2, Black's is (N-1)*2+1. */
export function blunderPlyFromMove(
  moveNumber: number,
  playerColor: string,
): number {
  return (Math.max(1, moveNumber) - 1) * 2 + (playerColor === "black" ? 1 : 0);
}

/**
 * Locate the blunder's pre-move position inside a FEN list: prefer an exact
 * FEN match (robust to any move-number convention), else the ply computed
 * from move number + color, clamped into range.
 */
export function findBlunderPly(
  fens: string[],
  blunderFen: string,
  fallbackPly: number,
): number {
  const key = fenKey(blunderFen);
  const match = fens.findIndex((f) => fenKey(f) === key);
  if (match >= 0) return match;
  return Math.max(0, Math.min(fallbackPly, fens.length - 1));
}

/** Eval (cp, White's perspective) at a ply: the nearest series entry at or
 *  before that ply, or null when the series is missing/empty. */
export function evalAtPly(
  series: EvalPoint[] | undefined,
  ply: number,
): number | null {
  if (!series || series.length === 0) return null;
  let best: EvalPoint | null = null;
  for (const p of series) {
    if (p.ply <= ply && (best === null || p.ply >= best.ply)) best = p;
  }
  return best ? best.cp : null;
}

export interface EvalSwing {
  /** Ply where the swing landed (position after the swinging move). */
  ply: number;
  /** Signed swing in clamped centipawns, from the user's perspective. */
  deltaCp: number;
}

/**
 * Biggest single-ply eval swings from the USER's perspective: `gain` is the
 * largest swing toward the user ("the win was here"), `loss` the largest
 * swing against them ("lost here"). Computed on clamped values so mate
 * scores can't dominate. Nulls when the series has fewer than 2 points.
 */
export function computeSwings(
  series: EvalPoint[] | undefined,
  playerColor: string,
): { gain: EvalSwing | null; loss: EvalSwing | null } {
  if (!series || series.length < 2) return { gain: null, loss: null };
  const sorted = [...series].sort((a, b) => a.ply - b.ply);
  const sign = playerColor === "black" ? -1 : 1;
  let gain: EvalSwing | null = null;
  let loss: EvalSwing | null = null;
  for (let i = 1; i < sorted.length; i++) {
    const delta =
      sign * clampCp(sorted[i].cp) - sign * clampCp(sorted[i - 1].cp);
    if (delta > 0 && (gain === null || delta > gain.deltaCp)) {
      gain = { ply: sorted[i].ply, deltaCp: delta };
    }
    if (delta < 0 && (loss === null || delta < loss.deltaCp)) {
      loss = { ply: sorted[i].ply, deltaCp: delta };
    }
  }
  return { gain, loss };
}

export interface GameGroup {
  key: string;
  opponent: string;
  gameDate: string | null;
  timeControl: string | undefined;
  result: GameResult | undefined;
  eco: string | null;
  ecoName: string | null;
  gameUrl: string | null;
  playerColor: string;
  /** Indices into the original blunders array, in ranked order. */
  blunderIndices: number[];
  movesSan: string[] | undefined;
  movesUci: string[] | undefined;
  evalSeries: EvalPoint[] | undefined;
}

/** Grouping key: stable game id first, then the game URL, then a unique key
 *  per blunder (never merge two games we can't prove are the same). */
function gameKey(blunder: Blunder, index: number): string {
  if (blunder.game_id) return `id:${blunder.game_id}`;
  if (blunder.game_url) return `url:${blunder.game_url}`;
  return `single:${index}`;
}

/** Group blunders by game, preserving ranked order inside each group and
 *  first-seen order of the groups. */
export function groupBlundersByGame(blunders: Blunder[]): GameGroup[] {
  const groups = new Map<string, GameGroup>();
  blunders.forEach((b, index) => {
    const key = gameKey(b, index);
    const existing = groups.get(key);
    if (existing) {
      existing.blunderIndices.push(index);
      if (!existing.movesUci && b.moves_uci) existing.movesUci = b.moves_uci;
      if (!existing.movesSan && b.moves_san) existing.movesSan = b.moves_san;
      if (!existing.evalSeries && b.eval_series) existing.evalSeries = b.eval_series;
      return;
    }
    groups.set(key, {
      key,
      opponent: b.opponent,
      gameDate: b.game_date ?? null,
      timeControl: b.time_control,
      result: b.result,
      eco: b.eco ?? null,
      ecoName: b.eco_name ?? null,
      gameUrl: b.game_url ?? null,
      playerColor: b.player_color,
      blunderIndices: [index],
      movesSan: b.moves_san,
      movesUci: b.moves_uci,
      evalSeries: b.eval_series,
    });
  });
  return [...groups.values()];
}

/** Fullmove number for a ply (plies are half-moves played so far). */
export function moveNumberForPly(ply: number): number {
  return Math.floor((ply + 1) / 2);
}
