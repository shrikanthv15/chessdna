"""Fast turning-point engine analysis with Stockfish.

For every move the user plays, the position *before* the move and the
position *after* it are evaluated from the user's perspective. A move is
flagged when the win probability drops by >= 15 points or the centipawn
loss is >= 150.

Severity (for accuracy counts):
    blunder      cp_loss >= 150 or win_prob_drop >= 15
    mistake      cp_loss >= 80
    inaccuracy   cp_loss >= 40
    ok           anything else

Only blunder-level moves are passed to the blind-spot classifier.

Win probability uses the Lichess formula:
    wp(cp) = 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)

One engine process is kept open per analyzed game and closed at the end
(see main.py: games fan out across worker threads, one Stockfish each).
Each search is bounded by both depth and a 10s engine-side time cap so a
single pathological position cannot stall a job.

Evaluation is cloud-first for early positions only: positions within the
first CLOUD_EVAL_MAX_PLY half-moves are looked up in the Lichess cloud
database (disk-cached, see services/cloud_eval.py) before local Stockfish
is consulted; later positions go straight to Stockfish. Every per-move
record carries ``eval_source`` ("cloud" or "local") so the UI can be
honest about where each number came from.

Two-pass analysis (v3): pass 1 scans every user move at the requested
depth (unchanged — flagging thresholds use pass-1 numbers only). Pass 2
re-analyzes ONLY blunder-level moves at depth+6 (capped at 20) with
MultiPV=3, storing ``deep_best_move`` (UCI), ``deep_eval`` (user
perspective, mates ±10000) and ``pv_san`` (best line, up to 6 plies) on
the record. Pass 2 is local-Stockfish only: the cloud database has no
MultiPV/deep-line data, and the point is a deeper local look.
"""
from __future__ import annotations

import io
import math
from typing import Any

import chess
import chess.engine
import chess.pgn

from ..cache import cache_key
from ..config import settings
from ..services.cloud_eval import CloudEvalClient, get_default_client

MATE_CP = 10000
BLUNDER_CP = 150
BLUNDER_WP_DROP = 15.0
MISTAKE_CP = 80
INACCURACY_CP = 40
SEARCH_TIME_CAP_SECONDS = 10.0
# Pass 2: blunder positions are re-searched this much deeper (capped),
# with MultiPV=3, to give the UI a trustworthy best line. Measured
# 2026-11-16: +6 keeps a 5-game fresh run well under 2x pass-1 time.
DEEP_PASS_DEPTH_BONUS = 6
DEEP_PASS_MAX_DEPTH = 20
DEEP_PASS_MULTIPV = 3
DEEP_PASS_PV_PLIES = 6


def win_probability(cp: int) -> float:
    """Lichess win-probability curve, in percent (0..100)."""
    return 50.0 + 50.0 * (2.0 / (1.0 + math.exp(-0.00368208 * cp)) - 1.0)


def phase_for(fullmove_number: int) -> str:
    if fullmove_number <= 10:
        return "opening"
    if fullmove_number <= 30:
        return "middlegame"
    return "endgame"


class EngineAnalyzer:
    """Wraps one Stockfish process for the duration of a job."""

    def __init__(
        self,
        stockfish_path: str,
        depth: int = 12,
        cloud_client: CloudEvalClient | None = None,
        cloud_enabled: bool | None = None,
    ):
        self.stockfish_path = stockfish_path
        self.depth = depth
        self.engine: chess.engine.SimpleEngine | None = None
        self._eval_cache: dict[str, tuple[int, chess.Move | None, str]] = {}
        if cloud_enabled is None:
            cloud_enabled = settings.CLOUD_EVAL_ENABLED
        self._cloud_client: CloudEvalClient | None = None
        if cloud_enabled:
            try:
                self._cloud_client = cloud_client or get_default_client()
            except Exception:
                # Cloud is strictly best-effort; never break local analysis.
                self._cloud_client = None

    def __enter__(self) -> "EngineAnalyzer":
        self.open()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def open(self) -> None:
        self.engine = chess.engine.SimpleEngine.popen_uci(self.stockfish_path)
        self.engine.configure({"Threads": 1, "Hash": 64})

    def close(self) -> None:
        if self.engine is not None:
            try:
                self.engine.quit()
            except Exception:
                pass
            self.engine = None

    # -- evaluation ------------------------------------------------------

    def _evaluate(
        self, board: chess.Board, ply: int | None = None
    ) -> tuple[int, chess.Move | None, str]:
        """Return (cp from White's perspective, best move, eval source).

        Results are cached per FEN so transpositions and the shared
        before/after positions of consecutive moves cost one search.
        Cloud eval is tried first for early positions only (``ply`` within
        CLOUD_EVAL_MAX_PLY half-moves); any miss falls back to Stockfish.
        """
        fen = board.fen()
        cached = self._eval_cache.get(fen)
        if cached is not None:
            return cached

        if board.is_checkmate():
            # Side to move is mated: terrible for them.
            cp = -MATE_CP if board.turn == chess.WHITE else MATE_CP
            result = (cp, None, "local")
            self._eval_cache[fen] = result
            return result
        if board.is_stalemate() or board.is_insufficient_material():
            result = (0, None, "local")
            self._eval_cache[fen] = result
            return result

        if self._cloud_client is not None and (
            ply is None or ply <= settings.CLOUD_EVAL_MAX_PLY
        ):
            cloud = self._cloud_client.lookup(board)
            if cloud is not None:
                result = (cloud.cp_white, cloud.best_move, "cloud")
                self._eval_cache[fen] = result
                return result

        assert self.engine is not None
        limit = chess.engine.Limit(depth=self.depth, time=SEARCH_TIME_CAP_SECONDS)
        info = self.engine.analyse(board, limit)
        score = info["score"].white()
        cp = score.score(mate_score=MATE_CP)
        pv = info.get("pv") or []
        best = pv[0] if pv else None
        result = (cp, best, "local")
        self._eval_cache[fen] = result
        return result

    # -- pass 2: deep re-analysis of blunder positions --------------------

    def _deep_analyze(
        self, board: chess.Board
    ) -> tuple[chess.Move | None, int | None, list[str]]:
        """Deeper MultiPV search of one position (pass 2).

        Returns (best move, cp from White's perspective, PV in SAN up to
        DEEP_PASS_PV_PLIES plies). Any failure returns (None, None, []):
        pass 2 is additive and must never break pass-1 results.
        """
        if self.engine is None or board.is_game_over():
            return None, None, []
        depth = min(self.depth + DEEP_PASS_DEPTH_BONUS, DEEP_PASS_MAX_DEPTH)
        limit = chess.engine.Limit(depth=depth, time=SEARCH_TIME_CAP_SECONDS)
        try:
            infos = self.engine.analyse(board, limit, multipv=DEEP_PASS_MULTIPV)
        except chess.engine.EngineError:
            return None, None, []
        if not infos:
            return None, None, []
        info = infos[0]
        try:
            cp = info["score"].white().score(mate_score=MATE_CP)
        except (KeyError, AttributeError):
            return None, None, []
        pv = info.get("pv") or []
        best = pv[0] if pv else None
        pv_san: list[str] = []
        probe = board.copy(stack=False)
        for move in pv[:DEEP_PASS_PV_PLIES]:
            try:
                pv_san.append(probe.san(move))
            except ValueError:
                break
            probe.push(move)
        return best, cp, pv_san

    def _deep_pass(
        self, records: list[dict[str, Any]], user_color: chess.Color
    ) -> None:
        """Pass 2: attach deep fields to blunder-level records in place.

        Only blunders are re-searched. The classifier keeps using pass-1
        numbers for flagging; these fields are for display (best line,
        deeper eval) only.
        """
        for record in records:
            if record["severity"] != "blunder":
                continue
            board = chess.Board(record["fen_before"])
            best, cp_white, pv_san = self._deep_analyze(board)
            if best is None or cp_white is None:
                continue
            record["deep_best_move"] = best.uci()
            record["deep_eval"] = int(
                cp_white if user_color == chess.WHITE else -cp_white
            )
            record["pv_san"] = pv_san

    # -- per-game analysis ------------------------------------------------

    def analyze_game(self, game: dict[str, Any]) -> dict[str, Any]:
        """Analyze one normalized game dict (see services/fetcher.py).

        Returns a JSON-serializable analysis::

            {
                "game": <the input game dict, minus the raw PGN>,
                "moves": [per-user-move records],
                "max_eval_cp": int,   # best user-perspective eval reached
            }

        Per-move records carry everything the classifier and aggregator
        need, including the FEN trail around the move.
        """
        user_color = chess.WHITE if game["user_color"] == "white" else chess.BLACK
        parsed = chess.pgn.read_game(io.StringIO(game["pgn"]))
        if parsed is None:
            return ensure_game_context(
                {"game": _game_meta(game), "moves": [], "max_eval_cp": 0}, game
            )

        clocks = {c["ply"]: c for c in game.get("clocks", [])}
        moves = list(parsed.mainline_moves())

        board = parsed.board()
        # Trail of (fen_before_move, move) so the classifier can see the
        # opponent's previous move and the position before it.
        history: list[tuple[str, chess.Move | None]] = [(board.fen(), None)]

        records: list[dict[str, Any]] = []
        max_eval_cp = -MATE_CP

        for ply, move in enumerate(moves):
            fen_before = board.fen()
            move_number = board.fullmove_number
            is_user_move = board.turn == user_color

            if is_user_move:
                san = board.san(move)
                eval_before_white, best_move, eval_source = self._evaluate(board, ply)
                eval_before = (
                    eval_before_white if user_color == chess.WHITE else -eval_before_white
                )
                max_eval_cp = max(max_eval_cp, eval_before)

                board.push(move)
                fen_after = board.fen()
                eval_after_white, _, _ = self._evaluate(board, ply + 1)
                eval_after = (
                    eval_after_white if user_color == chess.WHITE else -eval_after_white
                )
                max_eval_cp = max(max_eval_cp, eval_after)

                cp_loss = eval_before - eval_after
                wp_drop = win_probability(eval_before) - win_probability(eval_after)

                if cp_loss >= BLUNDER_CP or wp_drop >= BLUNDER_WP_DROP:
                    severity = "blunder"
                elif cp_loss >= MISTAKE_CP:
                    severity = "mistake"
                elif cp_loss >= INACCURACY_CP:
                    severity = "inaccuracy"
                else:
                    severity = "ok"

                # Opponent reply (next ply) and its resulting FEN.
                reply_uci: str | None = None
                fen_after_reply: str | None = None
                if ply + 1 < len(moves):
                    reply = moves[ply + 1]
                    reply_uci = reply.uci()
                    probe = board.copy()
                    probe.push(reply)
                    fen_after_reply = probe.fen()

                # Opponent's previous move and the FEN before it.
                # history[i] == (fen at start of ply i, moves[i-1]); it is
                # appended at the end of the previous iteration, so
                # history[ply] already exists here for ply >= 1.
                opp_prev_uci: str | None = None
                fen_before_opp_move: str | None = None
                if ply >= 1:
                    prev_move = history[ply][1]
                    prev_fen = history[ply - 1][0]
                    if prev_move is not None:
                        opp_prev_uci = prev_move.uci()
                        fen_before_opp_move = prev_fen

                clock = clocks.get(ply, {})
                best_san = None
                best_uci = None
                if best_move is not None:
                    probe = chess.Board(fen_before)
                    try:
                        best_san = probe.san(best_move)
                        best_uci = best_move.uci()
                    except ValueError:
                        best_san = None
                        best_uci = None

                records.append(
                    {
                        "move_number": move_number,
                        "ply": ply,
                        "phase": phase_for(move_number),
                        "san": san,
                        "uci": move.uci(),
                        "eval_before_cp": int(eval_before),
                        "eval_after_cp": int(eval_after),
                        "cp_loss": int(cp_loss),
                        "win_prob_drop": round(float(wp_drop), 2),
                        "best_move_san": best_san,
                        "best_move_uci": best_uci,
                        "fen_before": fen_before,
                        "board_before_fen": fen_before,
                        "board_after_fen": fen_after,
                        "fen_after": fen_after,
                        "reply_uci": reply_uci,
                        "fen_after_reply": fen_after_reply,
                        "opp_prev_uci": opp_prev_uci,
                        "fen_before_opp_move": fen_before_opp_move,
                        "clock_seconds": clock.get("clock_seconds"),
                        "move_time_seconds": clock.get("move_time_seconds"),
                        "severity": severity,
                        "eval_source": eval_source,
                    }
                )
            else:
                board.push(move)

            history.append((board.fen(), move))

        # Pass 2: deep re-analysis of blunder positions only. Pass-1
        # numbers (flagging, eval series) are untouched.
        self._deep_pass(records, user_color)

        return ensure_game_context(
            {
                "game": _game_meta(game),
                "moves": records,
                "max_eval_cp": int(max_eval_cp) if records else 0,
            },
            game,
        )


def build_eval_series(
    records: list[dict[str, Any]], user_color: chess.Color, total_plies: int
) -> list[dict[str, int]]:
    """Per-ply eval series (centipawns, White's perspective, mates ±10000).

    Entry ``ply`` k is the evaluation of the position AFTER k half-moves
    (ply 0 is the start position), so the series has ``total_plies + 1``
    entries and lines up with the frontend's replay cursor. Assembled
    purely from the per-move records the engine already computed — no
    extra engine calls. A position with no computed eval (the start
    position when the user is Black, or a trailing opponent ply) carries
    the previous value forward (0 for the start).
    """
    # Position evals in the user's perspective, keyed by half-moves played:
    # a user record's eval-before is the position at its own ply, its
    # eval-after the position one half-move later.
    pos: dict[int, int] = {}
    for record in records:
        pos[record["ply"]] = record["eval_before_cp"]
        pos[record["ply"] + 1] = record["eval_after_cp"]
    series: list[dict[str, int]] = []
    prev_cp_user = 0
    for k in range(total_plies + 1):
        if k in pos:
            prev_cp_user = pos[k]
        cp = prev_cp_user if user_color == chess.WHITE else -prev_cp_user
        series.append({"ply": k, "cp": int(cp)})
    return series


def ensure_game_context(analysis: dict[str, Any], game: dict[str, Any]) -> dict[str, Any]:
    """Fill in full-game context on an analysis (idempotent).

    Adds ``moves_san`` / ``moves_uci`` (whole game, from the PGN — no
    engine calls) and ``eval_series`` (rebuilt from the cached per-move
    records) to the analysis's game dict, plus ``game_id`` / ``game_date``
    when missing. Fresh analyses already carry these; this is what makes
    older cached analyses usable by the v2 frontend without re-analysis.
    """
    meta = analysis.setdefault("game", {})
    meta.setdefault("game_id", cache_key("game", game.get("pgn", "")))
    if not meta.get("game_date"):
        meta["game_date"] = game.get("date")
    if (
        "moves_san" in meta
        and "moves_uci" in meta
        and "eval_series" in meta
    ):
        return analysis
    parsed = None
    if game.get("pgn"):
        try:
            parsed = chess.pgn.read_game(io.StringIO(game["pgn"]))
        except ValueError:
            parsed = None
    if parsed is None:
        meta.setdefault("moves_san", [])
        meta.setdefault("moves_uci", [])
        meta.setdefault("eval_series", [])
        return analysis
    board = parsed.board()
    sans: list[str] = []
    ucis: list[str] = []
    for move in parsed.mainline_moves():
        sans.append(board.san(move))
        ucis.append(move.uci())
        board.push(move)
    meta.setdefault("moves_san", sans)
    meta.setdefault("moves_uci", ucis)
    user_color = chess.WHITE if game.get("user_color") == "white" else chess.BLACK
    meta.setdefault(
        "eval_series",
        build_eval_series(analysis.get("moves", []), user_color, len(ucis)),
    )
    return analysis


def _game_meta(game: dict[str, Any]) -> dict[str, Any]:
    return {
        "url": game.get("url", ""),
        "user_color": game.get("user_color", ""),
        "result": game.get("result", ""),
        "opponent": game.get("opponent", "?"),
        "eco": game.get("eco", ""),
        "eco_name": game.get("eco_name", "Unknown Opening"),
        "time_class": game.get("time_class", ""),
        "game_id": cache_key("game", game.get("pgn", "")),
        "game_date": game.get("date"),
    }
