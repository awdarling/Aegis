import { describe, it, expect } from 'vitest';

// ── L4 — the swap-kind marker + the fail-closed gate ─────────────────────────
//
// THE BUG: the Homebase manager UI approval path (/internal/notify-swap-decision
// → sendSwapDecisionNotification) reconstructs a decision from the
// `swap_requests` row. Three separate files carried a comment saying that path
// is "giveaway/pickup only — trades stay on the manager email button", and NONE
// of them implemented a check. It called the one-way executeScheduleSwap
// unconditionally, so a manager approving a TRADE from the Swaps tab moved one
// shift, silently dropped the return leg, wrote status='approved', and told the
// requester they were "off" when they'd agreed to work the coworker's shift.
//
// It could not have implemented a check, because the row didn't carry the
// answer: the directed path wrote the byte-identical note
//
//     'Both employees agreed via Aegis. Directed swap.'
//
// for a one-way giveaway AND a two-way trade — while `outreach.target_shift_name`,
// the one field that distinguishes them, sat in scope at the insert and was
// discarded.
//
// These tests pin both halves: the marker round-trips, and unknown is treated
// as UNSAFE rather than guessed.

import {
  swapKindMarker,
  withSwapKind,
  parseSwapKind,
  isOneWayKind,
  swapKindOf,
  tradeReturnShiftOf,
  planRowExecution,
} from '../swap-kind';

// The two real legacy notes, verified against the live Watermark DB 2026-08-16.
const LEGACY_DIRECTED = 'Both employees agreed via Aegis. Directed swap.';
const LEGACY_PICKUP = 'Riley Brooks offered to pick up the shift via the broadcast — one-way pickup (no trade).';

describe('L4 · the marker round-trips', () => {
  it('writes and reads back each kind', () => {
    for (const kind of ['giveaway', 'pickup', 'trade'] as const) {
      expect(parseSwapKind(withSwapKind('Some note.', kind))).toBe(kind);
    }
  });

  it('keeps the human-readable prose first', () => {
    const note = withSwapKind('Both employees agreed via Aegis. Directed swap.', 'trade');
    expect(note.startsWith('Both employees agreed via Aegis. Directed swap.')).toBe(true);
    expect(note).toContain(swapKindMarker('trade'));
  });

  it('is idempotent — re-stamping the same kind does not duplicate the tag', () => {
    const once = withSwapKind('n', 'trade');
    expect(withSwapKind(once, 'trade')).toBe(once);
  });

  it('reads the LAST marker if a note somehow carries two', () => {
    const weird = `${withSwapKind('n', 'giveaway')} ${swapKindMarker('trade')}`;
    expect(parseSwapKind(weird)).toBe('trade');
  });

  it('classifies which kinds move exactly one assignment', () => {
    expect(isOneWayKind('giveaway')).toBe(true);
    expect(isOneWayKind('pickup')).toBe(true);
    expect(isOneWayKind('trade')).toBe(false);
  });
});

describe('L4 · parseSwapKind returns null for anything it cannot read', () => {
  it('null / undefined / empty', () => {
    expect(parseSwapKind(null)).toBe(null);
    expect(parseSwapKind(undefined)).toBe(null);
    expect(parseSwapKind('')).toBe(null);
  });

  it('THE AMBIGUOUS LEGACY NOTE — identical for giveaway and trade', () => {
    expect(parseSwapKind(LEGACY_DIRECTED)).toBe(null);
  });

  it('a legacy note whose PROSE says pickup is still unknown', () => {
    // Deliberate: we do not pattern-match English. Prose is not a contract, and
    // a near-miss regex is how you get back to guessing.
    expect(parseSwapKind(LEGACY_PICKUP)).toBe(null);
  });

  it('a malformed or unknown marker value', () => {
    expect(parseSwapKind('n [quria:kind=]')).toBe(null);
    expect(parseSwapKind('n [quria:kind=sideways]')).toBe(null);
    expect(parseSwapKind('n [quria:kind=trade')).toBe(null);
  });
});

describe('L4b · swapKindOf reads the COLUMN first, notes as fallback', () => {
  it('the real column wins', () => {
    expect(swapKindOf({ kind: 'trade', notes: withSwapKind('n', 'giveaway') })).toBe('trade');
  });

  it('falls back to the notes marker for a row created before migration 023', () => {
    expect(swapKindOf({ kind: null, notes: withSwapKind('n', 'pickup') })).toBe('pickup');
  });

  it('a garbage column value falls back rather than being trusted', () => {
    expect(swapKindOf({ kind: 'sideways', notes: withSwapKind('n', 'giveaway') })).toBe('giveaway');
  });

  it('null when neither source says anything', () => {
    expect(swapKindOf({ kind: null, notes: LEGACY_DIRECTED })).toBe(null);
    expect(swapKindOf({})).toBe(null);
  });
});

describe('L4b · tradeReturnShiftOf', () => {
  it('reads the stored return shift', () => {
    const r = tradeReturnShiftOf({
      target_shift_date: '2026-07-19', target_shift_name: 'Morning', target_shift_role: 'Lifeguard',
    });
    expect(r).toEqual({ date: '2026-07-19', shift_name: 'Morning', role: 'Lifeguard' });
  });

  it('tolerates a missing role — only date + name are load-bearing', () => {
    expect(tradeReturnShiftOf({ target_shift_date: '2026-07-19', target_shift_name: 'Morning' }))
      .toEqual({ date: '2026-07-19', shift_name: 'Morning', role: null });
  });

  it('null when either half is missing (a partial row is not a trade we can run)', () => {
    expect(tradeReturnShiftOf({ target_shift_date: '2026-07-19' })).toBe(null);
    expect(tradeReturnShiftOf({ target_shift_name: 'Morning' })).toBe(null);
    expect(tradeReturnShiftOf({})).toBe(null);
  });
});

describe('L4b · planRowExecution — HOW to execute, not merely whether', () => {
  it('THE FIX: a trade WITH its return shift is now executable as a trade', () => {
    // This is what migration 023 buys. Before it, this row was refused; the
    // manager had to go find the approval email.
    const plan = planRowExecution({
      kind: 'trade',
      target_shift_date: '2026-07-19', target_shift_name: 'Morning', target_shift_role: 'Lifeguard',
    });
    expect(plan.mode).toBe('trade');
    if (plan.mode === 'trade') {
      expect(plan.returnShift.date).toBe('2026-07-19');
      expect(plan.returnShift.shift_name).toBe('Morning');
    }
  });

  it('a giveaway runs one-way', () => {
    const plan = planRowExecution({ kind: 'giveaway' });
    expect(plan.mode).toBe('one_way');
    if (plan.mode === 'one_way') expect(plan.kind).toBe('giveaway');
  });

  it('a pickup runs one-way', () => {
    expect(planRowExecution({ kind: 'pickup' }).mode).toBe('one_way');
  });

  it('a PRE-023 trade (kind known, return shift never stored) is still REFUSED', () => {
    // Its return shift only ever existed in the email token, so there is nothing
    // to execute against. Refusing is correct — half-applying is not.
    const plan = planRowExecution({ notes: withSwapKind('Two-way trade.', 'trade') });
    expect(plan.mode).toBe('refuse');
    if (plan.mode === 'refuse') {
      expect(plan.kind).toBe('trade');
      expect(plan.reason).toMatch(/two-way TRADE/i);
      expect(plan.reason).toMatch(/Approve button in the Aegis approval EMAIL/i);
      expect(plan.reason).toMatch(/Nothing has been changed/i);
    }
  });

  it('an UNMARKED legacy row is REFUSED — unknown is unsafe, not assumed one-way', () => {
    // The pre-L4 directed note was byte-identical for a giveaway and a trade, so
    // executing it is a coin flip on whether the schedule ends up half-changed.
    const plan = planRowExecution({ notes: LEGACY_DIRECTED });
    expect(plan.mode).toBe('refuse');
    if (plan.mode === 'refuse') {
      expect(plan.kind).toBe(null);
      expect(plan.reason).toMatch(/predates|cannot tell/i);
      expect(plan.reason).toMatch(/Approve button in the Aegis approval EMAIL/i);
    }
  });

  it('an empty row is REFUSED', () => {
    expect(planRowExecution({}).mode).toBe('refuse');
  });

  it('a trade whose return shift is only HALF stored is REFUSED, not guessed', () => {
    const plan = planRowExecution({ kind: 'trade', target_shift_date: '2026-07-19' });
    expect(plan.mode).toBe('refuse');
  });
});
