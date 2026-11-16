"use client";

import { BookOpen, ExternalLink, PlayCircle } from "lucide-react";
import { formatPct, tagLabel } from "@/lib/format";
import {
  TRAINER_URL,
  buildRecommendations,
  trainerOpeningUrl,
  youtubeUrl,
} from "@/lib/trainer";
import type { PlayerDNA } from "@/lib/types";

interface RecommendationsProps {
  result: PlayerDNA;
}

/** "What to study next" — worst-loss openings mapped to GothamChess
 *  trainer entries (deep-linked) + study themes for the top weakness
 *  tags. Every trainer link was verified against the trainer's data.js;
 *  unmapped openings fall back to the trainer home page rather than a
 *  guessed slug. */
export default function Recommendations({ result }: RecommendationsProps) {
  const recs = buildRecommendations(result);
  if (recs.length === 0) return null;

  return (
    <section className="rounded-xl border border-stone-200 bg-white p-5 sm:p-6 dark:border-zinc-800 dark:bg-zinc-900/50">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-stone-500 dark:text-zinc-400" />
            <h2 className="font-display text-lg font-bold text-stone-900 dark:text-zinc-50">
              What to study next
            </h2>
          </div>
          <p className="mt-1 text-sm text-stone-500 dark:text-zinc-500">
            Openings and themes picked from your own losses — study the line
            in the trainer, or watch Gotham teach it.
          </p>
        </div>
        <a
          href={TRAINER_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 transition-colors hover:border-stone-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-zinc-700"
        >
          Openings Trainer
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {recs.map((rec, i) => {
          const key =
            rec.kind === "opening" ? `eco-${rec.eco}-${rec.name}` : `tag-${rec.tag}`;
          const trainerHref = rec.entry
            ? trainerOpeningUrl(rec.entry.slug)
            : TRAINER_URL;
          return (
            <article
              key={`${key}-${i}`}
              className="flex flex-col rounded-lg border border-stone-200 bg-stone-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-950/60"
            >
              <p className="text-[11px] font-semibold tracking-wide text-stone-400 uppercase dark:text-zinc-500">
                {rec.kind === "opening" ? "Opening to fix" : "Theme to study"}
              </p>
              <h3 className="mt-1.5 font-display text-[15px] leading-snug font-bold text-stone-900 dark:text-zinc-50">
                {rec.kind === "opening"
                  ? rec.name
                  : tagLabel(rec.tag, rec.label)}
              </h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-stone-600 dark:text-zinc-400">
                {rec.kind === "opening" ? rec.reason : rec.theme}
              </p>
              {rec.kind === "opening" && (
                <p className="mt-2 font-mono text-[11px] text-stone-400 tabular-nums dark:text-zinc-500">
                  {rec.eco && `${rec.eco} · `}
                  {rec.games} {rec.games === 1 ? "game" : "games"} ·{" "}
                  {formatPct(rec.scorePct, 0)} score
                </p>
              )}
              {rec.kind === "theme" && (
                <p className="mt-2 font-mono text-[11px] text-stone-400 tabular-nums dark:text-zinc-500">
                  {formatPct(rec.pct, 1)} of your flagged mistakes
                </p>
              )}
              <div className="mt-auto flex flex-wrap gap-2 pt-4">
                <a
                  href={trainerHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-emerald-500 dark:bg-emerald-500 dark:text-zinc-950 dark:hover:bg-emerald-400"
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  {rec.entry ? `Study: ${rec.entry.title}` : "Study in the trainer"}
                </a>
                {rec.entry && (
                  <a
                    href={youtubeUrl(rec.entry.videoId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 transition-colors hover:border-stone-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-700"
                  >
                    <PlayCircle className="h-3.5 w-3.5" />
                    Watch the video
                  </a>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
