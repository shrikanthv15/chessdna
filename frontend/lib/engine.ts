/** Engine access for sparring + try-it-yourself: one orchestrator over two
 *  engines, so the UI never cares which one answered.
 *
 *  - Backend /api/position (v3): eval + best move + PV + the classifier's
 *    plain-language WHY for a played move. Preferred for played-move
 *    feedback, because only the backend can name the thinking habit.
 *  - In-browser Stockfish (lib/browserEngine.ts): eval + best + PV, no
 *    classifier. Preferred for engine replies and autoplay, because it
 *    takes that compute off the VPS entirely and answers with no
 *    round-trip. Fallback for played-move feedback when the backend is
 *    absent (v2) or unreachable — the feedback then shows eval + best +
 *    PV with an honest note instead of classifier explanations.
 *
 *  Every function degrades: when both engines fail, the caller gets a
 *  thrown error and must show an honest message (sparring disabled, the
 *  rest of the UI keeps working).
 */
import { Chess } from "chess.js";
import { postPosition } from "./api";
import { browserEngine, type BrowserEval } from "./browserEngine";
import type { PositionResponse } from "./types";

/** Sparring/try-mode engine depth: the /api/position contract default. */
export const SPAR_DEPTH = 16;

/** Win probability (0–100) from centipawns, White's perspective — the same
 *  logistic curve the backend uses (analyzer win-probability model). */
export function winProbWhite(cp: number): number {
  if (Math.abs(cp) >= 9000) return cp > 0 ? 100 : 0;
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/** White's share of the eval bar (0–100) for a White-perspective cp score. */
export function evalToWhiteShare(cp: number): number {
  return Math.max(0, Math.min(100, winProbWhite(cp)));
}

/** Centipawn loss of a move from the mover's perspective: positive means
 *  the mover got worse. `evalBefore`/`evalAfter` are White-perspective. */
export function cpLossForMover(
  evalBeforeCpWhite: number,
  evalAfterCpWhite: number,
  moverColor: "w" | "b",
): number {
  const before = moverColor === "w" ? evalBeforeCpWhite : -evalBeforeCpWhite;
  const after = moverColor === "w" ? evalAfterCpWhite : -evalAfterCpWhite;
  return Math.max(0, before - after);
}

export type EngineSource = "backend" | "browser";

/** Normalized single-position answer, whichever engine produced it. */
export interface PositionEval {
  fen: string;
  turn: "w" | "b";
  evalCpWhite: number;
  bestMoveUci: string;
  bestMoveSan: string;
  pvSan: string[];
  source: EngineSource;
}

/** Normalized feedback for a move the user just played. `tags` /
 *  `explanations` are empty when the browser engine answered (no
 *  classifier) — the UI must not invent a WHY it doesn't have. */
export interface MoveFeedback extends PositionEval {
  playedSan: string;
  playedUci: string;
  evalBeforeCpWhite: number;
  evalAfterCpWhite: number;
  cpLossUser: number;
  winProbDrop: number;
  tags: string[];
  primary: string | null;
  explanations: string[];
  /** True when the feedback came from the stored analysis (engine
   *  unreachable) rather than a live engine call — the UI says so. */
  stored?: boolean;
}

function fromBackend(res: PositionResponse, source: EngineSource): PositionEval {
  return {
    fen: res.fen,
    turn: res.turn,
    evalCpWhite: res.eval_cp_white,
    bestMoveUci: res.best_move_uci,
    bestMoveSan: res.best_move_san,
    pvSan: res.pv_san ?? [],
    source,
  };
}

function fromBrowser(fen: string, ev: BrowserEval): PositionEval {
  return {
    fen,
    turn: new Chess(fen).turn(),
    evalCpWhite: ev.evalCpWhite,
    bestMoveUci: ev.bestMoveUci,
    bestMoveSan: ev.bestMoveSan,
    pvSan: ev.pvSan,
    source: "browser",
  };
}

/** Evaluate a position (no move played): browser engine first, backend
 *  fallback. Used for engine replies, autoplay, and initial sparring eval. */
export async function evaluatePosition(
  fen: string,
  depth: number = SPAR_DEPTH,
): Promise<PositionEval> {
  try {
    const ev = await browserEngine.evaluate(fen, depth);
    return fromBrowser(fen, ev);
  } catch {
    // Browser engine unavailable — fall through to the backend.
  }
  const res = await postPosition({ fen, move_uci: null, depth });
  return fromBackend(res, "backend");
}

/** Normalize classifier explanations to an array, primary tag first.
 *  The backend returns a dict keyed by tag; older/stub shapes may return
 *  a list. Anything else yields []. */
function normalizeExplanations(
  explanations: string[] | Record<string, string> | undefined,
  tags: string[],
  primary: string | null,
): string[] {
  if (!explanations) return [];
  if (Array.isArray(explanations)) return explanations;
  const ordered = [
    ...(primary ? [primary] : []),
    ...tags.filter((t) => t !== primary),
    ...Object.keys(explanations),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of ordered) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    const text = explanations[tag];
    if (typeof text === "string" && text.length > 0) out.push(text);
  }
  return out;
}

/** Feedback for a move the user played from `fen`: backend first (it alone
 *  has the classifier WHY); browser-engine fallback computes the eval
 *  delta from two position evals. */
export async function evaluatePlayedMove(
  fen: string,
  moveUci: string,
  depth: number = SPAR_DEPTH,
): Promise<MoveFeedback> {
  try {
    const res = await postPosition({ fen, move_uci: moveUci, depth });
    const base = fromBackend(res, "backend");
    const played = res.played;
    if (played) {
      return {
        ...base,
        playedSan: played.move_san,
        playedUci: played.move_uci,
        evalBeforeCpWhite: res.eval_cp_white,
        evalAfterCpWhite: played.eval_after_cp_white,
        cpLossUser: played.cp_loss_user,
        winProbDrop: played.win_prob_drop,
        tags: played.tags ?? [],
        primary: played.primary ?? null,
        explanations: normalizeExplanations(
          played.explanations,
          played.tags ?? [],
          played.primary ?? null,
        ),
      };
    }
    // Backend answered without `played` (older shape) — treat the
    // position eval as the before-eval and compute the rest below.
    return await browserFallback(fen, moveUci, res.eval_cp_white, depth);
  } catch {
    // Backend absent/unreachable — browser fallback.
  }
  return await browserFallback(fen, moveUci, null, depth);
}

async function browserFallback(
  fen: string,
  moveUci: string,
  evalBefore: number | null,
  depth: number,
): Promise<MoveFeedback> {
  const game = new Chess(fen);
  const mover = game.turn();
  const move = game.move({
    from: moveUci.slice(0, 2),
    to: moveUci.slice(2, 4),
    promotion: moveUci.length > 4 ? moveUci[4] : undefined,
  });
  const afterFen = game.fen();
  const [beforeEv, afterEv] = await Promise.all([
    evalBefore !== null
      ? Promise.resolve({ evalCpWhite: evalBefore } as BrowserEval)
      : browserEngine.evaluate(fen, depth),
    browserEngine.evaluate(afterFen, depth),
  ]);
  // Best move + PV are for the ORIGINAL position (what should have been
  // played instead) — re-evaluate the pre-move position for those.
  const best =
    evalBefore !== null
      ? await browserEngine.evaluate(fen, depth)
      : (beforeEv as BrowserEval);
  const cpLoss = cpLossForMover(
    beforeEv.evalCpWhite,
    afterEv.evalCpWhite,
    mover,
  );
  const wpBefore =
    mover === "w"
      ? winProbWhite(beforeEv.evalCpWhite)
      : 100 - winProbWhite(beforeEv.evalCpWhite);
  const wpAfter =
    mover === "w"
      ? winProbWhite(afterEv.evalCpWhite)
      : 100 - winProbWhite(afterEv.evalCpWhite);
  return {
    fen,
    turn: mover,
    evalCpWhite: beforeEv.evalCpWhite,
    bestMoveUci: best.bestMoveUci,
    bestMoveSan: best.bestMoveSan,
    pvSan: best.pvSan,
    source: "browser",
    playedSan: move.san,
    playedUci: moveUci,
    evalBeforeCpWhite: beforeEv.evalCpWhite,
    evalAfterCpWhite: afterEv.evalCpWhite,
    cpLossUser: cpLoss,
    winProbDrop: Math.max(0, wpBefore - wpAfter) / 100,
    tags: [],
    primary: null,
    explanations: [],
  };
}

/** Stop any in-flight browser search (leaving sparring / try mode). */
export function stopBrowserEngine() {
  browserEngine.stop();
}
