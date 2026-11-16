/** Types matching the ChessDNA backend API contract exactly. */

export type Platform = "chesscom" | "lichess";
export type TimeControl = "all" | "rapid" | "blitz" | "bullet";
export type GameCount = 25 | 50 | 100;
/** Game result from the analyzed user's perspective. */
export type GameResult = "win" | "loss" | "draw";

export interface AnalyzeRequest {
  platform: Platform;
  username: string;
  time_control: TimeControl;
  game_count: GameCount;
  depth: number;
}

export interface AnalyzeResponse {
  job_id: string;
  status: "pending";
}

export type JobStatus = "pending" | "running" | "done" | "error";

export interface JobProgress {
  current: number;
  total: number;
  message: string;
}

export interface StatusResponse {
  job_id: string;
  status: JobStatus;
  progress: JobProgress;
  result: PlayerDNA | null;
  error: string | null;
}

export interface CoachRequest {
  job_id: string;
  llm_base_url?: string;
  llm_api_key?: string;
  llm_model?: string;
}

export interface CoachResponse {
  summary: string;
  checklist: [string, string, string];
  source: "llm" | "template";
  model?: string;
}

export interface HealthResponse {
  status: string;
  stockfish: boolean;
  stockfish_path: string | null;
}

export interface ColorRecord {
  wins: number;
  losses: number;
  draws: number;
}

export interface OpeningStat {
  eco: string;
  name: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  score_pct: number;
}

export interface BlindSpot {
  tag: string;
  label: string;
  count: number;
  pct: number;
  explanation: string;
}

export interface Blunder {
  fen: string;
  move_played: string;
  move_played_uci: string;
  best_move: string;
  best_move_uci: string;
  eval_before_cp: number;
  eval_after_cp: number;
  win_prob_drop: number;
  tag: string;
  tags: string[];
  explanation: string;
  game_url: string | null;
  move_number: number;
  phase: string;
  clock_seconds: number | null;
  player_color: string;
  opponent: string;
  /** Game identity + full-game replay fields (v2 contract). All optional:
   *  an older backend omits them and the UI degrades to the v1 single-position
   *  view. */
  game_id?: string;
  game_date?: string | null;
  time_control?: string;
  result?: GameResult;
  eco?: string | null;
  eco_name?: string | null;
  moves_san?: string[];
  moves_uci?: string[];
  eval_series?: EvalPoint[];
}

/** One Stockfish evaluation along a game: eval in centipawns from White's
 *  perspective at the position after `ply` half-moves (mate = ±10000). */
export interface EvalPoint {
  ply: number;
  cp: number;
}

export interface PracticeDrill {
  title: string;
  detail: string;
  minutes_per_day: number;
}

export interface PracticeEntry {
  tag: string;
  title: string;
  why: string;
  drills: PracticeDrill[];
  /** FEN strings of positions to train (usually the entry's blunder FENs). */
  positions: string[];
}

/** A practice position handed from the practice section to the replay board. */
export interface PracticeFocus {
  fen: string;
  /** Engine best move in UCI, when the position resolves to a known blunder. */
  bestMoveUci: string | null;
  label: string;
  /** Monotonic nonce: a new focus request even for a repeated FEN. */
  nonce: number;
}

export interface PlayerDNA {
  username: string;
  platform: string;
  time_control: string;
  games_analyzed: number;
  games_requested: number;
  record: { white: ColorRecord; black: ColorRecord };
  win_rate: { white: number; black: number; overall: number };
  avg_centipawn_loss: number;
  accuracy: {
    blunders: number;
    mistakes: number;
    inaccuracies: number;
    total_user_moves: number;
  };
  phase_mistakes: { opening: number; middlegame: number; endgame: number };
  openings: OpeningStat[];
  blind_spots: BlindSpot[];
  blunders: Blunder[];
  conversion: {
    winning_positions: number;
    wins: number;
    draws: number;
    losses: number;
    conversion_rate: number;
  };
  top_blind_spot: string;
  analyzed_at: string;
  /** Personalized practice plan (v2 contract). Absent on older backends —
   *  the practice section hides itself. */
  practice_plan?: PracticeEntry[];
}

/** Coach settings entered in the UI drawer (stored in browser localStorage only). */
export interface CoachSettings {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
}

export const DEFAULT_COACH_SETTINGS: CoachSettings = {
  llmBaseUrl: "",
  llmApiKey: "",
  llmModel: "",
};
