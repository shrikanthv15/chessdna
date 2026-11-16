"use client";

import { ArrowLeft, Loader2 } from "lucide-react";
import type { JobProgress } from "@/lib/types";

interface ProgressViewProps {
  username: string;
  progress: JobProgress;
  onCancel: () => void;
}

export default function ProgressView({
  username,
  progress,
  onCancel,
}: ProgressViewProps) {
  const total = Math.max(progress.total, 1);
  const pct = Math.min(100, Math.round((progress.current / total) * 100));

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pt-24 sm:pt-32">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6 sm:p-8">
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-emerald-400" />
          <h2 className="font-display text-xl font-bold text-zinc-50">
            Diagnosing <span className="font-mono text-emerald-400">{username}</span>
          </h2>
        </div>

        <p className="mt-3 min-h-5 font-mono text-sm text-zinc-400 tabular-nums">
          {progress.message || "Starting analysis…"}
        </p>

        <div className="mt-4 h-2 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all duration-500 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>

        <div className="mt-2 flex items-center justify-between font-mono text-xs text-zinc-500 tabular-nums">
          <span>
            {progress.current} / {progress.total} games
          </span>
          <span>{pct}%</span>
        </div>

        <p className="mt-6 animate-pulse text-sm leading-relaxed text-zinc-500">
          Stockfish is replaying every move, flagging the positions where your
          win probability collapsed — then the blind-spot classifier names what
          went wrong in each one.
        </p>

        <button
          type="button"
          onClick={onCancel}
          className="mt-8 inline-flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100"
        >
          <ArrowLeft className="h-4 w-4" />
          Cancel and go back
        </button>
      </div>
    </div>
  );
}
