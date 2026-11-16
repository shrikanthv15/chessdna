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

One engine process is kept open for a whole job and closed at the end.
Each search is bounded by both depth and a 10s engine-side time cap so a
single pathological position cannot stall a job.
"""
from __future__ import annotations

import io
import math
from typing import Any

import chess
import chess.engine
import chess.pgn

MATE_CP = 10000
BLUNDER_CP = 150
BLUNDER_WP_DROP = 15.0
MISTAKE_CP = 80
INACCURACY_CP = 40
SEARCH_TIME_CAP_SECONDS = 10.0


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

    def __init__(self, stockfish_path: str, depth: int = 12):
        self.stockfish_path = stockfish_path
        self.depth = depth
        self.engine: chess.engine.SimpleEngine | None = None
        self._eval_cache: dict[str, tuple[int, chess.Move | None]] = {}

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

    def _evaluate(self, board: chess.Board) -> tuple[int, chess.Move | None]:
        """Return (cp from White's perspective, best move) for ``board``.

        Results are cached per FEN so transpositions and the shared
        before/after positions of consecutive moves cost one search.
        """
        fen = board.fen()
        cached = self._eval_cache.get(fen)
        if cached is not None:
            return cached

        if board.is_checkmate():
            # Side to move is mated: terrible for them.
            cp = -MATE_CP if board.turn == chess.WHITE else MATE_CP
            result = (cp, None)
            self._eval_cache[fen] = result
            return result
        if board.is_stalemate() or board.is_insufficient_material():
            result = (0, None)
            self._eval_cache[fen] = result
            return result

        assert self.engine is not None
        limit = chess.engine.Limit(depth=self.depth, time=SEARCH_TIME_CAP_SECONDS)
        info = self.engine.analyse(board, limit)
        score = info["score"].white()
        cp = score.score(mate_score=MATE_CP)
        pv = info.get("pv") or []
        best = pv[0] if pv else None
        result = (cp, best)
        self._eval_cache[fen] = result
        return result

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
            return {"game": _game_meta(game), "moves": [], "max_eval_cp": 0}

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
                eval_before_white, best_move = self._evaluate(board)
                eval_before = (
                    eval_before_white if user_color == chess.WHITE else -eval_before_white
                )
                max_eval_cp = max(max_eval_cp, eval_before)

                board.push(move)
                fen_after = board.fen()
                eval_after_white, _ = self._evaluate(board)
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
                    }
                )
            else:
                board.push(move)

            history.append((board.fen(), move))

        return {
            "game": _game_meta(game),
            "moves": records,
            "max_eval_cp": int(max_eval_cp) if records else 0,
        }


def _game_meta(game: dict[str, Any]) -> dict[str, Any]:
    return {
        "url": game.get("url", ""),
        "user_color": game.get("user_color", ""),
        "result": game.get("result", ""),
        "opponent": game.get("opponent", "?"),
        "eco": game.get("eco", ""),
        "eco_name": game.get("eco_name", "Unknown Opening"),
        "time_class": game.get("time_class", ""),
    }
