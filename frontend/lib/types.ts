/** Types matching the ChessDNA backend API contract exactly. */

export type Platform = "chesscom" | "lichess";
export type TimeControl = "all" | "rapid" | "blitz" | "bullet";
export type GameCount = 25 | 50 | 100;

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
  game_url: string;
  move_number: number;
  phase: string;
  clock_seconds: number | null;
  player_color: string;
  opponent: string;
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
