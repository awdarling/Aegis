import { describe, it, expect, vi, beforeEach } from 'vitest';

// sendSwapDecisionNotification (B7) is the Homebase-UI swap-approval executor.
// These pin its safe no-op guards: a missing row, an already-decided swap, and a
// swap no coworker has taken must never execute or notify. EMAIL_ONLY:false so
// the SMS branch would be reachable if a guard failed.
const h = vi.hoisted(() => ({ swapRow: null as Record<string, unknown> | null }));

vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: false } }));
vi.mock('../../db/client', () => ({
  supabase: {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b; b.eq = () => b; b.is = () => b; b.lte = () => b;
      b.gte = () => b; b.order = () => b; b.limit = () => b; b.update = () => b;
      b.maybeSingle = async () => ({ data: table === 'swap_requests' ? h.swapRow : null, error: null });
      b.single = async () => ({ data: null, error: null });
      return b;
    },
  },
}));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn(async () => true) }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn(async () => true) }));
vi.mock('../../messaging/reply', () => ({ normalizeReSubject: (s: string) => s }));
vi.mock('../../messaging/brand', () => ({ BRAND: {}, logoUrl: () => '' }));
vi.mock('../../workflows/shift-swap', () => ({ executeScheduleSwap: vi.fn(), executeScheduleTrade: vi.fn() }));
vi.mock('../../workflows/emergency-coverage', () => ({ processCoverageButtonDecision: vi.fn(), processCoverageBatchButton: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ computeWageEstimate: vi.fn() }));

import { sendSwapDecisionNotification } from '../decision';
import { sendSms } from '../../messaging/sms';
import { executeScheduleSwap } from '../../workflows/shift-swap';

const mockSms = vi.mocked(sendSms);
const mockExec = vi.mocked(executeScheduleSwap);

beforeEach(() => {
  h.swapRow = null;
  mockSms.mockClear();
  mockExec.mockClear();
});

describe('sendSwapDecisionNotification — safe no-op guards (B7)', () => {
  it('no-ops when the swap request is not found', async () => {
    const r = await sendSwapDecisionNotification('missing', 'approved');
    expect(r.status).toBe('noop');
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockSms).not.toHaveBeenCalled();
  });

  it('no-ops when the swap is already decided (idempotent)', async () => {
    h.swapRow = {
      id: 's1', company_id: 'c1', status: 'approved',
      requesting_employee_id: 'r', receiving_employee_id: 'v',
      shift_date: '2026-08-10', shift_name: 'AM', role: 'Lifeguard',
    };
    const r = await sendSwapDecisionNotification('s1', 'approved');
    expect(r.status).toBe('noop');
    expect(r.reason).toMatch(/already/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('no-ops when no coworker has taken the shift yet', async () => {
    h.swapRow = {
      id: 's1', company_id: 'c1', status: 'pending_manager',
      requesting_employee_id: 'r', receiving_employee_id: null,
      shift_date: '2026-08-10', shift_name: 'AM', role: 'Lifeguard',
    };
    const r = await sendSwapDecisionNotification('s1', 'approved');
    expect(r.status).toBe('noop');
    expect(r.reason).toMatch(/no coworker/);
    expect(mockExec).not.toHaveBeenCalled();
  });
});

// ── L4 — the "giveaway-only" restriction is now CODE, not a comment ──────────
//
// This function is documented in THREE files (decision.ts, internal.ts, and
// Homebase src/lib/swaps/decide.ts) as giveaway/pickup only, because
// swap_requests has no target-shift columns and a trade's return shift cannot be
// reconstructed from the row. None of the three implemented it: the one-way
// executeScheduleSwap was called unconditionally.
//
// Trades DO reach here — both the broadcast trade and the directed trade create
// status='pending_manager' rows with a receiver, and the Homebase Swaps tab
// renders live Approve/Deny buttons for exactly those. So approving a trade in
// the UI moved one shift, silently dropped the return leg, marked the request
// approved, and told the requester they were "off" when they'd agreed to work
// the coworker's shift.
//
// Note what the suite above could not catch: it had no trade case at all,
// because there was no behaviour to assert.
describe('L4 · sendSwapDecisionNotification refuses anything it cannot prove is one-way', () => {
  const pending = (notes: string | null) => ({
    id: 's1', company_id: 'c1', status: 'pending_manager',
    requesting_employee_id: 'r', receiving_employee_id: 'v',
    shift_date: '2026-08-10', shift_name: 'AM', role: 'Lifeguard',
    notes,
  });

  it('THE BUG: refuses a marked TRADE instead of running it as a giveaway', async () => {
    h.swapRow = pending('Two-way trade agreed by both via the broadcast. [quria:kind=trade]');
    const r = await sendSwapDecisionNotification('s1', 'approved');
    expect(r.status).toBe('noop');
    expect(r.reason).toMatch(/two-way trade/i);
    expect(r.reason).toMatch(/manager email/i);
    // The whole point — the one-way executor must never see a trade.
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockSms).not.toHaveBeenCalled();
  });

  it('refuses an UNMARKED legacy row — the note cannot distinguish the two', async () => {
    // 'Both employees agreed via Aegis. Directed swap.' was written verbatim for
    // BOTH a one-way giveaway and a two-way trade. Verified read-only against
    // the live DB 2026-08-16: zero pending_manager rows exist, so refusing these
    // blocks nothing real.
    h.swapRow = pending('Both employees agreed via Aegis. Directed swap.');
    const r = await sendSwapDecisionNotification('s1', 'approved');
    expect(r.status).toBe('noop');
    expect(r.reason).toMatch(/predates|cannot tell/i);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('refuses a DENY on a trade too — the email button owns that decision', async () => {
    // Denying from here would mark the row denied and notify both people using
    // one-way wording, while the email token that actually carries both shifts
    // stays live. Fail closed on both verbs.
    h.swapRow = pending('Two-way trade. [quria:kind=trade]');
    const r = await sendSwapDecisionNotification('s1', 'denied');
    expect(r.status).toBe('noop');
    expect(mockSms).not.toHaveBeenCalled();
  });

  it('still LETS THROUGH a marked giveaway — the fix must not break the real path', async () => {
    h.swapRow = pending('Both employees agreed via Aegis. Directed swap. [quria:kind=giveaway]');
    const r = await sendSwapDecisionNotification('s1', 'approved');
    // It proceeds past the kind gate; the employee lookup is stubbed to null in
    // this harness, so it stops there rather than at the trade guard.
    expect(r.reason).not.toMatch(/two-way trade|predates|cannot tell/i);
  });

  it('still lets through a marked pickup', async () => {
    h.swapRow = pending('Offered to pick up via the broadcast. [quria:kind=pickup]');
    const r = await sendSwapDecisionNotification('s1', 'approved');
    expect(r.reason).not.toMatch(/two-way trade|predates|cannot tell/i);
  });
});
