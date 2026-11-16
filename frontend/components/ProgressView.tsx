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
      <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm sm:p-8 dark:border-zinc-800 dark:bg-zinc-900/50">
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-emerald-600 dark:text-emerald-400" />
          <h2 className="font-display text-xl font-bold text-stone-900 dark:text-zinc-50">
            Diagnosing <span className="font-mono text-emerald-600 dark:text-emerald-400">{username}</span>
          </h2>
        </div>

        <p className="mt-3 min-h-5 font-mono text-sm text-stone-500 tabular-nums dark:text-zinc-400">
          {progress.message || "Starting analysis…"}
        </p>

        <div className="mt-4 h-2 overflow-hidden rounded-full bg-stone-200 dark:bg-zinc-800">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all duration-500 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>

        <div className="mt-2 flex items-center justify-between font-mono text-xs text-stone-500 tabular-nums dark:text-zinc-500">
          <span>
            {progress.current} / {progress.total} games
          </span>
          <span>{pct}%</span>
        </div>

        <p className="mt-6 animate-pulse text-sm leading-relaxed text-stone-500 dark:text-zinc-500">
          Stockfish is replaying every move, flagging the positions where your
          win probability collapsed — then the blind-spot classifier names what
          went wrong in each one.
        </p>

        <button
          type="button"
          onClick={onCancel}
          className="mt-8 inline-flex items-center gap-2 rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-700 transition-colors hover:border-stone-400 hover:text-stone-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:text-zinc-100"
        >
          <ArrowLeft className="h-4 w-4" />
          Cancel and go back
        </button>
      </div>
    </div>
  );
}
