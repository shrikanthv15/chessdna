"use client";

import { useState } from "react";
import { Check, ClipboardList, Copy } from "lucide-react";

interface ChecklistCardProps {
  items: string[];
  username: string;
}

export default function ChecklistCard({ items, username }: ChecklistCardProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const text = [
      `Pre-move checklist for ${username} (ChessDNA)`,
      "",
      ...items.map((item, i) => `${i + 1}. ${item}`),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API unavailable (e.g. non-secure context) — fall back to a
      // temporary textarea selection so the user can still copy manually.
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="rounded-lg border border-emerald-600/25 bg-emerald-600/[0.05] p-4 dark:border-emerald-500/25 dark:bg-emerald-500/[0.05]">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 font-display text-sm font-bold tracking-wide text-emerald-700 uppercase dark:text-emerald-200">
          <ClipboardList className="h-4 w-4" />
          Pre-move checklist
        </h3>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 transition-colors hover:border-stone-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-500"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              Copy
            </>
          )}
        </button>
      </div>
      <ol className="mt-3 space-y-2.5">
        {items.map((item, i) => (
          <li key={i} className="flex gap-3 text-sm leading-relaxed text-stone-800 dark:text-zinc-200">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600/20 font-mono text-[11px] font-bold text-emerald-700 tabular-nums dark:bg-emerald-500/20 dark:text-emerald-300">
              {i + 1}
            </span>
            {item}
          </li>
        ))}
      </ol>
    </div>
  );
}
