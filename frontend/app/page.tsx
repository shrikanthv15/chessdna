"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Dna, RotateCcw } from "lucide-react";
import BlindSpotBars from "@/components/BlindSpotBars";
import BlunderBoard from "@/components/BlunderBoard";
import CoachPanel from "@/components/CoachPanel";
import KpiCards from "@/components/KpiCards";
import PhaseOpenings from "@/components/PhaseOpenings";
import PracticeSection from "@/components/PracticeSection";
import ProgressView from "@/components/ProgressView";
import SearchForm, { type SearchValues } from "@/components/SearchForm";
import { getJobStatus, startAnalysis } from "@/lib/api";
import {
  formatPct,
  formatTimestamp,
  platformDisplay,
  tagLabel,
  timeControlDisplay,
  topClassifiedSpot,
} from "@/lib/format";
import type {
  CoachSettings,
  JobProgress,
  PlayerDNA,
  PracticeFocus,
} from "@/lib/types";
import { DEFAULT_COACH_SETTINGS } from "@/lib/types";

type AppState = "idle" | "analyzing" | "done" | "error";

const COACH_SETTINGS_KEY = "chessdna.coachSettings";
/** Fixed tactical depth for Stockfish analysis (contract default). */
const ENGINE_DEPTH = 13;
const POLL_INTERVAL_MS = 2000;

export default function Home() {
  const [state, setState] = useState<AppState>("idle");
  const [values, setValues] = useState<SearchValues | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<JobProgress>({
    current: 0,
    total: 0,
    message: "",
  });
  const [result, setResult] = useState<PlayerDNA | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [coachSettings, setCoachSettings] = useState<CoachSettings>(() => {
    // Lazy initializer reads persisted settings once (client-only; the
    // server render falls back to defaults and the drawer is closed, so
    // nothing rendered differs).
    if (typeof window === "undefined") return DEFAULT_COACH_SETTINGS;
    try {
      const raw = window.localStorage.getItem(COACH_SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<CoachSettings>;
        return { ...DEFAULT_COACH_SETTINGS, ...parsed };
      }
    } catch {
      // ignore corrupt stored settings
    }
    return DEFAULT_COACH_SETTINGS;
  });
  const [practiceFocus, setPracticeFocus] = useState<PracticeFocus | null>(null);
  const focusNonce = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const topSpot = result
    ? topClassifiedSpot(result.blind_spots, result.top_blind_spot)
    : undefined;

  function handleCoachSettingsChange(next: CoachSettings) {
    setCoachSettings(next);
    try {
      window.localStorage.setItem(COACH_SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // localStorage unavailable — settings still apply for this session
    }
  }

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  async function handleSubmit(nextValues: SearchValues) {
    setSubmitting(true);
    setError(null);
    setResult(null);
    setValues(nextValues);
    try {
      const res = await startAnalysis({
        platform: nextValues.platform,
        username: nextValues.username,
        time_control: nextValues.timeControl,
        game_count: nextValues.gameCount,
        depth: ENGINE_DEPTH,
      });
      setJobId(res.job_id);
      setProgress({ current: 0, total: nextValues.gameCount, message: "Starting analysis…" });
      setState("analyzing");
      pollJob(res.job_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start analysis");
      setState("error");
    } finally {
      setSubmitting(false);
    }
  }

  function pollJob(id: string) {
    stopPolling();
    const tick = async () => {
      try {
        const status = await getJobStatus(id);
        setProgress(status.progress);
        if (status.status === "done" && status.result) {
          stopPolling();
          setResult(status.result);
          setState("done");
        } else if (status.status === "error") {
          stopPolling();
          setError(status.error ?? "Analysis failed");
          setState("error");
        }
      } catch (err) {
        // Transient poll failure — keep polling; surface only if it persists
        // via the next ticks. A hard failure surfaces on retry below.
        console.warn("Status poll failed:", err);
      }
    };
    void tick();
    pollTimer.current = setInterval(() => void tick(), POLL_INTERVAL_MS);
  }

  function handleCancel() {
    stopPolling();
    setJobId(null);
    setState("idle");
  }

  function handleNewAnalysis() {
    stopPolling();
    setJobId(null);
    setResult(null);
    setError(null);
    setPracticeFocus(null);
    setState("idle");
  }

  function handleRetry() {
    if (values) void handleSubmit(values);
    else setState("idle");
  }

  function handleTrainPosition(focus: Omit<PracticeFocus, "nonce">) {
    focusNonce.current += 1;
    setPracticeFocus({ ...focus, nonce: focusNonce.current });
    document
      .getElementById("game-replay")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <main className="min-h-screen bg-[#0a0a0b] text-zinc-100">
      {state === "idle" && (
        <SearchForm
          onSubmit={(v) => void handleSubmit(v)}
          submitting={submitting}
          coachSettings={coachSettings}
          onCoachSettingsChange={handleCoachSettingsChange}
          initialValues={values ?? undefined}
        />
      )}

      {state === "analyzing" && values && (
        <ProgressView
          username={values.username}
          progress={progress}
          onCancel={handleCancel}
        />
      )}

      {state === "error" && (
        <div className="mx-auto w-full max-w-2xl px-4 pt-24 sm:pt-32">
          <div className="rounded-2xl border border-rose-500/25 bg-zinc-900/50 p-6 sm:p-8">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-rose-400" />
              <h2 className="font-display text-xl font-bold text-zinc-50">
                Analysis didn&apos;t complete
              </h2>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-zinc-400">{error}</p>
            <div className="mt-6 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleRetry}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-bold text-zinc-950 transition-colors hover:bg-emerald-400"
              >
                <RotateCcw className="h-4 w-4" />
                Retry analysis
              </button>
              <button
                type="button"
                onClick={handleNewAnalysis}
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-700"
              >
                <ArrowLeft className="h-4 w-4" />
                Change username
              </button>
            </div>
          </div>
        </div>
      )}

      {state === "done" && result && jobId && (
        <div className="mx-auto w-full max-w-6xl px-4 pt-8 pb-16 sm:pt-10">
          {/* Dashboard header */}
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
                <Dna className="h-3.5 w-3.5 text-emerald-400" />
                ChessDNA diagnostic
              </p>
              <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight text-zinc-50 sm:text-4xl">
                <span className="font-mono text-emerald-400">{result.username}</span>
                <span className="text-zinc-500">’s blind spots</span>
              </h1>
              <p className="mt-2 text-sm text-zinc-400">
                {platformDisplay(result.platform)} ·{" "}
                {timeControlDisplay(result.time_control)} ·{" "}
                {result.games_analyzed} games analyzed
              </p>
            </div>
            <button
              type="button"
              onClick={handleNewAnalysis}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-700"
            >
              <ArrowLeft className="h-4 w-4" />
              New analysis
            </button>
          </header>

          {/* Headline verdict: the #1 issue, in one plain-English line */}
          {topSpot ? (
            <div className="mt-6">
              <p className="font-display text-xl leading-snug font-bold text-zinc-50 sm:text-2xl">
                Your biggest leak is{" "}
                <span className="text-rose-300">
                  {tagLabel(topSpot.tag, topSpot.label)}
                </span>{" "}
                — {formatPct(topSpot.pct, 1)} of your flagged mistakes.
              </p>
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-zinc-400">
                {topSpot.explanation}
              </p>
            </div>
          ) : (
            <p className="mt-6 font-display text-xl leading-snug font-bold text-zinc-50 sm:text-2xl">
              No single habit dominates your mistakes — work through the
              biggest buckets below.
            </p>
          )}

          <div className="mt-6 space-y-4">
            <KpiCards result={result} />
            <BlindSpotBars blindSpots={result.blind_spots} />
            <BlunderBoard
              blunders={result.blunders}
              practiceFocus={practiceFocus}
            />
            <PhaseOpenings result={result} />
            {result.practice_plan && result.practice_plan.length > 0 && (
              <PracticeSection
                plan={result.practice_plan}
                blunders={result.blunders}
                onTrainPosition={handleTrainPosition}
              />
            )}
            <CoachPanel
              jobId={jobId}
              username={result.username}
              settings={coachSettings}
            />
          </div>

          <footer className="mt-8 border-t border-zinc-800/80 pt-4 text-center font-mono text-xs text-zinc-600">
            Analyzed with Stockfish at depth {ENGINE_DEPTH} ·{" "}
            {formatTimestamp(result.analyzed_at)}
          </footer>
        </div>
      )}
    </main>
  );
}
