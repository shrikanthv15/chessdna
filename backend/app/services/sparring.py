"""Single-position evaluation for the sparring / play-with-bots UI.

``POST /api/position`` (see ``app/main.py``) evaluates one FEN, optionally
with a played move, and classifies the move with the same blind-spot
classifier the batch analysis uses. Unlike batch analysis this never
touches the analysis job lock: a short-lived Stockfish process is opened
per request (3s time cap per search), so sparring works while a job runs.

Evaluation tiers mirror batch analysis: terminal positions are scored
without a search; early positions (ply <= CLOUD_EVAL_MAX_PLY) try the
Lichess cloud database first (disk-cached, silent fallback); everything
else goes to local Stockfish. chessdb.cn was measured and rejected as a
tier (0/20 middlegame hits, no eval/depth, p50 726ms — see config.py), so
``eval_source`` is "cloud" or "local" in practice; the contract keeps
"chessdb" as a possible value if a tier is ever added.

Eval conventions match ``analyzer/engine.py``: centipawns from White's
perspective in position evals, mates encoded as ±MATE_CP (adjusted by
distance for cloud mates). ``cp_loss`` / ``win_prob_drop`` in the played
object are from the mover's perspective.
"""
from __future__ import annotations

from dataclasses import dataclass

import chess
import chess.engine

from ..analyzer.classifier import classify_move
from ..analyzer.engine import MATE_CP, win_probability
from ..config import settings
from .cloud_eval import CloudEvalClient, get_default_client

SPARRING_TIME_CAP_SECONDS = 3.0
SPARRING_PV_PLIES = 6


@dataclass(frozen=True)
class PositionEval:
    """One evaluated position (White-perspective eval)."""

    cp_white: int
    best_move: chess.Move | None
    pv_san: list[str]
    source: str  # "cloud" | "local" | "chessdb"


def parse_position(fen: str) -> chess.Board:
    """Parse + validate a FEN. Raises ValueError on invalid input."""
    try:
        board = chess.Board(fen)
    except ValueError as exc:
        raise ValueError(f"Invalid FEN: {fen!r}") from exc
    if not board.is_valid():
        raise ValueError(f"Invalid FEN (illegal position): {fen!r}")
    return board


def parse_move(board: chess.Board, move_uci: str) -> chess.Move:
    """Parse + legality-check a UCI move. Raises ValueError if illegal."""
    try:
        move = chess.Move.from_uci(move_uci)
    except ValueError as exc:
        raise ValueError(f"Invalid move UCI: {move_uci!r}") from exc
    if move not in board.legal_moves:
        raise ValueError(f"Illegal move {move_uci!r} in this position")
    return move


def ply_of(board: chess.Board) -> int:
    """Half-moves played, derived from the FEN counters (for the cloud gate)."""
    return (board.fullmove_number - 1) * 2 + (1 if board.turn == chess.BLACK else 0)


class SparringEvaluator:
    """Per-request evaluator: cloud tier + lazily-opened Stockfish."""

    def __init__(
        self,
        stockfish_path: str | None,
        depth: int = 16,
        cloud_client: CloudEvalClient | None = None,
        cloud_enabled: bool | None = None,
    ):
        self.stockfish_path = stockfish_path
        self.depth = depth
        self._engine: chess.engine.SimpleEngine | None = None
        if cloud_enabled is None:
            cloud_enabled = settings.CLOUD_EVAL_ENABLED
        self._cloud_client: CloudEvalClient | None = None
        if cloud_enabled:
            try:
                self._cloud_client = cloud_client or get_default_client()
            except Exception:
                self._cloud_client = None

    def __enter__(self) -> "SparringEvaluator":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        if self._engine is not None:
            try:
                self._engine.quit()
            except Exception:
                pass
            self._engine = None

    def _get_engine(self) -> chess.engine.SimpleEngine:
        if self._engine is None:
            if not self.stockfish_path:
                raise RuntimeError(
                    "Stockfish binary not found. Run "
                    "backend/scripts/setup_stockfish.sh and set STOCKFISH_PATH "
                    "in backend/.env."
                )
            self._engine = chess.engine.SimpleEngine.popen_uci(self.stockfish_path)
            self._engine.configure({"Threads": 1, "Hash": 64})
        return self._engine

    def evaluate(self, board: chess.Board) -> PositionEval:
        """Evaluate one position (cloud tier, then local Stockfish)."""
        if board.is_checkmate():
            cp = -MATE_CP if board.turn == chess.WHITE else MATE_CP
            return PositionEval(cp_white=cp, best_move=None, pv_san=[], source="local")
        if board.is_stalemate() or board.is_insufficient_material():
            return PositionEval(cp_white=0, best_move=None, pv_san=[], source="local")

        if self._cloud_client is not None and ply_of(board) <= settings.CLOUD_EVAL_MAX_PLY:
            cloud = self._cloud_client.lookup(board)
            if cloud is not None:
                # Cloud returns the best move only, no PV: the PV is the
                # best move alone (honest — never invent a longer line).
                try:
                    best_san = board.san(cloud.best_move)
                except ValueError:
                    best_san = None
                return PositionEval(
                    cp_white=cloud.cp_white,
                    best_move=cloud.best_move,
                    pv_san=[best_san] if best_san else [],
                    source="cloud",
                )

        engine = self._get_engine()
        limit = chess.engine.Limit(depth=self.depth, time=SPARRING_TIME_CAP_SECONDS)
        info = engine.analyse(board, limit)
        cp = info["score"].white().score(mate_score=MATE_CP)
        pv = info.get("pv") or []
        best = pv[0] if pv else None
        pv_san: list[str] = []
        probe = board.copy(stack=False)
        for move in pv[:SPARRING_PV_PLIES]:
            try:
                pv_san.append(probe.san(move))
            except ValueError:
                break
            probe.push(move)
        return PositionEval(cp_white=cp, best_move=best, pv_san=pv_san, source="local")


def analyze_position(
    fen: str,
    move_uci: str | None,
    depth: int,
    stockfish_path: str | None,
    cloud_client: CloudEvalClient | None = None,
) -> dict:
    """Full sparring response for one position (+ optional played move).

    Raises ValueError on invalid FEN / illegal move (the route maps it
    to HTTP 400). Never touches the analysis job lock.
    """
    board = parse_position(fen)
    mover = board.turn
    move = parse_move(board, move_uci) if move_uci else None

    with SparringEvaluator(stockfish_path, depth=depth, cloud_client=cloud_client) as evaluator:
        position = evaluator.evaluate(board)
        best_san = None
        if position.best_move is not None:
            try:
                best_san = board.san(position.best_move)
            except ValueError:
                best_san = None

        played = None
        if move is not None:
            move_san = board.san(move)
            after = board.copy(stack=False)
            after.push(move)
            after_eval = evaluator.evaluate(after)
            eval_before_user = (
                position.cp_white if mover == chess.WHITE else -position.cp_white
            )
            eval_after_user = (
                after_eval.cp_white if mover == chess.WHITE else -after_eval.cp_white
            )
            classification = classify_move(
                fen_before=board.fen(),
                user_move_uci=move.uci(),
                fen_after=after.fen(),
                reply_uci=None,
                fen_after_reply=None,
                opp_prev_uci=None,
                fen_before_opp_move=None,
                clock_seconds=None,
                move_time_seconds=None,
                user_color=mover,
                best_move_uci=(
                    position.best_move.uci() if position.best_move else None
                ),
                eval_before_cp=eval_before_user,
                eval_after_cp=eval_after_user,
            )
            played = {
                "move_uci": move.uci(),
                "move_san": move_san,
                "eval_after_cp_white": int(after_eval.cp_white),
                "cp_loss_user": int(eval_before_user - eval_after_user),
                "win_prob_drop": round(
                    float(
                        win_probability(eval_before_user)
                        - win_probability(eval_after_user)
                    ),
                    2,
                ),
                "tags": classification.tags,
                "primary": classification.primary,
                "explanations": classification.explanations,
            }

    return {
        "fen": board.fen(),
        "turn": "w" if board.turn == chess.WHITE else "b",
        "eval_cp_white": int(position.cp_white),
        "best_move_uci": position.best_move.uci() if position.best_move else None,
        "best_move_san": best_san,
        "pv_san": position.pv_san,
        "eval_source": position.source,
        "played": played,
    }
