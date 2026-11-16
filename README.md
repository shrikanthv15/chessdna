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
      main.py       API endpoints: /api/health, /api/analyze, /api/status/{job_id}, /api/coach
      config.py     .env-driven settings
      cache.py      JSON file cache (data/cache/)
      services/
        fetcher.py  Chess.com + Lichess game ingestion
        coach.py    OpenAI-compatible LLM coach + template fallback
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

API keys passed to `/api/coach` are used per-request only and never persisted.

## Blind-spot tags

| Tag | Meaning |
|---|---|
| `abandoned_defender` | The piece you moved was the sole defender of another piece/square; the opponent immediately exploited it. |
| `backward_or_long_range_blindness` | The punishment came from a backward retreat or a long-range slider (B/R/Q) from ≥4 squares away. |
| `missed_opponent_threat` | The opponent created a direct threat last move; you played an unrelated move and it landed. |
| `hope_chess_hanging_piece` | You attacked or checked while leaving one of your own pieces completely undefended. |
| `time_scramble_panic` | The blunder happened with <25s on the clock or in <2s of think time. |
| `conversion_collapse` | You held a winning position (+3.0) and still lost or drew the game. |
| `unclassified` | Tactical oversight — no single pattern matched. |

## Frontend setup

See `frontend/README.md` (Next.js, port 3000).
