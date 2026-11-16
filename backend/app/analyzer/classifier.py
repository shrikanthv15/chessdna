"""Human blind-spot classifier.

Given a flagged move (win probability dropped >= 15 points or centipawn
loss >= 150), inspect the board state before and after the move — plus the
opponent's previous move, the opponent's reply, clock data, and what the
engine's best move accomplishes — and tag the *cognitive* root cause. A
move may carry multiple tags; ``primary`` is the highest-priority tag.

Tags (priority order for ``primary``):

    missed_mate
        A forced mate in 1-3 was on the board (engine eval at mate
        encoding, verified by a short forced-mate search) and the move
        missed it.
    abandoned_defender
        The piece just moved was the sole defender of another piece, and
        the opponent immediately captured the newly undefended piece.
    missed_tactic
        The engine's best move wins material or mates — a capture with
        positive static exchange evaluation, a check that leaves a piece
        hanging, or a fork / double attack — and the move missed it.
    missed_defense
        The opponent had an active, material-winning threat before the
        move (a piece that could be profitably captured, or mate in one)
        and the move neither addressed it nor created a bigger
        counter-threat. Broader than missed_opponent_threat: it does not
        require the reply to collect on the exact piece.
    missed_opponent_threat
        The opponent's previous move created a direct threat (an attacked,
        undefended piece, or mate in one); the user's move ignored it and
        the opponent's reply collected on it.
    hope_chess_hanging_piece
        The user attacked or checked while leaving one of their own pieces
        completely undefended.
    left_piece_hanging
        The move leaves one of the user's own pieces attacked and
        undefended (whether or not the reply took it). Broader than
        hope_chess: no aggressive move required.
    backward_or_long_range_blindness
        The punishing reply was a backward retreat or a long-range slider
        (bishop/rook/queen) striking from >= 4 squares away.
    king_safety
        The move pushed a pawn out of the shelter in front of the king and
        a new enemy attack landed on the king's immediate vicinity.
    time_scramble_panic
        The blunder came with < 25 seconds on the clock, or in < 2 seconds
        of think time in a critical position.
    conversion_collapse
        Game-level tag, attached by the aggregator: the user held a winning
        evaluation (+3.0) and still lost or drew.

When no rule fires, the move keeps ``primary == "unclassified"`` but still
gets a concrete position-delta explanation (what the best move does, what
the eval did, what was left hanging) — never a generic filler line. Every
claim in every explanation is verified against the position with
python-chess; patterns that are not on the board are never invented.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import chess

from .engine import MATE_CP

TAG_PRIORITY = [
    "missed_mate",
    "abandoned_defender",
    "missed_tactic",
    "missed_defense",
    "missed_opponent_threat",
    "hope_chess_hanging_piece",
    "left_piece_hanging",
    "backward_or_long_range_blindness",
    "king_safety",
    "time_scramble_panic",
    "conversion_collapse",
]

UNCLASSIFIED = "unclassified"

CLOCK_PANIC_SECONDS = 25.0
FAST_MOVE_SECONDS = 2.0
LONG_RANGE_SQUARES = 4
MATE_WINDOW_CP = 3  # "missed mate" covers mate in 1-3
TACTIC_MIN_SEE_CP = 100  # a tactic must win at least a pawn of material
MINOR_PIECE_CP = 300

PIECE_VALUES = {
    chess.PAWN: 100,
    chess.KNIGHT: 300,
    chess.BISHOP: 300,
    chess.ROOK: 500,
    chess.QUEEN: 900,
    chess.KING: 100000,
}


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


def _fmt_eval(cp: int) -> str:
    """User-perspective eval as a human string ('+1.5', 'mate in 2')."""
    if cp >= MATE_CP - 100:
        return f"mate in {MATE_CP - cp}"
    if cp <= -MATE_CP + 100:
        return f"mated in {MATE_CP + cp}"
    return f"{cp / 100:+.1f}"


# ---------------------------------------------------------------------------
# static exchange evaluation + material-winning threats
# ---------------------------------------------------------------------------


def _see(board: chess.Board, move: chess.Move) -> int:
    """Static exchange evaluation: net material swing (cp) for the mover.

    Standard swap-list algorithm: least-valuable-attacker captures are
    simulated with x-ray attackers recomputed as pieces leave the board.
    Pins are ignored (standard SEE limitation). Returns 0 for
    non-captures. ``board.turn`` must be the mover's color.
    """
    if not board.is_capture(move):
        return 0
    from_sq, to_sq = move.from_square, move.to_square
    if board.is_en_passant(move):
        cap_sq = chess.square(
            chess.square_file(to_sq), chess.square_rank(from_sq)
        )
    else:
        cap_sq = to_sq
    captured = board.piece_at(cap_sq)
    mover = board.piece_at(from_sq)
    if captured is None or mover is None:
        return 0
    gains = [PIECE_VALUES[captured.piece_type]]
    if move.promotion:
        gains[0] += PIECE_VALUES[move.promotion] - PIECE_VALUES[chess.PAWN]
    occupied = board.occupied ^ chess.BB_SQUARES[from_sq] ^ chess.BB_SQUARES[cap_sq]
    occupied |= chess.BB_SQUARES[to_sq]
    removed = {from_sq, cap_sq}
    target_value = (
        PIECE_VALUES[move.promotion]
        if move.promotion
        else PIECE_VALUES[mover.piece_type]
    )
    turn = not board.turn
    while True:
        attackers = board.attackers_mask(turn, to_sq, occupied)
        best_sq: chess.Square | None = None
        best_value: int | None = None
        for sq in chess.scan_forward(attackers):
            if sq in removed:
                continue
            piece = board.piece_at(sq)
            if piece is None or piece.color != turn:
                continue
            value = PIECE_VALUES[piece.piece_type]
            if best_value is None or value < best_value:
                best_value = value
                best_sq = sq
        if best_sq is None or best_value is None:
            break
        gains.append(target_value - gains[-1])
        removed.add(best_sq)
        occupied ^= chess.BB_SQUARES[best_sq]
        target_value = best_value
        turn = not turn
    score = gains[-1]
    for gain in reversed(gains[:-1]):
        score = -max(-gain, score)
    return score


def _capture_move(
    board: chess.Board, attacker: chess.Square, target: chess.Square
) -> chess.Move:
    """Capture move from ``attacker`` to ``target`` (promotion aware)."""
    piece = board.piece_at(attacker)
    if (
        piece is not None
        and piece.piece_type == chess.PAWN
        and chess.square_rank(target) in (0, 7)
    ):
        return chess.Move(attacker, target, promotion=chess.QUEEN)
    return chess.Move(attacker, target)


def _losing_pieces(board: chess.Board, owner: chess.Color) -> dict[chess.Square, tuple[chess.Square, int]]:
    """Owner pieces the enemy can profitably capture: square -> (attacker, SEE).

    A piece counts only when some enemy capture of it is LEGAL (pinned
    attackers don't count) and wins material (SEE > 0). This is the honest
    definition of 'under a real threat': an undefended piece always
    qualifies, and so does a defended piece attacked by something cheaper
    (pawn takes defended queen). En passant captures are included.
    """
    enemy = not owner
    probe = board.copy(stack=False)
    probe.turn = enemy
    out: dict[chess.Square, tuple[chess.Square, int]] = {}
    for square in chess.SQUARES:
        piece = board.piece_at(square)
        if piece is None or piece.color != owner or piece.piece_type == chess.KING:
            continue
        best: tuple[chess.Square, int] | None = None
        for attacker in board.attackers(enemy, square):
            move = _capture_move(board, attacker, square)
            if not probe.is_legal(move):
                continue
            see = _see(probe, move)
            if see > 0 and (best is None or see > best[1]):
                best = (attacker, see)
        if best is not None:
            out[square] = best
    # En passant: the captured pawn's square is not "attacked" in the
    # bitboard sense, so scan legal moves for ep captures explicitly.
    if board.ep_square is not None:
        for move in probe.legal_moves:
            if not probe.is_en_passant(move):
                continue
            cap_sq = _captured_square(probe, move)
            if cap_sq is None:
                continue
            piece = board.piece_at(cap_sq)
            if piece is None or piece.color != owner:
                continue
            see = _see(probe, move)
            if see > 0 and (cap_sq not in out or see > out[cap_sq][1]):
                out[cap_sq] = (move.from_square, see)
    return out


def _truly_hanging(board: chess.Board, owner: chess.Color) -> dict[chess.Square, chess.Square]:
    """Attacked-and-undefended pieces -> one attacker that can legally
    take each. Stricter than _undefended_attacked_pieces: pinned
    attackers don't count."""
    enemy = not owner
    probe = board.copy(stack=False)
    probe.turn = enemy
    out: dict[chess.Square, chess.Square] = {}
    for square in _undefended_attacked_pieces(board, owner):
        for attacker in board.attackers(enemy, square):
            if probe.is_legal(_capture_move(board, attacker, square)):
                out[square] = attacker
                break
    return out


# ---------------------------------------------------------------------------
# forced-mate search (verification for missed_mate)
# ---------------------------------------------------------------------------


class _BudgetExceeded(Exception):
    pass


def _find_forced_mate(
    board: chess.Board, max_mate_in: int = 3, node_budget: int = 100_000
) -> tuple[int, chess.Move] | None:
    """Search for a forced mate for the side to move.

    Returns (mate_in_moves, first_move) for the shortest forced mate
    found, or None when no mate within ``max_mate_in`` exists or the node
    budget runs out (unverified -> the tag must not fire).
    """
    state = {"nodes": 0}

    def ordered_moves(bd: chess.Board) -> list[chess.Move]:
        # Checks first, then captures: mating lines are forcing lines.
        return sorted(
            bd.legal_moves,
            key=lambda m: (not bd.gives_check(m), not bd.is_capture(m), m.uci()),
        )

    def mate_move(bd: chess.Board, n: int) -> chess.Move | None:
        state["nodes"] += 1
        if state["nodes"] > node_budget:
            raise _BudgetExceeded
        for move in ordered_moves(bd):
            bd.push(move)
            if bd.is_checkmate():
                bd.pop()
                return move
            if n > 1 and not bd.is_stalemate() and not bd.is_insufficient_material():
                all_replies_mated = True
                for reply in list(bd.legal_moves):
                    bd.push(reply)
                    if mate_move(bd, n - 1) is None:
                        all_replies_mated = False
                        bd.pop()
                        break
                    bd.pop()
                if all_replies_mated:
                    bd.pop()
                    return move
            bd.pop()
        return None

    try:
        for n in range(1, max_mate_in + 1):
            probe = board.copy(stack=False)
            found = mate_move(probe, n)
            if found is not None:
                return (n, found)
    except _BudgetExceeded:
        return None
    return None


# ---------------------------------------------------------------------------
# what the best move does (shared by missed_tactic + fallback explainer)
# ---------------------------------------------------------------------------


def _describe_best_move(
    board_before: chess.Board, best_move: chess.Move
) -> list[str]:
    """Verified facts about what the engine's best move accomplishes."""
    facts: list[str] = []
    user = board_before.turn
    opp = not user
    if board_before.is_capture(best_move):
        cap_sq = _captured_square(board_before, best_move)
        piece = board_before.piece_at(cap_sq) if cap_sq is not None else None
        if piece is not None:
            see = _see(board_before, best_move)
            label = f"the {chess.piece_name(piece.piece_type)} on {chess.square_name(cap_sq)}"
            if see > 0:
                facts.append(f"wins {label} ({see}cp of material)")
            else:
                facts.append(f"captures {label}")
    after = board_before.copy(stack=False)
    after.push(best_move)
    if after.is_checkmate():
        facts.append("delivers checkmate")
    elif after.is_check():
        facts.append("gives check")
    hanging_before = _undefended_attacked_pieces(board_before, user)
    for sq in sorted(hanging_before):
        piece = board_before.piece_at(sq)
        if piece is None:
            continue
        label = f"the {chess.piece_name(piece.piece_type)} on {chess.square_name(sq)}"
        if best_move.from_square == sq:
            facts.append(f"moves {label} out of danger")
        elif after.piece_at(sq) is not None and after.is_attacked_by(user, sq):
            facts.append(f"defends {label}")
    for sq in chess.SQUARES:
        victim = after.piece_at(sq)
        if victim is None or victim.color != opp or victim.piece_type == chess.KING:
            continue
        if after.is_attacked_by(user, sq) and not after.is_attacked_by(opp, sq):
            if not (
                board_before.is_attacked_by(user, sq)
                and not board_before.is_attacked_by(opp, sq)
            ):
                facts.append(
                    f"attacks the undefended {chess.piece_name(victim.piece_type)} "
                    f"on {chess.square_name(sq)}"
                )
    # Keep explanations readable: at most three effects, no duplicates.
    seen: set[str] = set()
    unique = [f for f in facts if not (f in seen or seen.add(f))]
    return unique[:3]


# ---------------------------------------------------------------------------
# individual taggers (original five, unchanged)
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
    aggressive = board_before.is_capture(user_move) or board_after.is_check()
    if not aggressive:
        return None
    hanging = _undefended_attacked_pieces(board_after, user)
    if not hanging:
        return None
    # Name the most valuable hanging piece.
    worst = max(
        hanging,
        key=lambda sq: PIECE_VALUES.get(board_after.piece_at(sq).piece_type, 0),  # type: ignore[union-attr]
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
# individual taggers (new in v2)
# ---------------------------------------------------------------------------


def _tag_missed_mate(
    board_before: chess.Board,
    best_move: chess.Move | None,
    eval_before_cp: int | None,
    eval_after_cp: int | None,
    played_san: str | None,
    best_san: str | None,
) -> str | None:
    """Was a forced mate in 1-3 available and missed?

    Gated on the engine eval (mate encoding) and verified with a short
    forced-mate search — the tag fires only when a mate is proven to
    exist on the board, never on the eval number alone.
    """
    if best_move is None or eval_before_cp is None or eval_after_cp is None:
        return None
    if eval_before_cp < MATE_CP - MATE_WINDOW_CP:
        return None
    if eval_after_cp >= MATE_CP - MATE_WINDOW_CP:
        return None  # the played move kept the mate: not missed
    found = _find_forced_mate(board_before, max_mate_in=MATE_WINDOW_CP)
    if found is None:
        return None
    mate_in, first_move = found
    try:
        mate_san = board_before.san(first_move)
    except ValueError:
        mate_san = first_move.uci()
    cp_loss = eval_before_cp - eval_after_cp
    if mate_in == 1:
        return (
            f"Checkmate in one was on the board: {mate_san} mates immediately. "
            f"Your {played_san} missed it, throwing away a forced win "
            f"({cp_loss}cp). Best was {best_san}."
        )
    return (
        f"A forced mate in {mate_in} was available, starting with {mate_san}. "
        f"Your {played_san} missed it, throwing away a forced win "
        f"({cp_loss}cp). Best was {best_san}."
    )


def _tag_missed_tactic(
    board_before: chess.Board,
    best_move: chess.Move | None,
    played_san: str | None,
    best_san: str | None,
) -> str | None:
    """Did the best move win material or fork — and the move miss it?"""
    if best_move is None:
        return None
    user = board_before.turn
    opp = not user

    # (a) Best move is a capture that wins material by force (SEE).
    if board_before.is_capture(best_move):
        see = _see(board_before, best_move)
        if see >= TACTIC_MIN_SEE_CP:
            cap_sq = _captured_square(board_before, best_move)
            piece = board_before.piece_at(cap_sq) if cap_sq is not None else None
            if piece is not None:
                label = (
                    f"the {chess.piece_name(piece.piece_type)} "
                    f"on {chess.square_name(cap_sq)}"
                )
            else:
                label = "material"
            return (
                f"Best was {best_san}, winning {label} ({see}cp of material "
                f"by force). Your {played_san} missed the tactic and let it escape."
            )

    after = board_before.copy(stack=False)
    after.push(best_move)

    # (b) Best move checks and leaves a valuable piece hanging.
    if after.is_check() and not after.is_checkmate():
        for sq in chess.SQUARES:
            victim = after.piece_at(sq)
            if victim is None or victim.color != opp or victim.piece_type == chess.KING:
                continue
            if PIECE_VALUES[victim.piece_type] < MINOR_PIECE_CP:
                continue
            if after.is_attacked_by(user, sq) and not after.is_attacked_by(opp, sq):
                if not (
                    board_before.is_attacked_by(user, sq)
                    and not board_before.is_attacked_by(opp, sq)
                ):
                    return (
                        f"Best was {best_san}: the check forces the king to move, "
                        f"and the {chess.piece_name(victim.piece_type)} on "
                        f"{chess.square_name(sq)} is left hanging. "
                        f"Your {played_san} missed it."
                    )

    # (c) Fork / double attack: 2+ newly attacked enemy pieces, at least
    # one of them a king or an undefended piece worth a minor or more.
    newly: list[chess.Square] = []
    for sq in chess.SQUARES:
        victim = after.piece_at(sq)
        if victim is None or victim.color != opp:
            continue
        if after.is_attacked_by(user, sq) and not board_before.is_attacked_by(user, sq):
            newly.append(sq)
    if len(newly) >= 2:
        strong = [
            sq
            for sq in newly
            if after.piece_at(sq).piece_type == chess.KING  # type: ignore[union-attr]
            or (
                not after.is_attacked_by(opp, sq)
                and PIECE_VALUES[after.piece_at(sq).piece_type] >= MINOR_PIECE_CP  # type: ignore[union-attr]
            )
        ]
        if strong:
            names = " and ".join(
                f"the {chess.piece_name(after.piece_at(sq).piece_type)} "  # type: ignore[union-attr]
                f"on {chess.square_name(sq)}"
                for sq in newly[:3]
            )
            check_note = " with check" if after.is_check() else ""
            return (
                f"Best was {best_san}, a fork{check_note} hitting {names} at "
                f"once — the opponent can only save one. "
                f"Your {played_san} missed it."
            )
    return None


def _tag_left_piece_hanging(
    board_before: chess.Board,
    user_move: chess.Move,
    board_after: chess.Board,
    reply: chess.Move | None,
    played_san: str | None,
    reply_san: str | None,
) -> str | None:
    """Did the move leave one of the user's own pieces hanging?

    Broader than hope_chess: no aggressive move required, and the reply
    need not have taken the piece. A piece counts as hanging when an
    enemy capture of it is legal and wins material (SEE > 0).
    """
    user = board_before.turn
    losing_before = set(_losing_pieces(board_before, user))
    losing_after = _losing_pieces(board_after, user)
    newly = {sq for sq in losing_after if sq not in losing_before}
    if user_move.to_square in losing_after:
        newly.add(user_move.to_square)
    if not newly:
        return None
    worst = max(
        newly,
        key=lambda sq: PIECE_VALUES.get(board_after.piece_at(sq).piece_type, 0),  # type: ignore[union-attr]
    )
    attacker_sq, _see_value = losing_after[worst]
    attacker = board_after.piece_at(attacker_sq)
    attacker_label = (
        f"the {chess.piece_name(attacker.piece_type)} "
        f"on {chess.square_name(attacker_sq)}"
        if attacker is not None
        else "an enemy piece"
    )
    text = (
        f"Your {played_san} left the {_piece_label(board_after, worst)} "
        f"attacked and undefended — {attacker_label} can take it for free."
    )
    if reply is not None:
        captured = _captured_square(board_after, reply)
        if captured == worst:
            text += f" The reply {reply_san} did exactly that."
    return text


def _has_counter_threat(
    board_before: chess.Board,
    user_move: chess.Move,
    board_after: chess.Board,
    threatened_value: int,
) -> bool:
    """Did the user's move create a threat at least as big as the one it
    ignored — a capture winning as much material, or a new attack on an
    undefended enemy piece worth as much?"""
    user = board_before.turn
    opp = not user
    if board_before.is_capture(user_move) and _see(board_before, user_move) >= threatened_value:
        return True
    for sq in chess.SQUARES:
        victim = board_after.piece_at(sq)
        if victim is None or victim.color != opp or victim.piece_type == chess.KING:
            continue
        if PIECE_VALUES[victim.piece_type] < threatened_value:
            continue
        if board_after.is_attacked_by(user, sq) and not board_after.is_attacked_by(opp, sq):
            if not (
                board_before.is_attacked_by(user, sq)
                and not board_before.is_attacked_by(opp, sq)
            ):
                return True
    return False


def _tag_missed_defense(
    board_before: chess.Board,
    board_after: chess.Board,
    user_move: chess.Move,
    reply: chess.Move | None,
    board_after_reply: chess.Board | None,
    opp_prev_san: str | None,
    played_san: str | None,
    reply_san: str | None,
) -> str | None:
    """Was there an active threat before the move that went unanswered?

    Broader than missed_opponent_threat: the threat need not be new, and
    the reply need not collect on it. A threat is a piece the opponent
    can profitably capture (SEE > 0), or mate in one. The move answers it
    by moving the piece, removing the threat, or creating a bigger
    counter-threat.
    """
    user = board_before.turn
    opp = not user
    threats = _losing_pieces(board_before, user)
    losing_after = _losing_pieces(board_after, user)

    unaddressed: list[chess.Square] = []
    for sq in threats:
        # Moving the threatened piece itself answers the threat (even if
        # it lands somewhere else dangerous — that is left_piece_hanging).
        if user_move.from_square == sq:
            continue
        if sq in losing_after:
            unaddressed.append(sq)

    if unaddressed:
        worst = max(
            unaddressed,
            key=lambda sq: PIECE_VALUES.get(board_before.piece_at(sq).piece_type, 0),  # type: ignore[union-attr]
        )
        threatened_value = PIECE_VALUES[board_before.piece_at(worst).piece_type]  # type: ignore[union-attr]
        if not _has_counter_threat(board_before, user_move, board_after, threatened_value):
            label = _piece_label(board_before, worst)
            attacker_sq, _ = threats[worst]
            attacker = board_before.piece_at(attacker_sq)
            attacker_label = (
                f"the {chess.piece_name(attacker.piece_type)} "
                f"on {chess.square_name(attacker_sq)}"
                if attacker is not None
                else "an enemy piece"
            )
            prev = f"After {opp_prev_san}, your" if opp_prev_san else "Your"
            text = (
                f"{prev} {label} was hanging to {attacker_label}. "
                f"Your {played_san} didn't defend it, move it, capture the "
                f"attacker, or create a bigger threat of your own."
            )
            if reply is not None:
                captured = _captured_square(board_after, reply)
                if captured == worst:
                    text += f" The reply {reply_san} took it."
            return text

    # Mate threat: the opponent could mate in one, and still can.
    if (
        _has_mate_in_one(board_before, opp)
        and _has_mate_in_one(board_after, opp)
        and not board_after.is_check()
    ):
        text = (
            "The opponent was threatening mate in one, and your "
            f"{played_san} didn't stop it."
        )
        if board_after_reply is not None and board_after_reply.is_checkmate():
            text += f" The reply {reply_san} delivered checkmate."
        return text
    return None


def _shelter_squares(user: chess.Color, king_sq: chess.Square) -> list[chess.Square]:
    """The three squares directly in front of the king (pawn shelter)."""
    kf, kr = chess.square_file(king_sq), chess.square_rank(king_sq)
    shelter_rank = kr + 1 if user == chess.WHITE else kr - 1
    if not 0 <= shelter_rank <= 7:
        return []
    return [
        chess.square(f, shelter_rank)
        for f in (kf - 1, kf, kf + 1)
        if 0 <= f <= 7
    ]


def _tag_king_safety(
    board_before: chess.Board,
    user_move: chess.Move,
    board_after: chess.Board,
    played_san: str | None,
) -> str | None:
    """Did the move push a shelter pawn and invite a new attack on the king?"""
    user = board_before.turn
    mover = board_before.piece_at(user_move.from_square)
    if mover is None or mover.piece_type != chess.PAWN:
        return None
    king_sq = board_before.king(user)
    if king_sq is None:
        return None
    shelter = _shelter_squares(user, king_sq)
    if user_move.from_square not in shelter:
        return None

    def shelter_pawns(board: chess.Board) -> int:
        return sum(
            1
            for sq in shelter
            if (p := board.piece_at(sq)) is not None
            and p.color == user
            and p.piece_type == chess.PAWN
        )

    if shelter_pawns(board_after) >= shelter_pawns(board_before):
        return None
    opp = not user
    vicinity = [
        sq for sq in chess.SQUARES if sq != king_sq and _chebyshev(sq, king_sq) <= 1
    ]
    new_attacks = [
        sq
        for sq in vicinity
        if board_after.is_attacked_by(opp, sq)
        and not board_before.is_attacked_by(opp, sq)
    ]
    if not new_attacks:
        return None
    target = new_attacks[0]
    attackers = board_after.attackers(opp, target)
    attacker_label = "an enemy piece"
    for attacker_sq in attackers:
        attacker = board_after.piece_at(attacker_sq)
        if attacker is not None:
            attacker_label = (
                f"the {chess.piece_name(attacker.piece_type)} "
                f"on {chess.square_name(attacker_sq)}"
            )
            break
    return (
        f"Your {played_san} pushed a pawn out of the shelter in front of "
        f"your king, and {attacker_label} now hits "
        f"{chess.square_name(target)} right next to the king."
    )


# ---------------------------------------------------------------------------
# fallback explainer: concrete delta narrative when no tag fires
# ---------------------------------------------------------------------------


def _fallback_explain(
    board_before: chess.Board,
    user_move: chess.Move,
    board_after: chess.Board,
    best_move: chess.Move | None,
    eval_before_cp: int | None,
    eval_after_cp: int | None,
    played_san: str | None,
    best_san: str | None,
    reply: chess.Move | None,
    reply_san: str | None,
) -> str:
    """Position-delta explanation for moves no tagger could classify.

    Compares board_before, board_after, and the position after the best
    move, and states only verified facts: the eval swing, what the best
    move accomplishes, and what was left hanging. Never invents a
    pattern.
    """
    user = board_before.turn
    parts: list[str] = []

    if eval_before_cp is not None and eval_after_cp is not None:
        cp_loss = eval_before_cp - eval_after_cp
        parts.append(
            f"Your {played_san} dropped the evaluation from "
            f"{_fmt_eval(eval_before_cp)} to {_fmt_eval(eval_after_cp)} "
            f"({cp_loss}cp)."
        )
    elif played_san:
        parts.append(f"Your {played_san} lost ground in this position.")

    if best_move is not None and best_san:
        effects = _describe_best_move(board_before, best_move)
        if effects:
            parts.append(f"Best was {best_san}, which {', '.join(effects)}.")
        else:
            parts.append(f"Best was {best_san}, which holds the position.")
    elif best_san:
        parts.append(f"Best was {best_san}.")

    losing_before = set(_losing_pieces(board_before, user))
    losing_after = _losing_pieces(board_after, user)
    newly = [sq for sq in losing_after if sq not in losing_before]
    if newly:
        worst = max(
            newly,
            key=lambda sq: PIECE_VALUES.get(board_after.piece_at(sq).piece_type, 0),  # type: ignore[union-attr]
        )
        hanging = (
            f"After your move, the {_piece_label(board_after, worst)} was "
            f"left hanging"
        )
        if reply is not None:
            captured = _captured_square(board_after, reply)
            if captured == worst:
                hanging += f", and the reply {reply_san} took it"
        parts.append(hanging + ".")

    if not parts:
        return (
            "No concrete pattern could be verified from the position — the "
            "move lost ground without a single identifiable tactical cause."
        )
    return " ".join(parts)


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
    best_move_uci: str | None = None,
    eval_before_cp: int | None = None,
    eval_after_cp: int | None = None,
) -> Classification:
    """Classify one flagged move. Boards are rebuilt from FENs so this is
    pure and usable from cached engine records.

    ``best_move_uci`` / ``eval_*_cp`` (user perspective) power the
    best-move-driven taggers; they are optional so legacy callers and
    tests keep working, but without them the tactic/mate taggers cannot
    fire.
    """
    board_before = chess.Board(fen_before)
    board_after = chess.Board(fen_after)
    user_move = chess.Move.from_uci(user_move_uci)
    reply = chess.Move.from_uci(reply_uci) if reply_uci else None
    board_after_reply = chess.Board(fen_after_reply) if fen_after_reply else None
    board_before_opp = chess.Board(fen_before_opp_move) if fen_before_opp_move else None
    best_move = None
    if best_move_uci:
        try:
            candidate = chess.Move.from_uci(best_move_uci)
            if candidate in board_before.legal_moves:
                best_move = candidate
        except ValueError:
            best_move = None

    opp_prev_san = (
        _san(board_before_opp, opp_prev_uci) if board_before_opp is not None else None
    )
    played_san = _san(board_before, user_move_uci)
    best_san = _san(board_before, best_move_uci) if best_move is not None else None
    reply_san = _san(board_after, reply_uci) if reply is not None else None

    explanations: dict[str, str] = {}

    found = _tag_missed_mate(
        board_before, best_move, eval_before_cp, eval_after_cp, played_san, best_san
    )
    if found:
        explanations["missed_mate"] = found

    found = _tag_abandoned_defender(board_before, user_move, board_after, reply)
    if found:
        explanations["abandoned_defender"] = found

    found = _tag_missed_tactic(board_before, best_move, played_san, best_san)
    if found:
        explanations["missed_tactic"] = found

    found = _tag_missed_defense(
        board_before, board_after, user_move, reply, board_after_reply,
        opp_prev_san, played_san, reply_san,
    )
    if found:
        explanations["missed_defense"] = found

    found = _tag_missed_opponent_threat(
        board_before, board_after, reply, board_after_reply, board_before_opp, opp_prev_san
    )
    if found:
        explanations["missed_opponent_threat"] = found

    found = _tag_hope_chess(board_before, user_move, board_after)
    if found:
        explanations["hope_chess_hanging_piece"] = found

    found = _tag_left_piece_hanging(
        board_before, user_move, board_after, reply, played_san, reply_san
    )
    if found:
        explanations["left_piece_hanging"] = found

    found = _tag_backward_or_long_range(board_after, reply, board_after_reply)
    if found:
        explanations["backward_or_long_range_blindness"] = found

    found = _tag_king_safety(board_before, user_move, board_after, played_san)
    if found:
        explanations["king_safety"] = found

    found = _tag_time_scramble(clock_seconds, move_time_seconds)
    if found:
        explanations["time_scramble_panic"] = found

    if not explanations:
        return Classification(
            tags=[UNCLASSIFIED],
            primary=UNCLASSIFIED,
            explanations={
                UNCLASSIFIED: _fallback_explain(
                    board_before, user_move, board_after, best_move,
                    eval_before_cp, eval_after_cp, played_san, best_san,
                    reply, reply_san,
                )
            },
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
        best_move_uci=record.get("best_move_uci"),
        eval_before_cp=record.get("eval_before_cp"),
        eval_after_cp=record.get("eval_after_cp"),
    )
