/** In-browser Stockfish (stockfish.js 10.0.2, WebAssembly) running in a Web
 *  Worker. The engine files live in public/engine/ (stockfish.wasm.js +
 *  stockfish.wasm, side by side — the Emscripten glue loads the .wasm
 *  relative to the worker script), so nothing is added to the JS bundle
 *  and the ~650KB payload only downloads when sparring/try-mode starts.
 *
 *  This takes the interactive engine load off the VPS: engine replies and
 *  "engine plays on" autoplay run entirely in the browser. It returns
 *  eval + best move + PV only — the plain-language WHY (classifier tags
 *  and explanations) still comes from the backend /api/position endpoint
 *  via lib/engine.ts, which falls back here when the backend is absent.
 *
 *  Engine: Stockfish 2019-08-15 (SF10-era, single-threaded WASM, no NNUE).
 *  Weaker than the VPS Stockfish 17, but far stronger than any human
 *  sparring partner; depth 16 middlegame replies typically land in 1–3s.
 */
import { Chess } from "chess.js";

export interface BrowserEval {
  /** Centipawns from White's perspective; mates encoded as ±10000. */
  evalCpWhite: number;
  bestMoveUci: string;
  bestMoveSan: string;
  /** Principal variation in SAN, up to 6 plies. */
  pvSan: string[];
  depth: number;
}

const ENGINE_SCRIPT = "/engine/stockfish.wasm.js";
const START_TIMEOUT_MS = 15000;
const SEARCH_TIMEOUT_MS = 30000;

/** Mate encoding shared with the backend: MATE_CP=10000, mateIn moves. */
function mateCp(mateInMoves: number, sign: number): number {
  return sign * Math.max(9001, 10000 - Math.max(1, mateInMoves));
}

/** Parse a UCI `info` score into centipawns from the side-to-move's
 *  perspective. Returns null for unparseable lines. */
function parseScore(tokens: string[]): number | null {
  const i = tokens.indexOf("score");
  if (i < 0 || i + 2 >= tokens.length) return null;
  if (tokens[i + 1] === "cp") {
    const cp = Number(tokens[i + 2]);
    return Number.isFinite(cp) ? cp : null;
  }
  if (tokens[i + 1] === "mate") {
    const mate = Number(tokens[i + 2]);
    if (!Number.isFinite(mate) || mate === 0) return null;
    return mateCp(Math.abs(mate), Math.sign(mate));
  }
  return null;
}

function uciToSan(fen: string, pvUci: string[]): string[] {
  const game = new Chess(fen);
  const san: string[] = [];
  for (const uci of pvUci.slice(0, 6)) {
    try {
      const move = game.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
      san.push(move.san);
    } catch {
      break;
    }
  }
  return san;
}

class BrowserEngine {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private failed = false;
  private queue: Array<{
    resolve: (v: BrowserEval) => void;
    reject: (e: Error) => void;
    fen: string;
    depth: number;
  }> = [];
  private active: {
    resolve: (v: BrowserEval) => void;
    reject: (e: Error) => void;
    fen: string;
    depth: number;
    best: { score: number; pv: string[] } | null;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  /** True once the worker has failed to start — callers should stop trying. */
  get unavailable(): boolean {
    return this.failed;
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      if (typeof Worker === "undefined") {
        this.failed = true;
        reject(new Error("Web Workers are not available in this browser"));
        return;
      }
      let settled = false;
      let sawUciok = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.failed = true;
        reject(new Error("Stockfish worker did not start in time"));
      }, START_TIMEOUT_MS);
      try {
        const worker = new Worker(ENGINE_SCRIPT);
        this.worker = worker;
        worker.onmessage = (e: MessageEvent) => {
          const line = String(e.data);
          if (!settled && line === "uciok") {
            sawUciok = true;
            worker.postMessage("isready");
            return;
          }
          if (!settled && sawUciok && line === "readyok") {
            settled = true;
            clearTimeout(timer);
            resolve();
            return;
          }
          if (!settled) return; // ignore option lines during handshake
          this.handleLine(line);
        };
        worker.onerror = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            this.failed = true;
            reject(new Error("Stockfish worker failed to load"));
          } else {
            this.failActive(new Error("Stockfish worker crashed"));
          }
        };
        worker.postMessage("uci");
      } catch (err) {
        clearTimeout(timer);
        settled = true;
        this.failed = true;
        reject(err instanceof Error ? err : new Error("Could not start Stockfish worker"));
      }
    });
    return this.ready;
  }

  private handleLine(line: string) {
    const active = this.active;
    if (!active) return;
    if (line.startsWith("info ") && line.includes(" score ")) {
      const tokens = line.split(/\s+/);
      const score = parseScore(tokens);
      const pvIdx = tokens.indexOf("pv");
      const pv = pvIdx >= 0 ? tokens.slice(pvIdx + 1) : [];
      if (score !== null && pv.length > 0) {
        // Keep the deepest info line: later lines at equal-or-greater depth
        // supersede earlier ones; UCI emits increasing depths in order.
        active.best = { score, pv };
      }
      return;
    }
    if (line.startsWith("bestmove")) {
      const parts = line.split(/\s+/);
      const bestMoveUci = parts[1];
      clearTimeout(active.timer);
      this.active = null;
      if (!bestMoveUci || bestMoveUci === "(none)") {
        active.reject(new Error("Stockfish found no legal move (game over?)"));
      } else {
        const turnBlack = new Chess(active.fen).turn() === "b";
        const score = active.best?.score ?? 0;
        const evalCpWhite = turnBlack ? -score : score;
        const pvUci = active.best?.pv ?? [bestMoveUci];
        const pvSan = uciToSan(active.fen, pvUci);
        const game = new Chess(active.fen);
        let bestMoveSan = bestMoveUci;
        try {
          bestMoveSan = game.move({
            from: bestMoveUci.slice(0, 2),
            to: bestMoveUci.slice(2, 4),
            promotion: bestMoveUci.length > 4 ? bestMoveUci[4] : undefined,
          }).san;
        } catch {
          // keep UCI fallback
        }
        active.resolve({
          evalCpWhite,
          bestMoveUci,
          bestMoveSan,
          pvSan: pvSan.length > 0 ? pvSan : [bestMoveSan],
          depth: active.depth,
        });
      }
      this.pump();
    }
  }

  private failActive(err: Error) {
    if (this.active) {
      clearTimeout(this.active.timer);
      const a = this.active;
      this.active = null;
      a.reject(err);
      this.pump();
    }
  }

  private pump() {
    if (this.active || this.queue.length === 0 || !this.worker) return;
    const next = this.queue.shift();
    if (!next) return;
    const timer = setTimeout(() => {
      // Search overran: stop the engine and fail this request so the
      // caller can fall back to the backend instead of hanging.
      this.worker?.postMessage("stop");
      this.failActive(new Error("Stockfish search timed out"));
    }, SEARCH_TIMEOUT_MS);
    this.active = { ...next, best: null, timer };
    this.worker.postMessage(`position fen ${next.fen}`);
    this.worker.postMessage(`go depth ${next.depth}`);
  }

  /** Evaluate one position. Requests serialize through a single worker. */
  async evaluate(fen: string, depth: number): Promise<BrowserEval> {
    await this.start();
    return new Promise<BrowserEval>((resolve, reject) => {
      this.queue.push({ resolve, reject, fen, depth });
      this.pump();
    });
  }

  /** Stop any running search (used when the user exits sparring). */
  stop() {
    this.worker?.postMessage("stop");
    if (this.active) this.failActive(new Error("Search stopped"));
    const queued = this.queue;
    this.queue = [];
    for (const q of queued) q.reject(new Error("Search stopped"));
  }
}

/** Process-wide singleton: one worker for the whole session. */
export const browserEngine = new BrowserEngine();

/** Pre-warm the worker (fire-and-forget) so the first sparring move is fast.
 *  Safe to call repeatedly; failures are silent — callers fall back. */
export function warmBrowserEngine() {
  browserEngine.evaluate(new Chess().fen(), 1).catch(() => {
    /* fallback path handles it */
  });
}
