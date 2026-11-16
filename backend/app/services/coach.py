"""Pluggable LLM chess coach.

Talks to any OpenAI-compatible ``/chat/completions`` endpoint — Ollama
Cloud, local Ollama, OpenAI, LiteLLM — configured via ``LLM_BASE_URL``,
``LLM_API_KEY`` and ``LLM_MODEL`` (.env) or per-request overrides from the
UI's AI Coach Settings drawer.

Request overrides are used for that call only and are never persisted.

When no API key is configured, or when the LLM call fails for any reason,
the coach falls back to rich rule-based templates built from the PlayerDNA
summary, so the app works fully out of the box.
"""
from __future__ import annotations

import json
import re
from typing import Any

import httpx

from ..config import settings
from ..analyzer.aggregator import BLIND_SPOT_LABELS

SYSTEM_PROMPT = (
    "You are a direct, expert chess coach. You receive a player's "
    "diagnostic summary (blind-spot patterns, phase and opening leaks, "
    "conversion stats) plus their worst concrete blunders as FENs. Write a "
    "short, personalized coaching summary (3-5 sentences, plain language, "
    "no fluff) and a 3-item pre-move mental checklist tailored to their "
    "#1 recurring error. Respond with JSON ONLY, exactly in this shape: "
    '{"summary": "...", "checklist": ["...", "...", "..."]}'
)

LLM_TIMEOUT_SECONDS = 60.0

# 3-item pre-move checklists tailored to each #1 blind spot.
CHECKLISTS: dict[str, list[str]] = {
    "abandoned_defender": [
        "Before moving any piece, ask: what is it defending right now?",
        "After choosing a candidate move, re-scan every piece it used to protect.",
        "If your move unblocks an enemy line, assume the opponent sees it — verify the square is still covered.",
    ],
    "backward_or_long_range_blindness": [
        "Before moving, scan the whole board edge-to-edge for enemy bishops, rooks, and queens — not just the local fight.",
        "Ask: does the opponent have a quiet retreat that uncovers an attack or lands somewhere new?",
        "Trace every long diagonal and open file to its end before you commit.",
    ],
    "missed_opponent_threat": [
        "After every opponent move, stop and ask out loud: what is this threatening?",
        "Name the threat before you look for your own idea — checks, captures, and mate threats first.",
        "If a piece is attacked and undefended, your next move must answer it or prove the tactic fails.",
    ],
    "hope_chess_hanging_piece": [
        "Before any check or capture, scan ALL of your own pieces: is any of them undefended?",
        "Ask: if I play this attack, what does the opponent win on the next move?",
        "An attack is only sound if your own house is safe — defend first, then strike.",
    ],
    "time_scramble_panic": [
        "Bank time early: play principled, familiar moves fast in the opening so complications later get real thought.",
        "With under a minute left, simplify: trade pieces, make safe developing moves, stop calculating deep lines.",
        "Set a personal rule: never spend your last 25 seconds on one move — move, then think on their clock.",
    ],
    "conversion_collapse": [
        "When winning, trade pieces — every exchange makes the win easier, not harder.",
        "Stop hunting for the brilliant finish; play the simple move that keeps the advantage.",
        "Ask: what is the opponent's only counterplay? Take it away before pushing your own plan.",
    ],
    "unclassified": [
        "Before every move, do a 5-second blunder check: checks, captures, and attacks against your pieces.",
        "Ask what changed with the opponent's last move before planning your own.",
        "Slow down in sharp positions — one extra look at the whole board catches most tactics.",
    ],
    "none": [
        "Before every move, do a 5-second blunder check: checks, captures, and attacks against your pieces.",
        "Ask what changed with the opponent's last move before planning your own.",
        "Slow down in sharp positions — one extra look at the whole board catches most tactics.",
    ],
}


def _dna_brief(dna: dict[str, Any]) -> dict[str, Any]:
    """Trim the DNA payload to what the coach prompt needs."""
    return {
        "username": dna.get("username"),
        "games_analyzed": dna.get("games_analyzed"),
        "win_rate": dna.get("win_rate"),
        "avg_centipawn_loss": dna.get("avg_centipawn_loss"),
        "accuracy": dna.get("accuracy"),
        "phase_mistakes": dna.get("phase_mistakes"),
        "openings": dna.get("openings"),
        "blind_spots": dna.get("blind_spots"),
        "conversion": dna.get("conversion"),
        "top_blind_spot": dna.get("top_blind_spot"),
        "top_blunders": [
            {
                "fen": b["fen"],
                "move_played": b["move_played"],
                "best_move": b["best_move"],
                "tag": b["tag"],
                "explanation": b["explanation"],
                "win_prob_drop": b["win_prob_drop"],
            }
            for b in (dna.get("blunders") or [])[:4]
        ],
    }


def _extract_json(text: str) -> dict[str, Any] | None:
    """Parse a JSON object from LLM output, tolerating code fences and
    surrounding prose."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            return parsed
    except ValueError:
        pass
    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if match:
        try:
            parsed = json.loads(match.group(0))
            if isinstance(parsed, dict):
                return parsed
        except ValueError:
            return None
    return None


async def _call_llm(
    base_url: str, api_key: str, model: str, dna: dict[str, Any]
) -> dict[str, Any] | None:
    user_content = (
        "Player diagnostic summary (JSON):\n"
        + json.dumps(_dna_brief(dna), indent=2)
        + "\n\nWrite the coaching summary and 3-item pre-move checklist as JSON."
    )
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.7,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=LLM_TIMEOUT_SECONDS) as client:
            resp = await client.post(
                f"{base_url}/chat/completions", json=payload, headers=headers
            )
            resp.raise_for_status()
            data = resp.json()
    except (httpx.HTTPError, ValueError, KeyError):
        return None
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return None
    parsed = _extract_json(content or "")
    if not parsed:
        return None
    summary = parsed.get("summary")
    checklist = parsed.get("checklist")
    if not isinstance(summary, str) or not summary.strip():
        return None
    if not isinstance(checklist, list):
        return None
    checklist = [str(item).strip() for item in checklist if str(item).strip()]
    if len(checklist) < 3:
        return None
    return {"summary": summary.strip(), "checklist": checklist[:3]}


def template_coaching(dna: dict[str, Any]) -> dict[str, Any]:
    """Rich rule-based coaching from the DNA summary (no LLM needed)."""
    top_tag = dna.get("top_blind_spot") or "none"
    label = BLIND_SPOT_LABELS.get(top_tag, "Unclassified")
    blind_spots = dna.get("blind_spots") or []
    top_entry = next((b for b in blind_spots if b.get("tag") == top_tag), None)
    top_pct = top_entry["pct"] if top_entry else 0.0
    phase = dna.get("phase_mistakes") or {}
    worst_phase = max(phase, key=lambda k: phase[k]) if phase else "middlegame"
    openings = dna.get("openings") or []
    worst_opening = openings[0] if openings else None
    conv = dna.get("conversion") or {}
    acc = dna.get("accuracy") or {}
    games = dna.get("games_analyzed", 0)

    parts = [
        f"Across {games} games, your #1 leak is {label.lower()} — it shows up in "
        f"{top_pct:.0f}% of your blunders."
    ]
    if worst_opening:
        parts.append(
            f"Your weakest opening is the {worst_opening['name']} "
            f"({worst_opening['eco']}), scoring just {worst_opening['score_pct']:.0f}% "
            f"over {worst_opening['games']} games — worth a focused review or a "
            f"repertoire change."
        )
    parts.append(
        f"Most of your mistakes land in the {worst_phase}, where "
        f"{phase.get(worst_phase, 0)} of your {acc.get('blunders', 0)} blunders happened."
    )
    if conv.get("winning_positions"):
        parts.append(
            f"You reached a winning position in {conv['winning_positions']} games "
            f"but converted only {conv['conversion_rate']:.0f}% of them — "
            f"when ahead, simplify and remove counterplay instead of hunting "
            f"for the finish."
        )
    parts.append(
        "The pattern is fixable: it is a habit, not a talent gap. Drill the "
        "checklist below before every move until it becomes automatic."
    )
    summary = " ".join(parts)
    checklist = list(CHECKLISTS.get(top_tag, CHECKLISTS["unclassified"]))
    return {"summary": summary, "checklist": checklist}


async def generate_coaching(
    dna: dict[str, Any],
    llm_base_url: str | None = None,
    llm_api_key: str | None = None,
    llm_model: str | None = None,
) -> dict[str, Any]:
    """Generate coaching for a DNA result.

    Uses the LLM when a key is available (per-request override wins over
    .env); otherwise, or on any LLM failure, falls back to templates.
    API keys are used for this call only and never stored.
    """
    base_url = (llm_base_url or settings.LLM_BASE_URL or "").rstrip("/")
    api_key = llm_api_key if llm_api_key is not None else settings.LLM_API_KEY
    model = llm_model or settings.LLM_MODEL

    if api_key:
        result = await _call_llm(base_url, api_key, model, dna)
        if result is not None:
            return {**result, "source": "llm", "model": model}

    return {**template_coaching(dna), "source": "template"}
