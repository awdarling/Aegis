import { describe, it, expect, vi, beforeEach } from 'vitest';

// sendSwapDecisionNotification (B7) is the Homebase-UI swap-approval executor.
// These pin its safe no-op guards: a missing row, an already-decided swap, and a
// swap no coworker has taken must never execute or notify. EMAIL_ONLY:false so
// the SMS branch would be reachable if a guard failed.
const h = vi.hoisted(() => ({
  swapRow: null as Record<string, unknown> | null,
  // L4b — the trade path needs real employee rows (for the notice recipients and
  // the names on each leg) and a published schedule to write to.
  employees: {} as Record<string, Record<string, unknown>>,
  schedule: null as Record<string, unknown> | null,
  updates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
}));

vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: true } }));
vi.mock('../../db/client', () => ({
  supabase: {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (col: string, val: unknown) => { filters[col] = val; return b; };
      b.is = () => b; b.lte = () => b; b.gte = () => b; b.order = () => b; b.limit = () => b;
      b.update = (patch: Record<string, unknown>) => { h.updates.push({ table, patch }); return b; };
      b.insert = () => b;
      const rowFor = () => {
        if (table === 'swap_requests') return h.swapRow;
        if (table === 'employees') return h.employees[String(filters['id'])] ?? null;
        if (table === 'schedules') return h.schedule;
        if (table === 'company_channels') return null;   // no SMS number → email path
        return null;
      };
      b.maybeSingle = async () => ({ data: rowFor(), error: null });
      b.single = async () => ({ data: rowFor(), error: null });
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
import { sendEmail } from '../../messaging/email';
import { executeScheduleSwap, executeScheduleTrade } from '../../workflows/shift-swap';

const mockSms = vi.mocked(sendSms);
const mockEmail = vi.mocked(sendEmail);
const mockExec = vi.mocked(executeScheduleSwap);
const mockTrade = vi.mocked(executeScheduleTrade);

beforeEach(() => {
  h.swapRow = null;
  h.employees = {};
  h.schedule = null;
  h.updates = [];
  mockSms.mockClear();
  mockEmail.mockClear();
  mockExec.mockClear();
  mockTrade.mockClear();
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
// ── L4b — the Homebase UI now EXECUTES trades properly ──────────────────────
//
// The restriction this suite used to pin ("giveaway/pickup only") existed
// because `swap_requests` could not describe a trade: its columns name ONE
// shift, and the return shift lived only in the decision token on the manager's
// approval EMAIL. So this function called the one-way executor unconditionally —
// approving a trade moved one shift, dropped the return leg, marked the request
// approved, and told the requester they were "off" when they had agreed to work
// the coworker's shift.
//
// Migration 023 adds `kind` + `target_shift_*`, so the row can now describe the
// whole thing and the UI runs the SAME two-leg executor the email button uses.
// What remains refused is only what is genuinely unexecutable.
describe('L4b · sendSwapDecisionNotification executes a real TRADE', () => {
  const tradeRow = (over: Record<string, unknown> = {}) => ({
    id: 's1', company_id: 'c1', status: 'pending_manager',
    requesting_employee_id: 'r', receiving_employee_id: 'v',
    shift_date: '2026-08-10', shift_name: 'AM', role: 'Lifeguard',
    kind: 'trade',
    target_shift_date: '2026-08-12',
    target_shift_name: 'PM',
    target_shift_role: 'Lifeguard',
    notes: 'Two-way trade agreed by both. [quria:kind=trade]',
    ...over,
  });

  it('THE FIX: runs the TWO-leg executor, not the one-way one', async () => {
    h.swapRow = tradeRow();
    h.employees = { r: { id: 'r', name: 'Requester', contact_email: 'r@x.com', contact_phone: null },
                    v: { id: 'v', name: 'Receiver',  contact_email: 'v@x.com', contact_phone: null } };
    h.schedule = { id: 'sched-1' };
    mockTrade.mockResolvedValue({ ok: true, schedule_id: 'sched-1' });

    const r = await sendSwapDecisionNotification('s1', 'approved');

    expect(mockTrade).toHaveBeenCalledTimes(1);
    expect(mockExec).not.toHaveBeenCalled();     // the one-way executor must not see a trade

    // Both legs, with the right person on each side.
    const [, , sideA, sideB] = mockTrade.mock.calls[0];
    expect(sideA).toMatchObject({ date: '2026-08-10', shift_name: 'AM', employee_id: 'r' });
    expect(sideB).toMatchObject({ date: '2026-08-12', shift_name: 'PM', employee_id: 'v' });
    expect(r.status).toBe('approved');
  });

  it('NOTIFIES BOTH PARTIES with trade wording, not "you are off"', async () => {
    // The old code hard-coded isTrade=false, so the requester was told
    // "Receiver will cover your AM shift — you're off" when they had in fact
    // agreed to work the Receiver's PM shift.
    h.swapRow = tradeRow();
    h.employees = { r: { id: 'r', name: 'Requester', contact_email: 'r@x.com', contact_phone: null },
                    v: { id: 'v', name: 'Receiver',  contact_email: 'v@x.com', contact_phone: null } };
    h.schedule = { id: 'sched-1' };
    mockTrade.mockResolvedValue({ ok: true, schedule_id: 'sched-1' });

    const r = await sendSwapDecisionNotification('s1', 'approved');
    expect(r.notified).toBe(2);

    const bodies = mockEmail.mock.calls.map(c => String((c[0] as { text: string }).text));
    expect(bodies).toHaveLength(2);
    // Each person is told the shift they are now WORKING.
    expect(bodies.some(b => /trade has been approved/i.test(b) && /PM/.test(b))).toBe(true);
    expect(bodies.some(b => /trade has been approved/i.test(b) && /AM/.test(b))).toBe(true);
    // And nobody is told they're off.
    expect(bodies.some(b => /you're off/i.test(b))).toBe(false);

    const subjects = mockEmail.mock.calls.map(c => String((c[0] as { subject: string }).subject));
    expect(subjects.every(s => /trade approved/i.test(s))).toBe(true);
  });

  it('D2 holds — a trade that no longer matches the schedule writes NOTHING', async () => {
    h.swapRow = tradeRow();
    h.employees = { r: { id: 'r', name: 'Requester', contact_email: 'r@x.com', contact_phone: null },
                    v: { id: 'v', name: 'Receiver',  contact_email: 'v@x.com', contact_phone: null } };
    h.schedule = { id: 'sched-1' };
    mockTrade.mockResolvedValue({ ok: false, code: 'partial_trade', reason: 'Only one side of that trade matches.' });

    const r = await sendSwapDecisionNotification('s1', 'approved');
    expect(r.status).toBe('noop');
    expect(r.reason).toMatch(/only one side/i);
    expect(mockEmail).not.toHaveBeenCalled();    // nobody is told it worked
  });

  it('a DENIED trade is described as a trade, not a "coverage request"', async () => {
    h.swapRow = tradeRow();
    h.employees = { r: { id: 'r', name: 'Requester', contact_email: 'r@x.com', contact_phone: null },
                    v: { id: 'v', name: 'Receiver',  contact_email: 'v@x.com', contact_phone: null } };

    const r = await sendSwapDecisionNotification('s1', 'denied');
    expect(r.status).toBe('denied');
    const bodies = mockEmail.mock.calls.map(c => String((c[0] as { text: string }).text));
    expect(bodies.every(b => /shift trade/i.test(b))).toBe(true);
    expect(bodies.every(b => /stay on your original shifts/i.test(b))).toBe(true);
    expect(bodies.some(b => /coverage request/i.test(b))).toBe(false);
  });

  it('a GIVEAWAY still runs the one-way executor (the fix must not over-reach)', async () => {
    h.swapRow = tradeRow({ kind: 'giveaway', target_shift_date: null, target_shift_name: null, target_shift_role: null, notes: 'Directed swap. [quria:kind=giveaway]' });
    h.employees = { r: { id: 'r', name: 'Requester', contact_email: 'r@x.com', contact_phone: null },
                    v: { id: 'v', name: 'Receiver',  contact_email: 'v@x.com', contact_phone: null } };
    h.schedule = { id: 'sched-1' };
    mockExec.mockResolvedValue({ ok: true, schedule_id: 'sched-1' });

    await sendSwapDecisionNotification('s1', 'approved');
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockTrade).not.toHaveBeenCalled();
    const bodies = mockEmail.mock.calls.map(c => String((c[0] as { text: string }).text));
    expect(bodies.some(b => /you're off/i.test(b))).toBe(true);   // giveaway wording preserved
  });
});

describe('L4b · what is still refused is genuinely unexecutable', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 's1', company_id: 'c1', status: 'pending_manager',
    requesting_employee_id: 'r', receiving_employee_id: 'v',
    shift_date: '2026-08-10', shift_name: 'AM', role: 'Lifeguard',
    kind: null, target_shift_date: null, target_shift_name: null, target_shift_role: null,
    notes: null, ...over,
  });

  it('a PRE-023 trade — return shift never stored — is refused and routed to the email', async () => {
    h.swapRow = row({ notes: 'Two-way trade. [quria:kind=trade]' });
    const r = await sendSwapDecisionNotification('s1', 'approved');
    expect(r.status).toBe('noop');
    expect(r.reason).toMatch(/two-way TRADE/i);
    expect(r.reason).toMatch(/Approve button in the Aegis approval EMAIL/i);
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockTrade).not.toHaveBeenCalled();
  });

  it('an UNMARKED legacy row is refused — the note cannot distinguish the two', async () => {
    h.swapRow = row({ notes: 'Both employees agreed via Aegis. Directed swap.' });
    const r = await sendSwapDecisionNotification('s1', 'approved');
    expect(r.status).toBe('noop');
    expect(r.reason).toMatch(/predates|cannot tell/i);
    expect(mockExec).not.toHaveBeenCalled();
  });
});
