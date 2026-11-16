"use client";

import { useState } from "react";
import { AlertCircle, Loader2, Sparkles, Wand2 } from "lucide-react";
import { getCoaching } from "@/lib/api";
import type { CoachResponse, CoachSettings } from "@/lib/types";
import ChecklistCard from "./ChecklistCard";

interface CoachPanelProps {
  jobId: string;
  username: string;
  settings: CoachSettings;
}

export default function CoachPanel({ jobId, username, settings }: CoachPanelProps) {
  const [report, setReport] = useState<CoachResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate() {
    setLoading(true);
    setError(null);
    try {
      const res = await getCoaching({
        job_id: jobId,
        llm_base_url: settings.llmBaseUrl.trim() || undefined,
        llm_api_key: settings.llmApiKey.trim() || undefined,
        llm_model: settings.llmModel.trim() || undefined,
      });
      setReport(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Coaching request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="rounded-xl border border-stone-200 bg-white p-5 sm:p-6 dark:border-zinc-800 dark:bg-zinc-900/50">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-stone-500 dark:text-zinc-400" />
            <h2 className="font-display text-lg font-bold text-stone-900 dark:text-zinc-50">
              AI Coach
            </h2>
          </div>
          <p className="mt-1 text-sm text-stone-500 dark:text-zinc-500">
            A personalized summary of your diagnostic, plus a pre-move
            checklist built around your #1 leak.
          </p>
        </div>
        {report && (
          <span
            className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
              report.source === "llm"
                ? "border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300"
                : "border-stone-300 bg-stone-100 text-stone-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300"
            }`}
          >
            {report.source === "llm"
              ? `AI-generated${report.model ? ` · ${report.model}` : ""}`
              : "Template coaching"}
          </span>
        )}
      </div>

      {!report && (
        <button
          type="button"
          onClick={handleGenerate}
          disabled={loading}
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-emerald-500 dark:text-zinc-950 dark:hover:bg-emerald-400"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Writing your report…
            </>
          ) : (
            <>
              <Wand2 className="h-4 w-4" />
              Generate coaching report
            </>
          )}
        </button>
      )}

      {error && (
        <p className="mt-4 flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </p>
      )}

      {report && (
        <div className="mt-5 space-y-4">
          <p className="text-[15px] leading-relaxed whitespace-pre-line text-stone-800 dark:text-zinc-200">
            {report.summary}
          </p>
          <ChecklistCard items={report.checklist} username={username} />
          <button
            type="button"
            onClick={handleGenerate}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 transition-colors hover:border-stone-400 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-zinc-700"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Regenerating…
              </>
            ) : (
              "Regenerate report"
            )}
          </button>
        </div>
      )}
    </section>
  );
}
