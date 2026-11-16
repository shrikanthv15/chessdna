"use client";

import { useEffect, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  Dna,
  Loader2,
  Search,
  Settings2,
  Sparkles,
} from "lucide-react";
import { getHealth } from "@/lib/api";
import { TRAINER_URL } from "@/lib/trainer";
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

const INPUT_CLASS =
  "w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 font-mono text-sm text-stone-900 placeholder:text-stone-400 focus:border-emerald-600/60 focus:ring-2 focus:ring-emerald-600/20 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600 dark:focus:border-emerald-500/60 dark:focus:ring-emerald-500/30";

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
      <div className="pt-12 pb-10 text-center sm:pt-20">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-stone-300 bg-white px-3 py-1 text-xs font-medium text-stone-600 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
          <Dna className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          Stockfish-powered weakness diagnostic
        </div>
        <h1 className="font-display text-5xl font-extrabold tracking-tight text-stone-900 sm:text-6xl dark:text-zinc-50">
          Chess<span className="text-emerald-600 dark:text-emerald-400">DNA</span>
        </h1>
        <p className="mx-auto mt-4 max-w-md text-base leading-relaxed text-stone-600 dark:text-zinc-400">
          Find out <span className="text-stone-900 dark:text-zinc-200">why</span> you lose. We
          replay your recent games through Stockfish and name the exact
          thinking habits leaking your rating points.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6 dark:border-zinc-800 dark:bg-zinc-900/50 dark:shadow-2xl dark:shadow-black/40"
      >
        {/* Platform toggle */}
        <div className="mb-5 grid grid-cols-2 gap-1 rounded-lg bg-stone-100 p-1 dark:bg-zinc-950">
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
                  ? "bg-white text-stone-900 shadow dark:bg-zinc-800 dark:text-zinc-50"
                  : "text-stone-500 hover:text-stone-900 dark:text-zinc-400 dark:hover:text-zinc-200"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Username */}
        <label
          htmlFor="username"
          className="mb-1.5 block text-xs font-semibold tracking-wide text-stone-500 uppercase dark:text-zinc-400"
        >
          Username
        </label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-stone-400 dark:text-zinc-500" />
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
            className="w-full rounded-lg border border-stone-300 bg-white py-3 pr-4 pl-10 font-mono text-[15px] text-stone-900 placeholder:text-stone-400 focus:border-emerald-600/60 focus:ring-2 focus:ring-emerald-600/20 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600 dark:focus:border-emerald-500/60 dark:focus:ring-emerald-500/30"
          />
        </div>

        {/* Time control */}
        <div className="mt-5">
          <span className="mb-1.5 block text-xs font-semibold tracking-wide text-stone-500 uppercase dark:text-zinc-400">
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
                    ? "border-emerald-600/50 bg-emerald-600/10 text-emerald-700 dark:border-emerald-500/60 dark:bg-emerald-500/10 dark:text-emerald-300"
                    : "border-stone-300 bg-white text-stone-600 hover:border-stone-400 hover:text-stone-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-200"
                }`}
              >
                {tc.label}
              </button>
            ))}
          </div>
        </div>

        {/* Game count */}
        <div className="mt-5">
          <span className="mb-1.5 block text-xs font-semibold tracking-wide text-stone-500 uppercase dark:text-zinc-400">
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
                    ? "border-emerald-600/50 bg-emerald-600/10 text-emerald-700 dark:border-emerald-500/60 dark:bg-emerald-500/10 dark:text-emerald-300"
                    : "border-stone-300 bg-white text-stone-600 hover:border-stone-400 hover:text-stone-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-200"
                }`}
              >
                Last {n}
              </button>
            ))}
          </div>
        </div>

        {/* AI Coach settings drawer */}
        <div className="mt-6 border-t border-stone-200 pt-4 dark:border-zinc-800/80">
          <button
            type="button"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-expanded={drawerOpen}
            className="flex w-full items-center justify-between text-sm font-medium text-stone-700 hover:text-stone-900 dark:text-zinc-300 dark:hover:text-zinc-100"
          >
            <span className="flex items-center gap-2">
              <Settings2 className="h-4 w-4 text-stone-400 dark:text-zinc-500" />
              AI Coach Settings
              <span className="text-xs font-normal text-stone-500 dark:text-zinc-500">
                (optional)
              </span>
            </span>
            <ChevronDown
              className={`h-4 w-4 text-stone-400 transition-transform dark:text-zinc-500 ${drawerOpen ? "rotate-180" : ""}`}
            />
          </button>

          {drawerOpen && (
            <div className="mt-4 space-y-3">
              <p className="flex gap-2 text-xs leading-relaxed text-stone-500 dark:text-zinc-500">
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                Leave empty to use built-in coaching templates. Keys are sent
                per-request only and never stored server-side — they stay in
                this browser&apos;s localStorage.
              </p>
              <div>
                <label
                  htmlFor="llm-base-url"
                  className="mb-1 block text-xs font-medium text-stone-600 dark:text-zinc-400"
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
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label
                  htmlFor="llm-api-key"
                  className="mb-1 block text-xs font-medium text-stone-600 dark:text-zinc-400"
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
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label
                  htmlFor="llm-model"
                  className="mb-1 block text-xs font-medium text-stone-600 dark:text-zinc-400"
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
                  className={INPUT_CLASS}
                />
              </div>
            </div>
          )}
        </div>

        <button
          type="submit"
          disabled={!canSubmit}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-3 text-[15px] font-bold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-emerald-500 dark:text-zinc-950 dark:hover:bg-emerald-400"
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

      <p className="mt-4 flex items-center justify-center gap-2 text-center text-xs text-stone-500 dark:text-zinc-500">
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            backendUp === null
              ? "bg-stone-400 dark:bg-zinc-600"
              : backendUp
                ? "bg-emerald-500"
                : "bg-rose-400"
          }`}
        />
        {backendUp === null
          ? "Checking analysis engine…"
          : backendUp
            ? "Engine ready — analysis runs locally with Stockfish"
            : "Backend unreachable — start the FastAPI server on :8000"}
      </p>

      <p className="mt-3 text-center text-xs text-stone-500 dark:text-zinc-500">
        Studying openings too?{" "}
        <a
          href={TRAINER_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-medium text-emerald-700 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-300"
        >
          <BookOpen className="h-3.5 w-3.5" />
          Open the GothamChess Openings Trainer
        </a>
      </p>
    </div>
  );
}
