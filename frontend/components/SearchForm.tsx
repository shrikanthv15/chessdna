"use client";

import { useEffect, useState } from "react";
import {
  ChevronDown,
  Dna,
  Loader2,
  Search,
  Settings2,
  Sparkles,
} from "lucide-react";
import { getHealth } from "@/lib/api";
import type {
  CoachSettings,
  GameCount,
  Platform,
  TimeControl,
} from "@/lib/types";

export interface SearchValues {
  platform: Platform;
  username: string;
  timeControl: TimeControl;
  gameCount: GameCount;
}

interface SearchFormProps {
  onSubmit: (values: SearchValues) => void;
  submitting: boolean;
  coachSettings: CoachSettings;
  onCoachSettingsChange: (settings: CoachSettings) => void;
  initialValues?: SearchValues;
}

const GAME_COUNTS: GameCount[] = [25, 50, 100];
const TIME_CONTROLS: { value: TimeControl; label: string }[] = [
  { value: "all", label: "All" },
  { value: "rapid", label: "Rapid" },
  { value: "blitz", label: "Blitz" },
  { value: "bullet", label: "Bullet" },
];

export default function SearchForm({
  onSubmit,
  submitting,
  coachSettings,
  onCoachSettingsChange,
  initialValues,
}: SearchFormProps) {
  const [platform, setPlatform] = useState<Platform>(
    initialValues?.platform ?? "chesscom",
  );
  const [username, setUsername] = useState(initialValues?.username ?? "");
  const [timeControl, setTimeControl] = useState<TimeControl>(
    initialValues?.timeControl ?? "all",
  );
  const [gameCount, setGameCount] = useState<GameCount>(
    initialValues?.gameCount ?? 50,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [backendUp, setBackendUp] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHealth()
      .then((h) => {
        if (!cancelled) setBackendUp(h.status === "ok");
      })
      .catch(() => {
        if (!cancelled) setBackendUp(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmed = username.trim();
  const canSubmit = trimmed.length > 0 && !submitting;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({ platform, username: trimmed, timeControl, gameCount });
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4">
      <div className="pt-16 pb-10 text-center sm:pt-24">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1 text-xs font-medium text-zinc-400">
          <Dna className="h-3.5 w-3.5 text-emerald-400" />
          Stockfish-powered weakness diagnostic
        </div>
        <h1 className="font-display text-5xl font-extrabold tracking-tight text-zinc-50 sm:text-6xl">
          Chess<span className="text-emerald-400">DNA</span>
        </h1>
        <p className="mx-auto mt-4 max-w-md text-base leading-relaxed text-zinc-400">
          Find out <span className="text-zinc-200">why</span> you lose. We
          replay your recent games through Stockfish and name the exact
          thinking habits leaking your rating points.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 shadow-2xl shadow-black/40 sm:p-6"
      >
        {/* Platform toggle */}
        <div className="mb-5 grid grid-cols-2 gap-1 rounded-lg bg-zinc-950 p-1">
          {(
            [
              { value: "chesscom", label: "Chess.com" },
              { value: "lichess", label: "Lichess" },
            ] as const
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setPlatform(opt.value)}
              aria-pressed={platform === opt.value}
              className={`rounded-md px-4 py-2 text-sm font-semibold transition-colors ${
                platform === opt.value
                  ? "bg-zinc-800 text-zinc-50 shadow"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Username */}
        <label
          htmlFor="username"
          className="mb-1.5 block text-xs font-semibold tracking-wide text-zinc-400 uppercase"
        >
          Username
        </label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            id="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={
              platform === "chesscom" ? "e.g. Hikaru" : "e.g. DrNykterstein"
            }
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 py-3 pr-4 pl-10 font-mono text-[15px] text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/30 focus:outline-none"
          />
        </div>

        {/* Time control */}
        <div className="mt-5">
          <span className="mb-1.5 block text-xs font-semibold tracking-wide text-zinc-400 uppercase">
            Time control
          </span>
          <div className="flex flex-wrap gap-2">
            {TIME_CONTROLS.map((tc) => (
              <button
                key={tc.value}
                type="button"
                onClick={() => setTimeControl(tc.value)}
                aria-pressed={timeControl === tc.value}
                className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${
                  timeControl === tc.value
                    ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-300"
                    : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                }`}
              >
                {tc.label}
              </button>
            ))}
          </div>
        </div>

        {/* Game count */}
        <div className="mt-5">
          <span className="mb-1.5 block text-xs font-semibold tracking-wide text-zinc-400 uppercase">
            Games to analyze
          </span>
          <div className="flex flex-wrap gap-2">
            {GAME_COUNTS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setGameCount(n)}
                aria-pressed={gameCount === n}
                className={`rounded-full border px-4 py-1.5 font-mono text-sm font-medium transition-colors ${
                  gameCount === n
                    ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-300"
                    : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                }`}
              >
                Last {n}
              </button>
            ))}
          </div>
        </div>

        {/* AI Coach settings drawer */}
        <div className="mt-6 border-t border-zinc-800/80 pt-4">
          <button
            type="button"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-expanded={drawerOpen}
            className="flex w-full items-center justify-between text-sm font-medium text-zinc-300 hover:text-zinc-100"
          >
            <span className="flex items-center gap-2">
              <Settings2 className="h-4 w-4 text-zinc-500" />
              AI Coach Settings
              <span className="text-xs font-normal text-zinc-500">
                (optional)
              </span>
            </span>
            <ChevronDown
              className={`h-4 w-4 text-zinc-500 transition-transform ${drawerOpen ? "rotate-180" : ""}`}
            />
          </button>

          {drawerOpen && (
            <div className="mt-4 space-y-3">
              <p className="flex gap-2 text-xs leading-relaxed text-zinc-500">
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                Leave empty to use built-in coaching templates. Keys are sent
                per-request only and never stored server-side — they stay in
                this browser&apos;s localStorage.
              </p>
              <div>
                <label
                  htmlFor="llm-base-url"
                  className="mb-1 block text-xs font-medium text-zinc-400"
                >
                  LLM base URL (OpenAI-compatible)
                </label>
                <input
                  id="llm-base-url"
                  type="text"
                  value={coachSettings.llmBaseUrl}
                  onChange={(e) =>
                    onCoachSettingsChange({
                      ...coachSettings,
                      llmBaseUrl: e.target.value,
                    })
                  }
                  placeholder="https://ollama.com/v1"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/30 focus:outline-none"
                />
              </div>
              <div>
                <label
                  htmlFor="llm-api-key"
                  className="mb-1 block text-xs font-medium text-zinc-400"
                >
                  API key
                </label>
                <input
                  id="llm-api-key"
                  type="password"
                  value={coachSettings.llmApiKey}
                  onChange={(e) =>
                    onCoachSettingsChange({
                      ...coachSettings,
                      llmApiKey: e.target.value,
                    })
                  }
                  placeholder="ollama / OpenAI / LiteLLM key"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/30 focus:outline-none"
                />
              </div>
              <div>
                <label
                  htmlFor="llm-model"
                  className="mb-1 block text-xs font-medium text-zinc-400"
                >
                  Model name
                </label>
                <input
                  id="llm-model"
                  type="text"
                  value={coachSettings.llmModel}
                  onChange={(e) =>
                    onCoachSettingsChange({
                      ...coachSettings,
                      llmModel: e.target.value,
                    })
                  }
                  placeholder="e.g. gpt-oss:120b"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/30 focus:outline-none"
                />
              </div>
            </div>
          )}
        </div>

        <button
          type="submit"
          disabled={!canSubmit}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-3 text-[15px] font-bold text-zinc-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Starting analysis…
            </>
          ) : (
            "Analyze my games"
          )}
        </button>
      </form>

      <p className="mt-4 flex items-center justify-center gap-2 text-center text-xs text-zinc-500">
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            backendUp === null
              ? "bg-zinc-600"
              : backendUp
                ? "bg-emerald-400"
                : "bg-rose-400"
          }`}
        />
        {backendUp === null
          ? "Checking analysis engine…"
          : backendUp
            ? "Engine ready — analysis runs locally with Stockfish"
            : "Backend unreachable — start the FastAPI server on :8000"}
      </p>
    </div>
  );
}
