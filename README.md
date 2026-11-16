# ChessDNA

A personal chess weakness diagnostic and tactical blind-spot analyzer.

Enter a Chess.com or Lichess username, pick a time control and sample size, and
ChessDNA fetches your recent games, runs Stockfish over every move you played,
and explains *why* you lose games — not just how many centipawns you dropped.
A rule-based "human blind spot" classifier tags each blunder with the cognitive
pattern behind it (abandoned defender, missed opponent threat, hope chess, time
scramble, ...), and an aggregator compiles your Player DNA: accuracy by phase,
worst openings, blind-spot rankings, and your top concrete blunders for replay.

An optional pluggable LLM coach (any OpenAI-compatible endpoint: Ollama Cloud,
local Ollama, OpenAI, LiteLLM) turns the DNA into a personalized coaching
summary and a 3-item pre-move checklist. With no API key configured, the app
falls back to rich rule-based coaching templates and works fully out of the box.

## Layout

```
chessdna/
  backend/          FastAPI service (port 8000)
    app/
      main.py       API endpoints: /api/health, /api/analyze, /api/status/{job_id}, /api/coach, /api/position
      config.py     .env-driven settings
      cache.py      JSON file cache (data/cache/)
      services/
        fetcher.py  Chess.com + Lichess game ingestion
        coach.py    OpenAI-compatible LLM coach + template fallback
        cloud_eval.py  Lichess cloud-eval tier (disk-cached, silent fallback)
        sparring.py  Single-position eval + move classification (/api/position)
      analyzer/
        engine.py   Stockfish turning-point analysis
        classifier.py  Human blind-spot taggers
        aggregator.py  Player DNA summary builder
    scripts/setup_stockfish.sh   idempotent Stockfish install
    bin/stockfish   engine binary (durable under $HOME)
    tests/          pytest suite (classifier + aggregator)
  frontend/         Next.js dashboard (port 3000)
  data/cache/       fetched games + per-game engine analysis (gitignored)
```

## Backend setup

```bash
cd backend
bash scripts/setup_stockfish.sh     # installs/verifies Stockfish, prints its path
cp ../.env.example .env             # set STOCKFISH_PATH to the printed path
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pytest                              # classifier + aggregator tests
uvicorn app.main:app --port 8000    # API at http://localhost:8000
```

## API

| Endpoint | Description |
|---|---|
| `GET /api/health` | `{"status":"ok","stockfish":bool,"stockfish_path":str\|null}` |
| `POST /api/analyze` | Body: `{"platform":"chesscom"\|"lichess","username":str,"time_control":"all"\|"rapid"\|"blitz"\|"bullet","game_count":25\|50\|100,"depth":12}` → `202 {"job_id","status":"pending"}` |
| `GET /api/status/{job_id}` | Job progress + `result` (PlayerDNA JSON) when done |
| `POST /api/coach` | Body: `{"job_id":str,"llm_base_url"?,"llm_api_key"?,"llm_model"?}` → `{"summary","checklist":[3 items],"source":"llm"\|"template"}` |
| `POST /api/position` | Sparring: evaluate one FEN, optionally classify a played move (see below). Never uses the analysis job lock. |

API keys passed to `/api/coach` are used per-request only and never persisted.

### `POST /api/position` (sparring / play-with-bots)

Request: `{"fen": str, "move_uci": str|null, "depth": int = 16, max 20}`.
Response:

```json
{
  "fen": "…",
  "turn": "w",
  "eval_cp_white": 34,
  "best_move_uci": "g1f3",
  "best_move_san": "Nf3",
  "pv_san": ["Nf3", "d5", "d4"],
  "eval_source": "cloud",
  "played": {
    "move_uci": "g1h3",
    "move_san": "Nh3",
    "eval_after_cp_white": -40,
    "cp_loss_user": 74,
    "win_prob_drop": 5.32,
    "tags": ["passive_piece"],
    "primary": "passive_piece",
    "explanations": {"passive_piece": "…"}
  }
}
```

Evals are centipawns from White's perspective, mates ±10000. `played` is
`null` when no move is given. The position eval tries the Lichess cloud
database first for early positions (ply ≤ 24, same rule as batch analysis;
a cloud hit returns only the best move as `pv_san` — no invented line),
then a short-lived Stockfish process (3s cap). The played move is
classified with the same blind-spot classifier as batch analysis, with no
reply/clock context. Invalid FEN or illegal move → 400.

```bash
curl -X POST http://localhost:8000/api/position \
  -H 'Content-Type: application/json' \
  -d '{"fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1", "move_uci": "e7e5", "depth": 16}'
```

PlayerDNA additions (v3): `loss_breakdown` (`by_phase`, `by_cause`,
`by_eco`, `time_trouble_losses`, `conversion_collapses`,
`losses_without_blunder`) summarizes where lost games broke — the decisive
swing of each lost game is its biggest blunder (max cp loss, earliest on
ties). Blunder records also carry optional `deep_best_move`, `deep_eval`
and `pv_san` from a deeper second-pass search (depth+6, cap 20, MultiPV=3).

## Blind-spot tags

| Tag | Meaning |
|---|---|
| `abandoned_defender` | The piece you moved was the sole defender of another piece/square; the opponent immediately exploited it. |
| `backward_or_long_range_blindness` | The punishment came from a backward retreat or a long-range slider (B/R/Q) from ≥4 squares away. |
| `missed_opponent_threat` | The opponent created a direct threat last move; you played an unrelated move and it landed. |
| `hope_chess_hanging_piece` | You attacked or checked while leaving one of your own pieces completely undefended. |
| `time_scramble_panic` | The blunder happened with <25s on the clock or in <2s of think time. |
| `missed_mate` | A forced checkmate was on the board and the move missed it. |
| `missed_tactic` | The best move won material, forked two pieces, created a concrete threat, or started a forcing capture sequence. |
| `missed_defense` | An active threat (profitable capture or mate in one) went unanswered. |
| `left_piece_hanging` | The move left one of your own pieces attacked and undefended. |
| `king_safety` | A pawn moved out of the shelter in front of the king, inviting a new attack on the king's vicinity. |
| `missed_development` | Opening: the best move developed a minor piece; the move played developed nothing. |
| `missed_exchange` | The best move captured on a central square (d4/e4/d5/e5) at no cost; the move played left it standing. |
| `missed_discovery` | The best move opened a slider's line (discovered attack); the move played did not open it. |
| `missed_retreat` | A piece under attack had a safe square via the best move; the move played left it under fire. |
| `weakened_defense` | The move carried away a defender of an attacked piece, dropping its defense to one piece. |
| `allowed_counterplay` | A reply after the move played wins material or mates; no such reply exists after the best move. |
| `passive_piece` | The move sent a piece to a low-mobility square while the best move kept it active. |
| `endgame_technique` | Endgame: the best move checked to support a queening pawn or activated the king; the move played did neither. |
| `conversion_collapse` | You held a winning position (+3.0) and still lost or drew the game. |
| `unclassified` | Tactical oversight — no single pattern matched. |

## Frontend setup

See `frontend/README.md` (Next.js, port 3000).
