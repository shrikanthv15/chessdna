/** Openings Trainer linking: ECO / weakness-tag → trainer opening.
 *
 *  Every slug + videoId below was verified against
 *  ~/workspace/chess-openings/site/data.js (29 openings, Nov 16 2026).
 *  Never link a slug that isn't in that list — when no confident mapping
 *  exists, recommendations fall back to the trainer home page.
 *
 *  Deep links use ?opening=<slug>, which the trainer honors (see
 *  chess-openings/site/index.html). YouTube links use the playlist
 *  videoIds from playlist.json / data.js.
 */
import type { BlindSpot, OpeningStat, PlayerDNA } from "./types";

export const TRAINER_URL =
  "https://chess-openings-trainer-shri15-5457s-projects.vercel.app/";

export const CHESSDNA_URL = "https://chessdna.vercel.app/";

export function trainerOpeningUrl(slug: string): string {
  return `${TRAINER_URL}?opening=${encodeURIComponent(slug)}`;
}

export function youtubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

interface TrainerEntry {
  slug: string;
  videoId: string;
  title: string;
}

const ENTRIES: Record<string, TrainerEntry> = {
  "caro-kann": { slug: "caro-kann", videoId: "rmbU97iftC8", title: "Caro-Kann Defense" },
  stonewall: { slug: "stonewall", videoId: "4_brAnORWGw", title: "Stonewall Defense & Attack" },
  slav: { slug: "slav", videoId: "cs54KXnGc-0", title: "Slav Defense" },
  dutch: { slug: "dutch", videoId: "ogmGNIk6W7I", title: "Dutch Defense Setup" },
  french: { slug: "french", videoId: "5pec-u6PSvA", title: "French Defense" },
  "kings-indian": { slug: "kings-indian", videoId: "kK0cq6UBt1Y", title: "King's Indian Setup" },
  london: { slug: "london", videoId: "49H728S_VjM", title: "London System" },
  "crush-e4": { slug: "crush-e4", videoId: "Qdyik5UwBtM", title: "CRUSH with 1. e4" },
  sicilian: { slug: "sicilian", videoId: "qM4e7g2RukI", title: "The Sicilian Defense" },
  "basic-openings": { slug: "basic-openings", videoId: "8IlJ3v8I4Z8", title: "Basic Chess Openings Explained" },
  catalan: { slug: "catalan", videoId: "nMuvv1HksL4", title: "Catalan" },
  "evans-nakhmanson": { slug: "evans-nakhmanson", videoId: "fG52OQytDxc", title: "Evans and Nakhmanson Gambit" },
  english: { slug: "english", videoId: "va0s92praEM", title: "English Opening" },
  "queens-gambit": { slug: "queens-gambit", videoId: "mtsabsZ4wG4", title: "Queen's Gambit" },
  "every-gambit": { slug: "every-gambit", videoId: "_vh0ztdYTws", title: "EVERY Chess Gambit for White and Black" },
  "vienna-gambit": { slug: "vienna-gambit", videoId: "JVxENCPcCjU", title: "The Vienna Gambit" },
  "rosen-gambits": { slug: "rosen-gambits", videoId: "Jp9_zvfPt6A", title: "Stafford, Orthoschnapp, & More Gambits" },
  "vampire-gambit": { slug: "vampire-gambit", videoId: "AqV-dq64Cg0", title: "The Vampire Gambit" },
  "monkeys-bum": { slug: "monkeys-bum", videoId: "RoZwWjb1--s", title: "The Monkey's Bum" },
  "rozman-french": { slug: "rozman-french", videoId: "vLH1Yw6skaI", title: "Rozman French Defense" },
  "icbm-gambit": { slug: "icbm-gambit", videoId: "yc91zIltxIo", title: "Intercontinental Ballistic Missile Gambit" },
  "godly-gambit": { slug: "godly-gambit", videoId: "q-D_2hpqnds", title: "Godly Gambit" },
  "danish-gambit": { slug: "danish-gambit", videoId: "Nd7ZiSvdwN8", title: "Danish Gambit" },
  "fried-liver-attack": { slug: "fried-liver-attack", videoId: "hLFSufXxtuI", title: "Fried Liver Attack" },
  "traxler-counterattack": { slug: "traxler-counterattack", videoId: "v1jkj-HPLdw", title: "Traxler Counter-Attack" },
  "sicilian-like-beth-harmon": { slug: "sicilian-like-beth-harmon", videoId: "65VWIFlc4C4", title: "Play the Sicilian like Beth Harmon" },
  "beef-eater": { slug: "beef-eater", videoId: "P0KL1FF2zOw", title: "The Beef Eater" },
  "blackmar-diemer-gambit": { slug: "blackmar-diemer-gambit", videoId: "mxtUxgupAHY", title: "Blackmar-Diemer Gambit" },
  "wing-gambit": { slug: "wing-gambit", videoId: "LMBF4FGzDD4", title: "The Wing Gambit" },
};

/** Keyword (lowercase, matched against the ECO name) → trainer entry.
 *  Order matters: more specific keywords first. Only confident mappings —
 *  a wrong "study this" is worse than no recommendation. */
const KEYWORD_MAP: { keywords: string[]; entry: string }[] = [
  { keywords: ["blackmar", "blackmar-diemer"], entry: "blackmar-diemer-gambit" },
  { keywords: ["wing gambit"], entry: "wing-gambit" },
  { keywords: ["fried liver"], entry: "fried-liver-attack" },
  { keywords: ["traxler"], entry: "traxler-counterattack" },
  { keywords: ["danish"], entry: "danish-gambit" },
  { keywords: ["stafford"], entry: "rosen-gambits" },
  { keywords: ["evans"], entry: "evans-nakhmanson" },
  { keywords: ["vienna"], entry: "vienna-gambit" },
  { keywords: ["scandinavian"], entry: "icbm-gambit" },
  { keywords: ["sicilian"], entry: "sicilian" },
  { keywords: ["caro-kann", "caro kann"], entry: "caro-kann" },
  { keywords: ["french"], entry: "french" },
  { keywords: ["stonewall"], entry: "stonewall" },
  { keywords: ["slav"], entry: "slav" },
  { keywords: ["dutch"], entry: "dutch" },
  { keywords: ["king's indian", "kings indian", "king’s indian"], entry: "kings-indian" },
  { keywords: ["london"], entry: "london" },
  { keywords: ["catalan"], entry: "catalan" },
  { keywords: ["english"], entry: "english" },
  { keywords: ["queen's gambit", "queens gambit", "queen’s gambit"], entry: "queens-gambit" },
  { keywords: ["vampire"], entry: "vampire-gambit" },
  { keywords: ["pterodactyl", "modern defense", "modern defence"], entry: "beef-eater" },
];

/** ECO-code fallback for the three big families (letter + number ranges).
 *  Only used when the name didn't match any keyword. */
function ecoCodeFallback(eco: string): TrainerEntry | null {
  const m = /^([A-E])(\d{2})/.exec(eco.trim().toUpperCase());
  if (!m) return null;
  const letter = m[1];
  const num = Number(m[2]);
  if (letter === "B" && num >= 20 && num <= 99) return ENTRIES["sicilian"];
  if (letter === "B" && num >= 10 && num <= 19) return ENTRIES["caro-kann"];
  if (letter === "C" && num >= 0 && num <= 19) return ENTRIES["french"];
  return null;
}

/** Map an ECO name/code to a trainer entry, or null when there's no
 *  confident mapping (caller falls back to the trainer home page). */
export function trainerEntryForOpening(
  eco: string,
  name: string,
): TrainerEntry | null {
  const hay = name.toLowerCase();
  for (const { keywords, entry } of KEYWORD_MAP) {
    if (keywords.some((k) => hay.includes(k))) return ENTRIES[entry];
  }
  return ecoCodeFallback(eco);
}

/** Weakness tag → study theme. Only tags with a genuinely relevant trainer
 *  video get a specific entry; the rest point at the trainer home page
 *  with honest theme copy (no fake mapping). */
const TAG_THEMES: Record<string, { theme: string; entry: string | null }> = {
  missed_tactic: {
    theme: "Sharp tactical lines — play through gambits where one missed tactic ends the game.",
    entry: "every-gambit",
  },
  missed_opponent_threat: {
    theme: "Ask what the opponent threatens before every move — study sharp lines where threats come fast.",
    entry: "traxler-counterattack",
  },
  left_piece_hanging: {
    theme: "The blunder-check habit: development, safety, and what hangs — back to principles.",
    entry: "basic-openings",
  },
  hope_chess_hanging_piece: {
    theme: "The blunder-check habit: development, safety, and what hangs — back to principles.",
    entry: "basic-openings",
  },
  missed_mate: {
    theme: "Mating attacks against the castled king — learn the patterns so you spot them in your own games.",
    entry: "fried-liver-attack",
  },
  king_safety: {
    theme: "King safety cuts both ways: learn how attacks crash through, so you feel danger earlier.",
    entry: "sicilian-like-beth-harmon",
  },
  time_scramble_panic: {
    theme: "Low-theory systems you can play on autopilot, so the clock never decides the game.",
    entry: "london",
  },
  abandoned_defender: {
    theme: "Defensive awareness: which piece is holding what — study lines where one defender does two jobs.",
    entry: null,
  },
  backward_or_long_range_blindness: {
    theme: "Long diagonals and backward moves: slow down on quiet moves that change the whole board.",
    entry: null,
  },
  missed_defense: {
    theme: "Defensive technique: finding the one move that holds — practice from your own worst positions above.",
    entry: null,
  },
  conversion_collapse: {
    theme: "Winning positions need a plan, not hope: simplify with purpose and convert. Drill your own winning positions above.",
    entry: null,
  },
};

export interface OpeningRecommendation {
  kind: "opening";
  eco: string;
  name: string;
  games: number;
  losses: number;
  scorePct: number;
  entry: TrainerEntry | null;
  reason: string;
}

export interface ThemeRecommendation {
  kind: "theme";
  tag: string;
  label: string;
  pct: number;
  theme: string;
  entry: TrainerEntry | null;
}

export type Recommendation = OpeningRecommendation | ThemeRecommendation;

/** Build study recommendations from a DNA result: worst-loss openings
 *  (loss_breakdown.by_eco when present, else the openings table) plus
 *  themes for the top classified weakness tags. Never recommends a
 *  trainer entry that doesn't exist. */
export function buildRecommendations(result: PlayerDNA): Recommendation[] {
  const recs: Recommendation[] = [];
  const seenSlugs = new Set<string>();

  // --- Worst openings: prefer the v3 loss breakdown, fall back to the
  // openings table sorted by score (with a minimum-games sanity bar). ---
  type Row = { eco: string; name: string; games: number; losses: number; scorePct: number };
  let rows: Row[] = [];
  const byEco = result.loss_breakdown?.by_eco;
  if (Array.isArray(byEco) && byEco.length > 0) {
    rows = byEco
      .filter((r) => r && (r.eco || r.name))
      .map((r) => {
        // Backend loss_breakdown rows use {played, lost}; the openings
        // table uses {games, losses}. Accept both shapes.
        const games = r.games ?? r.played ?? 0;
        const losses = r.losses ?? r.lost ?? 0;
        const table = (result.openings ?? []).find(
          (o) => o.eco === r.eco || o.name === (r.name ?? r.eco_name),
        );
        return {
          eco: r.eco ?? table?.eco ?? "",
          name: r.name ?? r.eco_name ?? table?.name ?? "Unknown opening",
          games,
          losses,
          scorePct: table?.score_pct ?? (games > 0 ? ((games - losses) / games) * 100 : 0),
        };
      })
      .sort((a, b) => b.losses - a.losses || a.scorePct - b.scorePct);
  } else {
    rows = (result.openings ?? [])
      .map((o: OpeningStat) => ({
        eco: o.eco,
        name: o.name,
        games: o.games,
        losses: o.losses,
        scorePct: o.score_pct,
      }))
      .sort((a, b) => b.losses - a.losses || a.scorePct - b.scorePct);
  }

  for (const row of rows.slice(0, 3)) {
    if (row.losses <= 0 && row.games < 2) continue;
    const entry = trainerEntryForOpening(row.eco, row.name);
    if (entry && seenSlugs.has(entry.slug)) continue;
    if (entry) seenSlugs.add(entry.slug);
    recs.push({
      kind: "opening",
      eco: row.eco,
      name: row.name,
      games: row.games,
      losses: row.losses,
      scorePct: row.scorePct,
      entry,
      reason:
        row.losses > 0
          ? `${row.losses} ${row.losses === 1 ? "loss" : "losses"} in ${row.games} ${row.games === 1 ? "game" : "games"} — your leakiest opening in this sample.`
          : `Lowest score in this sample (${row.scorePct.toFixed(0)}% across ${row.games} games).`,
    });
  }

  // --- Themes from the top classified weakness tags. ---
  const spots: BlindSpot[] = (result.blind_spots ?? []).filter(
    (s) => s.tag !== "unclassified",
  );
  const ranked = [...spots].sort((a, b) => b.pct - a.pct);
  for (const spot of ranked.slice(0, 3)) {
    const theme = TAG_THEMES[spot.tag];
    if (!theme) continue;
    const entry = theme.entry ? ENTRIES[theme.entry] : null;
    if (entry && seenSlugs.has(entry.slug)) continue;
    if (entry) seenSlugs.add(entry.slug);
    recs.push({
      kind: "theme",
      tag: spot.tag,
      label: spot.label,
      pct: spot.pct,
      theme: theme.theme,
      entry,
    });
    if (recs.length >= 5) break;
  }

  return recs.slice(0, 5);
}
