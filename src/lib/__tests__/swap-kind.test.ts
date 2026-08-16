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
  canExecuteFromRowAlone,
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

describe('L4 · canExecuteFromRowAlone FAILS CLOSED', () => {
  it('allows a marked giveaway', () => {
    const r = canExecuteFromRowAlone(withSwapKind(LEGACY_DIRECTED, 'giveaway'));
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('giveaway');
  });

  it('allows a marked pickup', () => {
    const r = canExecuteFromRowAlone(withSwapKind(LEGACY_PICKUP, 'pickup'));
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('pickup');
  });

  it('THE BUG: refuses a marked TRADE, and says why in manager language', () => {
    const r = canExecuteFromRowAlone(withSwapKind('Two-way trade agreed by both.', 'trade'));
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('trade');
    expect(r.reason).toMatch(/two-way trade/i);
    // A refusal is only acceptable if the manager is told exactly how to finish
    // the job — otherwise "fail closed" just reads as "broken".
    expect(r.reason).toMatch(/Approve button in the Aegis approval EMAIL/i);
    expect(r.reason).toMatch(/Nothing has been changed/i);
  });

  it('refuses an UNMARKED legacy row — unknown is unsafe, not assumed one-way', () => {
    // This is the deliberate, slightly conservative call. The legacy directed
    // note cannot distinguish a giveaway from a trade, so executing it is a coin
    // flip on whether the schedule ends up half-changed. Verified read-only
    // against the live DB on 2026-08-16: there are ZERO pending_manager rows, so
    // this refuses nothing that actually exists today.
    const r = canExecuteFromRowAlone(LEGACY_DIRECTED);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe(null);
    expect(r.reason).toMatch(/predates|cannot tell/i);
    expect(r.reason).toMatch(/Approve button in the Aegis approval EMAIL/i);
  });

  it('refuses a null note', () => {
    expect(canExecuteFromRowAlone(null).ok).toBe(false);
  });
});
