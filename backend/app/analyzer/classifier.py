"""Human blind-spot classifier.

Given a flagged move (win probability dropped >= 15 points or centipawn
loss >= 150), inspect the board state before and after the move — plus the
opponent's previous move, the opponent's reply, and clock data — and tag
the *cognitive* root cause. A move may carry multiple tags; ``primary`` is
the highest-priority tag.

Tags (priority order for ``primary``):

    abandoned_defender
        The piece just moved was the sole defender of another piece, and
        the opponent immediately captured the newly undefended piece.
    missed_opponent_threat
        The opponent's previous move created a direct threat (an attacked,
        undefended piece, or mate in one); the user's move ignored it and
        the opponent's reply collected on it.
    hope_chess_hanging_piece
        The user attacked or checked while leaving one of their own pieces
        completely undefended.
    backward_or_long_range_blindness
        The punishing reply was a backward retreat or a long-range slider
        (bishop/rook/queen) striking from >= 4 squares away.
    time_scramble_panic
        The blunder came with < 25 seconds on the clock, or in < 2 seconds
        of think time in a critical position.
    conversion_collapse
        Game-level tag, attached by the aggregator: the user held a winning
        evaluation (+3.0) and still lost or drew.

When no rule fires, the move is tagged ``unclassified``.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import chess

TAG_PRIORITY = [
    "abandoned_defender",
    "missed_opponent_threat",
    "hope_chess_hanging_piece",
    "backward_or_long_range_blindness",
    "time_scramble_panic",
    "conversion_collapse",
]

UNCLASSIFIED = "unclassified"

CLOCK_PANIC_SECONDS = 25.0
FAST_MOVE_SECONDS = 2.0
LONG_RANGE_SQUARES = 4


@dataclass
class Classification:
    tags: list[str] = field(default_factory=list)
    primary: str = UNCLASSIFIED
    explanations: dict[str, str] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _piece_label(board: chess.Board, square: chess.Square) -> str:
    piece = board.piece_at(square)
    if piece is None:
        return "piece"
    return f"{chess.piece_name(piece.piece_type)} on {chess.square_name(square)}"


def _chebyshev(a: chess.Square, b: chess.Square) -> int:
    return max(
        abs(chess.square_file(a) - chess.square_file(b)),
        abs(chess.square_rank(a) - chess.square_rank(b)),
    )


def _captured_square(board: chess.Board, move: chess.Move) -> chess.Square | None:
    """Square of the piece a capturing move removes (en passant aware)."""
    if not board.is_capture(move):
        return None
    if board.is_en_passant(move):
        return chess.square(
            chess.square_file(move.to_square), chess.square_rank(move.from_square)
        )
    return move.to_square


def _undefended_attacked_pieces(
    board: chess.Board, owner: chess.Color
) -> set[chess.Square]:
    """Squares of ``owner``'s non-king pieces that the enemy attacks and
    ``owner`` does not defend."""
    enemy = not owner
    out: set[chess.Square] = set()
    for square in chess.SQUARES:
        piece = board.piece_at(square)
        if piece is None or piece.color != owner or piece.piece_type == chess.KING:
            continue
        if board.is_attacked_by(enemy, square) and not board.is_attacked_by(owner, square):
            out.add(square)
    return out


def _has_mate_in_one(board: chess.Board, attacker: chess.Color) -> bool:
    """Proxy for 'mate threat on the board': does ``attacker`` have a move
    that checkmates, ignoring whose turn it currently is?"""
    probe = board.copy(stack=False)
    probe.turn = attacker
    for move in probe.legal_moves:
        probe.push(move)
        mated = probe.is_checkmate()
        probe.pop()
        if mated:
            return True
    return False


def _san(board: chess.Board, move_uci: str | None) -> str | None:
    if not move_uci:
        return None
    try:
        return board.san(chess.Move.from_uci(move_uci))
    except ValueError:
        return move_uci


# ---------------------------------------------------------------------------
# individual taggers
# ---------------------------------------------------------------------------


def _tag_abandoned_defender(
    board_before: chess.Board,
    user_move: chess.Move,
    board_after: chess.Board,
    reply: chess.Move | None,
) -> str | None:
    """Did the moved piece solely defend a piece the reply then captured?"""
    if reply is None:
        return None
    user = board_before.turn
    from_sq = user_move.from_square
    solely_defended: set[chess.Square] = set()
    for square in chess.SQUARES:
        piece = board_before.piece_at(square)
        if piece is None or piece.color != user or square == from_sq:
            continue
        if piece.piece_type == chess.KING:
            continue
        defenders = board_before.attackers(user, square)
        if set(defenders) == {from_sq}:
            solely_defended.add(square)
    if not solely_defended:
        return None
    captured = _captured_square(board_after, reply)
    if captured is None or captured not in solely_defended:
        return None
    moved = _piece_label(board_before, from_sq)
    victim = _piece_label(board_before, captured)
    return (
        f"Your {moved} was the only defender of the {victim}; moving it "
        f"left the {victim} undefended and the reply captured it for free."
    )


def _reply_is_punishing(
    board_after: chess.Board,
    reply: chess.Move,
    board_after_reply: chess.Board | None,
) -> bool:
    """Does the reply actually exploit the blunder — a capture, a check
    (including discovered checks from a retreat), or a newly hanging piece?
    This keeps quiet, unrelated replies from tripping the blindness tag."""
    if board_after.is_capture(reply):
        return True
    if board_after.gives_check(reply):
        return True
    if board_after_reply is not None:
        user = not board_after.turn
        before = _undefended_attacked_pieces(board_after, user)
        after = _undefended_attacked_pieces(board_after_reply, user)
        if after - before:
            return True
    return False


def _tag_backward_or_long_range(
    board_after: chess.Board,
    reply: chess.Move | None,
    board_after_reply: chess.Board | None,
) -> str | None:
    """Was the punishing reply a retreat or a long-range slider strike?"""
    if reply is None:
        return None
    if not _reply_is_punishing(board_after, reply, board_after_reply):
        return None
    mover = board_after.turn  # the opponent, to move on board_after
    piece = board_after.piece_at(reply.from_square)
    if piece is None:
        return None
    origin, dest = reply.from_square, reply.to_square
    from_rank, to_rank = chess.square_rank(origin), chess.square_rank(dest)
    is_retreat = (to_rank < from_rank) if mover == chess.WHITE else (to_rank > from_rank)
    distance = _chebyshev(origin, dest)
    is_slider = piece.piece_type in (chess.BISHOP, chess.ROOK, chess.QUEEN)

    reason: str | None = None
    if is_retreat:
        reason = "backward retreat"
    if is_slider and distance >= LONG_RANGE_SQUARES:
        reason = f"long-range {chess.piece_name(piece.piece_type)} strike from {distance} squares away"
    if reason is None and is_slider and board_after_reply is not None:
        # Sniper: the replying slider attacks an undefended piece from afar.
        user = not mover
        for square in chess.SQUARES:
            victim = board_after_reply.piece_at(square)
            if victim is None or victim.color != user or victim.piece_type == chess.KING:
                continue
            if (
                dest in board_after_reply.attackers(mover, square)
                and not board_after_reply.is_attacked_by(user, square)
                and _chebyshev(dest, square) >= LONG_RANGE_SQUARES
            ):
                reason = (
                    f"long-range sniper: the {chess.piece_name(piece.piece_type)} "
                    f"on {chess.square_name(dest)} now hits your "
                    f"{chess.piece_name(victim.piece_type)} from "
                    f"{_chebyshev(dest, square)} squares away"
                )
                break
    if reason is None:
        return None
    san = _san(board_after, reply.uci())
    return (
        f"The punishment came from a {reason} ({san}) — the kind of "
        f"quiet, far-away move that is easy to miss while focused on the "
        f"action in front of you."
    )


def _tag_missed_opponent_threat(
    board_before: chess.Board,
    board_after: chess.Board,
    reply: chess.Move | None,
    board_after_reply: chess.Board | None,
    board_before_opp_move: chess.Board | None,
    opp_prev_san: str | None,
) -> str | None:
    """Did the opponent's previous move create a threat the user ignored?"""
    if reply is None:
        return None
    user = board_before.turn
    opp = not user

    threats_now = _undefended_attacked_pieces(board_before, user)
    if board_before_opp_move is not None:
        threats_before = _undefended_attacked_pieces(board_before_opp_move, user)
        new_threats = threats_now - threats_before
        mate_is_new = _has_mate_in_one(board_before, opp) and not _has_mate_in_one(
            board_before_opp_move, opp
        )
    else:
        new_threats = threats_now
        mate_is_new = _has_mate_in_one(board_before, opp)

    # Unresolved piece threat, punished by the reply's capture.
    captured = _captured_square(board_after, reply)
    threats_after = _undefended_attacked_pieces(board_after, user)
    for square in new_threats:
        piece_before = board_before.piece_at(square)
        piece_after = board_after.piece_at(square)
        still_there = (
            piece_before is not None
            and piece_after is not None
            and piece_after.piece_type == piece_before.piece_type
            and piece_after.color == piece_before.color
        )
        if still_there and square in threats_after and captured == square:
            label = _piece_label(board_before, square)
            prev = f" After {opp_prev_san}," if opp_prev_san else ""
            return (
                f"{prev} your {label} was attacked and undefended. Your move "
                f"didn't address the threat, and the reply collected it."
            )

    # Unresolved mate threat, punished by actual mate.
    if (
        mate_is_new
        and _has_mate_in_one(board_after, opp)
        and board_after_reply is not None
        and board_after_reply.is_checkmate()
    ):
        return (
            "The opponent was threatening mate in one; your move didn't stop "
            "it, and the reply delivered checkmate."
        )
    return None


def _tag_hope_chess(
    board_before: chess.Board,
    user_move: chess.Move,
    board_after: chess.Board,
) -> str | None:
    """Did the user attack/check while leaving a piece hanging?"""
    user = board_before.turn
    opp = not user
    aggressive = board_before.is_capture(user_move) or board_after.is_check()
    if not aggressive:
        return None
    hanging = _undefended_attacked_pieces(board_after, user)
    if not hanging:
        return None
    # Name the most valuable hanging piece.
    values = {
        chess.PAWN: 1,
        chess.KNIGHT: 3,
        chess.BISHOP: 3,
        chess.ROOK: 5,
        chess.QUEEN: 9,
    }
    worst = max(
        hanging,
        key=lambda sq: values.get(board_after.piece_at(sq).piece_type, 0),  # type: ignore[union-attr]
    )
    san = _san(board_before, user_move.uci())
    return (
        f"You played the aggressive {san} while your "
        f"{_piece_label(board_after, worst)} was left completely undefended — "
        f"hope chess: attacking and praying the opponent doesn't notice."
    )


def _tag_time_scramble(
    clock_seconds: float | None,
    move_time_seconds: float | None,
) -> str | None:
    if clock_seconds is not None and clock_seconds < CLOCK_PANIC_SECONDS:
        return (
            f"This blunder came with only {clock_seconds:.0f} seconds left on "
            f"the clock — a time-scramble decision, not a calculation failure."
        )
    if move_time_seconds is not None and move_time_seconds < FAST_MOVE_SECONDS:
        return (
            "This move was played in under 2 seconds in a critical position — "
            "too fast to have calculated the consequences."
        )
    return None


# ---------------------------------------------------------------------------
# public entry point
# ---------------------------------------------------------------------------


def classify_move(
    fen_before: str,
    user_move_uci: str,
    fen_after: str,
    reply_uci: str | None,
    fen_after_reply: str | None,
    opp_prev_uci: str | None,
    fen_before_opp_move: str | None,
    clock_seconds: float | None,
    move_time_seconds: float | None,
    user_color: chess.Color,
) -> Classification:
    """Classify one flagged move. Boards are rebuilt from FENs so this is
    pure and usable from cached engine records."""
    board_before = chess.Board(fen_before)
    board_after = chess.Board(fen_after)
    user_move = chess.Move.from_uci(user_move_uci)
    reply = chess.Move.from_uci(reply_uci) if reply_uci else None
    board_after_reply = chess.Board(fen_after_reply) if fen_after_reply else None
    board_before_opp = chess.Board(fen_before_opp_move) if fen_before_opp_move else None

    opp_prev_san = (
        _san(board_before_opp, opp_prev_uci) if board_before_opp is not None else None
    )

    explanations: dict[str, str] = {}

    found = _tag_abandoned_defender(board_before, user_move, board_after, reply)
    if found:
        explanations["abandoned_defender"] = found

    found = _tag_missed_opponent_threat(
        board_before, board_after, reply, board_after_reply, board_before_opp, opp_prev_san
    )
    if found:
        explanations["missed_opponent_threat"] = found

    found = _tag_hope_chess(board_before, user_move, board_after)
    if found:
        explanations["hope_chess_hanging_piece"] = found

    found = _tag_backward_or_long_range(board_after, reply, board_after_reply)
    if found:
        explanations["backward_or_long_range_blindness"] = found

    found = _tag_time_scramble(clock_seconds, move_time_seconds)
    if found:
        explanations["time_scramble_panic"] = found

    if not explanations:
        return Classification(
            tags=[UNCLASSIFIED],
            primary=UNCLASSIFIED,
            explanations={UNCLASSIFIED: "Tactical oversight — no single pattern matched."},
        )

    tags = sorted(explanations, key=TAG_PRIORITY.index)
    return Classification(tags=tags, primary=tags[0], explanations=explanations)


def classify_record(record: dict, user_color: chess.Color) -> Classification:
    """Classify an engine per-move record (see analyzer/engine.py)."""
    return classify_move(
        fen_before=record["fen_before"],
        user_move_uci=record["uci"],
        fen_after=record["fen_after"],
        reply_uci=record.get("reply_uci"),
        fen_after_reply=record.get("fen_after_reply"),
        opp_prev_uci=record.get("opp_prev_uci"),
        fen_before_opp_move=record.get("fen_before_opp_move"),
        clock_seconds=record.get("clock_seconds"),
        move_time_seconds=record.get("move_time_seconds"),
        user_color=user_color,
    )
