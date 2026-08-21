// L4 / L4b — what KIND of swap is this, and (for a trade) what comes back?
//
// ── THE HISTORY, because it explains the shape of this file ──────────────────
//
// `swap_requests` originally described ONE shift: shift_date / shift_name / role,
// the shift the requester gives up. A two-way TRADE also has a RETURN shift, and
// that lived only in the decision-token payload attached to the manager's
// approval EMAIL.
//
// So the Homebase Swaps tab — which reconstructs its decision from the ROW — had
// nothing to branch on. It called the one-way executor unconditionally:
// approving a trade moved one shift, silently dropped the return leg, marked the
// request approved, and told the requester they were "off" when they had agreed
// to work the coworker's shift. Three separate files carried a comment saying
// that path was "giveaway/pickup only"; none implemented it, and none COULD,
// because the row didn't record which kind it was. The directed path wrote the
// byte-identical note 'Both employees agreed via Aegis. Directed swap.' for a
// giveaway AND a trade, while `outreach.target_shift_name` — the one field that
// told them apart — sat in scope at the insert and was discarded.
//
// L4 made it SAFE: persist the kind as a bounded marker on `notes` and fail
// closed, refusing anything the UI can't prove is one-way.
// L4b (migration 023) makes it WORK: real `kind` + `target_shift_*` columns, so
// the UI can execute a trade properly instead of merely refusing it.
//
// ── WHY THE NOTES MARKER IS STILL HERE ──────────────────────────────────────
//
// It is the FALLBACK, not the primary. Rows created between the L4 deploy and
// migration 023 carry a marker but no `kind` column value; reading the column
// first and falling back keeps them working. 023 backfills `kind` from the
// marker, so the fallback drains to nothing on its own. Both are still written
// (column + marker) so rolling 023 back doesn't strand rows created after it.

export type SwapKind =
  /** One-way: the receiving employee TAKES the requester's shift; the requester
   *  is off and gives nothing back. Exactly one assignment moves. */
  | 'giveaway'
  /** One-way, from the broadcast: a coworker volunteered for an open shift.
   *  Structurally identical to a giveaway at execution time. */
  | 'pickup'
  /** Two-way: both people give up a shift and take the other's. TWO assignments
   *  move, and `target_shift_*` says which one comes back. */
  | 'trade';

const PREFIX = '[quria:kind=';
const SUFFIX = ']';

/** Kinds that move exactly ONE assignment (executeScheduleSwap). */
export function isOneWayKind(kind: SwapKind): boolean {
  return kind === 'giveaway' || kind === 'pickup';
}

/** The tag appended to `swap_requests.notes`. Kept last so the human-readable
 *  prose still reads naturally when a manager sees the note. */
export function swapKindMarker(kind: SwapKind): string {
  return `${PREFIX}${kind}${SUFFIX}`;
}

/** Appends the marker to a human note, idempotently. */
export function withSwapKind(note: string, kind: SwapKind): string {
  if (parseSwapKind(note) === kind) return note;
  return `${note} ${swapKindMarker(kind)}`.trim();
}

/** Reads the kind back off a note. Returns null when absent or malformed. */
export function parseSwapKind(note: string | null | undefined): SwapKind | null {
  if (!note) return null;
  const start = note.lastIndexOf(PREFIX);
  if (start === -1) return null;
  const end = note.indexOf(SUFFIX, start + PREFIX.length);
  if (end === -1) return null;
  const raw = note.slice(start + PREFIX.length, end).trim();
  if (raw === 'giveaway' || raw === 'pickup' || raw === 'trade') return raw;
  return null;
}

/** The subset of a `swap_requests` row this module reads. */
export interface SwapRowKindFields {
  kind?: string | null;
  notes?: string | null;
  target_shift_date?: string | null;
  target_shift_name?: string | null;
  target_shift_role?: string | null;
}

/**
 * The kind of a row — COLUMN FIRST, then the legacy notes marker.
 *
 * RULE 0b — one question, one function. Everything that needs to know what kind
 * of swap a row represents calls this; nothing re-derives it from prose.
 */
export function swapKindOf(row: SwapRowKindFields): SwapKind | null {
  const col = row.kind;
  if (col === 'giveaway' || col === 'pickup' || col === 'trade') return col;
  return parseSwapKind(row.notes);
}

/** The return shift of a trade, or null when it isn't stored. */
export interface TradeReturnShift {
  date: string;
  shift_name: string;
  role: string | null;
}

export function tradeReturnShiftOf(row: SwapRowKindFields): TradeReturnShift | null {
  if (!row.target_shift_date || !row.target_shift_name) return null;
  return {
    date: row.target_shift_date,
    shift_name: row.target_shift_name,
    role: row.target_shift_role ?? null,
  };
}

/**
 * The manager-facing instruction appended to a refusal.
 *
 * A refusal is only acceptable if the manager is left knowing exactly how to
 * complete the approval — otherwise "fail closed" just reads as "broken". The
 * Aegis approval EMAIL for the same request carries a decision token holding
 * BOTH shifts, so that path can still apply a trade this row cannot describe.
 *
 * Homebase surfaces this verbatim on a `noop` (`src/lib/swaps/decide.ts` renders
 * `Couldn't approve that swap: <reason>`), so it must be plain manager English
 * with a concrete next step, not an error code.
 */
export const APPROVE_BY_EMAIL_INSTRUCTION =
  'To approve it, use the Approve button in the Aegis approval EMAIL for this ' +
  'request — that link carries both shifts and will update the schedule correctly. ' +
  'Nothing has been changed here.';

/** What the Homebase-UI approval path should do with a row. */
export type RowExecutionPlan =
  | { mode: 'one_way'; kind: 'giveaway' | 'pickup' }
  | { mode: 'trade'; kind: 'trade'; returnShift: TradeReturnShift }
  | { mode: 'refuse'; kind: SwapKind | null; reason: string };

/**
 * Decide how (or whether) the Homebase UI may execute this row.
 *
 * FAIL CLOSED on anything unprovable. After migration 023 only two refusal cases
 * remain, and both are genuinely UNEXECUTABLE rather than merely unrecognised:
 *
 *  • an UNMARKED legacy row — the pre-L4 directed note was byte-identical for a
 *    giveaway and a trade, so executing it is a coin flip on whether the
 *    schedule ends up half-changed;
 *  • a TRADE created before 023 — its return shift was never stored anywhere but
 *    the email token, so there is nothing to execute against.
 *
 * Both drain by time: 023 backfills `kind`, and the email path still works for
 * anything already in flight. Verified read-only 2026-08-16: ZERO
 * pending_manager rows exist, so neither case affects anything today.
 */
export function planRowExecution(row: SwapRowKindFields): RowExecutionPlan {
  const kind = swapKindOf(row);

  if (kind === null) {
    return {
      mode: 'refuse',
      kind: null,
      reason:
        'This request predates swap-kind tracking, so we cannot tell whether it is a one-way ' +
        'giveaway or a two-way trade, and approving the wrong one would change only half the ' +
        'schedule. ' + APPROVE_BY_EMAIL_INSTRUCTION,
    };
  }

  if (kind === 'trade') {
    const returnShift = tradeReturnShiftOf(row);
    if (!returnShift) {
      return {
        mode: 'refuse',
        kind,
        reason:
          'This is a two-way TRADE from before the shift being given back was recorded on the ' +
          'request, so approving it here would move only one of the two shifts. ' +
          APPROVE_BY_EMAIL_INSTRUCTION,
      };
    }
    return { mode: 'trade', kind, returnShift };
  }

  return { mode: 'one_way', kind };
}
