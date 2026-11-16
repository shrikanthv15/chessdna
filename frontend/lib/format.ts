/** Display helpers: evals, percentages, clocks, blind-spot labels. */

import type { BlindSpot, GameResult } from "./types";

/** Fallback labels if the API ever omits `label` on a blind spot. */
export const TAG_LABELS: Record<string, string> = {
  abandoned_defender: "Abandoned Defender",
  backward_or_long_range_blindness: "Long-Range / Backward Blindness",
  missed_opponent_threat: "Missed Opponent Threat",
  hope_chess_hanging_piece: "Hope Chess (Hanging Piece)",
  time_scramble_panic: "Time Scramble Panic",
  conversion_collapse: "Conversion Collapse",
};

/** snake_case tag → Title Case, so new backend tags render sensibly without
 *  a frontend change: "knight_fork_blindness" → "Knight Fork Blindness". */
export function humanizeTag(tag: string): string {
  return tag
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function tagLabel(tag: string, label?: string): string {
  if (label) return label;
  return TAG_LABELS[tag] ?? humanizeTag(tag);
}

/** The headline leak: the backend's top tag resolved against the breakdown.
 *  Never "unclassified", never "none" — falls back to the largest classified
 *  bucket when the tag can't be resolved, and undefined when no classified
 *  pattern exists at all. */
export function topClassifiedSpot(
  spots: BlindSpot[] | undefined,
  topTag: string | undefined,
): BlindSpot | undefined {
  const classified = (spots ?? []).filter((s) => s.tag !== "unclassified");
  return (
    (topTag && topTag !== "none"
      ? classified.find((s) => s.tag === topTag)
      : undefined) ??
    [...classified].sort((a, b) => b.pct - a.pct)[0]
  );
}

/**
 * Centipawns → pawn units with sign, e.g. +1.25 / -0.40 / +0.00.
 * Scores with |cp| >= 9000 are mate scores: the backend encodes mate as
 * 10000 - mateDistance (MATE_CP=10000 in analyzer/engine.py).
 */
export function formatEval(cp: number): string {
  if (Math.abs(cp) >= 9000) {
    const mateIn = Math.max(1, 10000 - Math.abs(cp));
    return cp > 0 ? `#${mateIn}` : `#-${mateIn}`;
  }
  const pawns = cp / 100;
  const sign = pawns > 0 ? "+" : pawns < 0 ? "-" : "";
  return `${sign}${Math.abs(pawns).toFixed(2)}`;
}

/** Win-probability drop: accepts a fraction (0–1) or percentage points (0–100). */
export function formatWinProbDrop(drop: number): string {
  const pct = drop <= 1 ? drop * 100 : drop;
  return `${pct.toFixed(0)}%`;
}

export function formatPct(value: number, digits = 0): string {
  return `${value.toFixed(digits)}%`;
}

export function formatClock(seconds: number | null): string | null {
  if (seconds === null || seconds === undefined) return null;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Game date, short form: "Nov 14, 2026". Null-safe — returns null when the
 *  backend sent no date (or an unparseable one). */
export function formatGameDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function resultLabel(result: GameResult): string {
  return result === "win" ? "Win" : result === "loss" ? "Loss" : "Draw";
}

/** Single-letter result marker (W/L/D) from the user's perspective. */
export function resultLetter(result: GameResult): string {
  return result === "win" ? "W" : result === "loss" ? "L" : "D";
}

export function platformDisplay(platform: string): string {
  return platform === "lichess" ? "Lichess" : "Chess.com";
}

export function timeControlDisplay(tc: string): string {
  const map: Record<string, string> = {
    all: "All time controls",
    rapid: "Rapid",
    blitz: "Blitz",
    bullet: "Bullet",
  };
  return map[tc] ?? tc;
}

export function phaseDisplay(phase: string): string {
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}
