// L4 — persisted, machine-readable classification of a `swap_requests` row.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// `swap_requests` has NO target-shift columns (SCHEMA_DRIFT_LOG 2026-07-31):
//   id, company_id, requesting_employee_id, receiving_employee_id, shift_date,
//   shift_name, role, status, initiated_by, notes, decided_by, decided_at,
//   created_at, updated_at, schedule_id
//
// A two-way TRADE's return shift therefore lives only in the decision-token
// payload. That is a known, accepted limitation. The UNACCEPTED consequence is
// that the row does not record even WHICH KIND of thing it is — and the
// directed path wrote the identical note for both:
//
//     notes: `Both employees agreed via Aegis. ${mode === 'facilitated'
//              ? 'Facilitated swap.' : 'Directed swap.'}`
//
// for a one-way giveaway AND for a two-way trade. `outreach.target_shift_name`
// — the one field that distinguishes them — was in scope at the insert and
// thrown away.
//
// The cost: the Homebase manager UI approval path (`/internal/notify-swap-decision`
// → `sendSwapDecisionNotification`) reconstructs the decision from the ROW. Three
// separate files carry a comment saying that path is "giveaway/pickup only —
// trades stay on the manager email button", and NONE of them implement a check.
// It called the one-way `executeScheduleSwap` unconditionally, so approving a
// trade from the UI moved one shift, silently dropped the return leg, and told
// the requester they were "off" when they had agreed to work the coworker's
// shift.
//
// This module makes the kind a durable property of the row, so that path can
// FAIL CLOSED on anything it cannot prove is one-way — Rule 0b: one question
// ("what kind of swap is this?"), one function.
//
// ── WHY A NOTES MARKER AND NOT A COLUMN ──────────────────────────────────────
//
// A real `kind` column (and `target_shift_*`) is the right end state and is
// recommended in the L4 delivery doc. It needs a human-gated migration, and the
// live half-applying trade needed fixing now. `notes` is existing free text; a
// bounded, greppable tag at the end of it changes no schema, is invisible to
// nobody (managers read the prose part), and is trivially replaced by a real
// column later — parseSwapKind is the only reader.

/**
 * The manager-facing instruction appended to every refusal.
 *
 * A refusal is only acceptable if the manager is left knowing exactly how to
 * complete the approval — otherwise "fail closed" just reads as "broken". The
 * Aegis approval EMAIL for this same request carries a decision token holding
 * BOTH shifts, so that path applies a trade correctly; this one cannot.
 *
 * Homebase surfaces this string verbatim on a `noop` result (see
 * `src/lib/swaps/decide.ts` — it renders `Couldn't approve that swap: <reason>`),
 * so it must be plain manager English with a concrete next step, not an error code.
 */
export const APPROVE_BY_EMAIL_INSTRUCTION =
  'To approve it, use the Approve button in the Aegis approval EMAIL for this ' +
  'request — that link carries both shifts and will update the schedule correctly. ' +
  'Nothing has been changed here.';

export type SwapKind =
  /** One-way: the receiving employee TAKES the requester's shift; the requester
   *  is off and gives nothing back. Exactly one assignment moves. */
  | 'giveaway'
  /** One-way, from the broadcast: a coworker volunteered for an open shift.
   *  Structurally identical to a giveaway at execution time. */
  | 'pickup'
  /** Two-way: both people give up a shift and take the other's. TWO assignments
   *  move. Cannot be executed from a `swap_requests` row alone, because the
   *  return shift is not stored on it. */
  | 'trade';

const PREFIX = '[quria:kind=';
const SUFFIX = ']';

/** Kinds that move exactly ONE assignment and can therefore be executed from a
 *  `swap_requests` row alone (via executeScheduleSwap). */
export function isOneWayKind(kind: SwapKind): boolean {
  return kind === 'giveaway' || kind === 'pickup';
}

/** The tag appended to `swap_requests.notes` at creation. Keep it last so the
 *  human-readable prose still reads naturally when a manager sees the note. */
export function swapKindMarker(kind: SwapKind): string {
  return `${PREFIX}${kind}${SUFFIX}`;
}

/** Appends the marker to a human note, idempotently. */
export function withSwapKind(note: string, kind: SwapKind): string {
  if (parseSwapKind(note) === kind) return note;
  return `${note} ${swapKindMarker(kind)}`.trim();
}

/**
 * Reads the kind back off a note.
 *
 * Returns null for any row created before this marker existed, or whose note
 * was rewritten by hand. **null means UNKNOWN, and unknown must be treated as
 * unsafe** by anything that would execute the row — precisely because the
 * legacy directed note is identical for giveaways and trades, so guessing is
 * exactly the mistake that caused the live bug.
 */
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

/**
 * The one question the Homebase UI approval path needs answered: may this row
 * be executed as a one-way reassignment from the row alone?
 *
 * FAIL CLOSED. Only a row that positively declares itself one-way qualifies.
 * An unmarked legacy row is refused — not because it is probably a trade, but
 * because nothing about it can rule that out, and the failure mode of guessing
 * wrong is a schedule that says someone is working a shift they are not.
 */
export function canExecuteFromRowAlone(note: string | null | undefined): {
  ok: boolean;
  kind: SwapKind | null;
  reason: string | null;
} {
  const kind = parseSwapKind(note);
  if (kind === null) {
    return {
      ok: false,
      kind: null,
      reason:
        'This request predates swap-kind tracking, so we cannot tell whether it is a one-way ' +
        'giveaway or a two-way trade, and approving the wrong one would change only half the ' +
        'schedule. ' + APPROVE_BY_EMAIL_INSTRUCTION,
    };
  }
  if (kind === 'trade') {
    return {
      ok: false,
      kind,
      reason:
        'This is a two-way TRADE (both people give up a shift), and this swap record does not ' +
        'store the shift being given back — approving it here would move only one of the two ' +
        'shifts. ' + APPROVE_BY_EMAIL_INSTRUCTION,
    };
  }
  return { ok: true, kind, reason: null };
}
