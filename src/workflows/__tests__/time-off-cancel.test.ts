import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── L3 suite — an employee cancels ALREADY-APPROVED time off by text ─────────
//
// THE ASK: an employee can withdraw time off their manager already approved,
// (1) proactively by naming a date, and (2) reactively when a shift swap is
// blocked because they have time off that day. A CONFIRMATION IS MANDATORY —
// this is the one employee-triggered action that destroys something a manager
// granted, and it frees a day the scheduler will immediately start filling.
//
// THREE LANDMINES these tests exist to pin, all found by reading the live system
// rather than the docs:
//
//  1. The live CHECK constraint allows only 'pending' | 'approved' | 'denied'
//     (verified read-only 2026-08-16). Writing 'cancelled' needs migration 022.
//     If that migration has not run, the UPDATE fails with 23514 — and the
//     employee must be TOLD, not thanked. Pinned below.
//  2. `handleQueryMyTimeOff` applies NO status filter and its statusLabel was a
//     two-test ternary whose else-branch read "Pending — awaiting your manager".
//     So the employee who had just cancelled would be told it was still pending.
//  3. A bare "CANCEL" is a carrier-mandated SMS OPT-OUT keyword handled in
//     webhooks/sms.ts before routing. The confirmation copy must therefore ask
//     for YES/NO and must never invite the word CANCEL.

vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local', SUPABASE_SERVICE_ROLE_KEY: 'test',
    BASE_URL: 'https://test.local', ANTHROPIC_API_KEY: 'test',
    SENDGRID_API_KEY: 'test', SENDGRID_FROM_EMAIL: 'a@test.local',
    EMAIL_ONLY: true,
  },
}));

// A driveable Supabase stub. Every builder method returns the chain; the chain
// is thenable so `await` yields { data, error }. Reads are served from
// `h.reads[table]`, writes are recorded in `h.writes`.
const h = vi.hoisted(() => ({
  reads: {} as Record<string, unknown[]>,
  writes: [] as Array<{ table: string; op: string; payload?: Record<string, unknown>; filters: Record<string, unknown> }>,
  updateError: null as { message: string } | null,
  replies: [] as string[],
  activity: [] as Array<Record<string, unknown>>,
  emails: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../db/client', () => ({
  supabase: {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'order', 'limit', 'in', 'not', 'is', 'like', 'gte', 'lte', 'gt', 'lt', 'neq']) {
        chain[m] = (a?: unknown, b?: unknown) => { if (typeof a === 'string') filters[`${m}:${a}`] = b; return chain; };
      }
      chain.eq = (col: string, val: unknown) => { filters[col] = val; return chain; };
      chain.insert = (payload: Record<string, unknown>) => {
        h.writes.push({ table, op: 'insert', payload, filters: { ...filters } });
        return chain;
      };
      chain.update = (payload: Record<string, unknown>) => {
        h.writes.push({ table, op: 'update', payload, filters });
        return chain;
      };
      chain.delete = () => { h.writes.push({ table, op: 'delete', filters }); return chain; };
      chain.maybeSingle = async () => ({ data: (h.reads[table] ?? [])[0] ?? null, error: null });
      chain.single = async () => ({ data: (h.reads[table] ?? [])[0] ?? null, error: null });
      chain.then = (res: (v: unknown) => unknown) => {
        const isUpdate = h.writes.some(w => w.table === table && w.op === 'update' && w.filters === filters);
        return Promise.resolve(res({
          data: h.reads[table] ?? [],
          error: isUpdate ? h.updateError : null,
        }));
      };
      return chain;
    },
  },
}));

vi.mock('../../messaging/reply', () => ({
  reply: vi.fn(async (_c: unknown, _m: unknown, text: string) => { h.replies.push(text); }),
  normalizeReSubject: (s: string) => s,
}));
vi.mock('../../messaging/email', () => ({
  sendEmail: vi.fn(async (o: Record<string, unknown>) => { h.emails.push(o); return true; }),
}));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn(async () => true) }));
vi.mock('../../logger/activity-log', () => ({
  logActivity: vi.fn(async (o: Record<string, unknown>) => { h.activity.push(o); }),
}));
vi.mock('../../ai/claude', () => ({
  classifyIntent: vi.fn(async () => ({ intent: 'general_question', confidence: 'low', extracted: {} })),
  generateReply: vi.fn(),
  weekdayAnchors: vi.fn(),
  AnthropicOverloadError: class AnthropicOverloadError extends Error {},
}));
vi.mock('../../lib/schedule-simulator', () => ({
  runSimulation: vi.fn(), getWeekBounds: vi.fn(), loadTimeOffPolicies: vi.fn(async () => []),
  computeWageEstimate: vi.fn(),
}));
vi.mock('../../lib/time-off-policies', () => ({ computeTimeOffViolations: vi.fn() }));
vi.mock('../../router/interrupt', () => ({ employeeInterruptIntent: vi.fn(async () => null) }));
vi.mock('../../router/intent-router', () => ({ routeIntent: vi.fn() }));

import {
  handleCancelTimeOff,
  handleTimeOffCancelConfirmation,
  askToCancelTimeOff,
  findApprovedTimeOffOn,
  getPendingTimeOffCancel,
} from '../time-off';
import type { InboundMessage, VerifiedContact } from '../../security/types';

const COMPANY = 'co-1';
const EMPLOYEE = 'emp-1';
const REQUEST_ID = 'to-1';

const contact: VerifiedContact = {
  role: 'employee', company_id: COMPANY, employee_id: EMPLOYEE, user_id: null,
  name: 'Sam Rivera', matched_identifier: '+16165551212', channel: 'sms',
};
function msg(body: string): InboundMessage {
  return { sender: '+16165551212', recipient: '+16166164898', body, channel: 'sms', raw_subject: null, thread_id: null };
}

const APPROVED_ROW = { id: REQUEST_ID, status: 'approved', start_date: '2026-08-01', end_date: '2026-08-01' };

function pendingCancel(overrides: Record<string, unknown> = {}) {
  return {
    _memory_id: 'mem-1',
    employee_id: EMPLOYEE,
    request_id: REQUEST_ID,
    start_date: '2026-08-01',
    end_date: '2026-08-01',
    display_range: 'Sat, Aug 1, 2026',
    channel: 'sms' as const,
    sender: '+16165551212',
    recipient: '+16166164898',
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  h.reads = {};
  h.writes = [];
  h.updateError = null;
  h.replies = [];
  h.activity = [];
  h.emails = [];
});

const lastReply = () => h.replies[h.replies.length - 1] ?? '';
const timeOffUpdates = () => h.writes.filter(w => w.table === 'time_off_requests' && w.op === 'update');

// ── Resolving which request is meant ─────────────────────────────────────────

describe('L3 · findApprovedTimeOffOn', () => {
  it('asks ONLY for approved rows covering the date', async () => {
    h.reads['time_off_requests'] = [APPROVED_ROW];
    const found = await findApprovedTimeOffOn(COMPANY, EMPLOYEE, '2026-08-01');
    expect(found?.id).toBe(REQUEST_ID);
  });

  it('returns null when there is nothing approved', async () => {
    h.reads['time_off_requests'] = [];
    expect(await findApprovedTimeOffOn(COMPANY, EMPLOYEE, '2026-08-01')).toBe(null);
  });
});

// ── The proactive path never cancels; it asks ────────────────────────────────

describe('L3 · handleCancelTimeOff asks before it acts', () => {
  it('THE ASK: names the date back and requires an explicit answer', async () => {
    h.reads['time_off_requests'] = [APPROVED_ROW];
    await handleCancelTimeOff(msg('cancel my time off Aug 1'), contact, { date: '2026-08-01' });

    expect(lastReply()).toMatch(/are you sure/i);
    // Stated back in FULL — a destructive confirmation must not rely on the
    // employee remembering which date they typed.
    expect(lastReply()).toMatch(/August 1/);
    // Nothing was cancelled — only a pending answer was parked.
    expect(timeOffUpdates()).toHaveLength(0);
    expect(h.writes.some(w => w.table === 'aegis_memory' && w.op === 'insert')).toBe(true);
  });

  it('LANDMINE: asks for YES/NO and never invites the word CANCEL', async () => {
    // A bare "CANCEL" is a carrier opt-out keyword handled in webhooks/sms.ts
    // BEFORE routing — inviting it would unsubscribe the employee from Aegis
    // entirely and leave their time off booked.
    h.reads['time_off_requests'] = [APPROVED_ROW];
    await handleCancelTimeOff(msg('cancel my time off Aug 1'), contact, { date: '2026-08-01' });

    expect(lastReply()).toMatch(/Reply YES/);
    expect(lastReply()).not.toMatch(/reply CANCEL|reply STOP|reply END|reply QUIT/i);
  });

  it('the parked pending row is keyed per-employee and expires in ONE hour', async () => {
    h.reads['time_off_requests'] = [APPROVED_ROW];
    await handleCancelTimeOff(msg('cancel my time off Aug 1'), contact, { date: '2026-08-01' });

    const ins = h.writes.find(w => w.table === 'aegis_memory' && w.op === 'insert')!;
    expect(ins.payload!.source).toBe(`to_cancel_pending:${EMPLOYEE}`);
    expect(ins.payload!.memory_type).toBe('observation');

    // Deliberately shorter than the 24h used by pending_to: a day-old "yes"
    // must not be able to cancel someone's approved vacation.
    const parked = JSON.parse(ins.payload!.content as string) as { expires_at: string };
    const ttlMs = new Date(parked.expires_at).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(50 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('with no approved time off on that date, says so and parks nothing', async () => {
    h.reads['time_off_requests'] = [];
    await handleCancelTimeOff(msg('cancel my time off Aug 1'), contact, { date: '2026-08-01' });

    expect(lastReply()).toMatch(/don't see any approved time off/i);
    expect(h.writes.some(w => w.table === 'aegis_memory' && w.op === 'insert')).toBe(false);
  });

  it('with NO date named, lists what they have instead of guessing', async () => {
    // Guessing "your next one" on a destructive action is exactly the wrong
    // instinct — a wrong guess cancels the wrong days.
    h.reads['time_off_requests'] = [
      { start_date: '2026-08-01', end_date: '2026-08-01' },
      { start_date: '2026-09-04', end_date: '2026-09-06' },
    ];
    await handleCancelTimeOff(msg('cancel my time off'), contact, { date: null });

    expect(lastReply()).toMatch(/which one/i);
    expect(lastReply()).toMatch(/August 1/);
    expect(lastReply()).toMatch(/September 4/);
    expect(h.writes.some(w => w.table === 'aegis_memory' && w.op === 'insert')).toBe(false);
    expect(timeOffUpdates()).toHaveLength(0);
  });
});

// ── The confirmation ─────────────────────────────────────────────────────────

describe('L3 · the confirmation gate', () => {
  it('YES cancels the request and confirms in plain language', async () => {
    h.reads['time_off_requests'] = [APPROVED_ROW];
    await handleTimeOffCancelConfirmation(msg('yes'), contact, pendingCancel());

    const upd = timeOffUpdates();
    expect(upd).toHaveLength(1);
    expect(upd[0].payload!.status).toBe('cancelled');
    // Optimistic guard — never clobber a decision made in the meantime.
    expect(upd[0].filters['status']).toBe('approved');
    expect(upd[0].filters['id']).toBe(REQUEST_ID);

    expect(lastReply()).toMatch(/cancelled/i);
    expect(lastReply()).toMatch(/back on the schedule/i);
  });

  it('DECLINED AT THE CONFIRM changes nothing at all', async () => {
    h.reads['time_off_requests'] = [APPROVED_ROW];
    await handleTimeOffCancelConfirmation(msg('no'), contact, pendingCancel());

    expect(timeOffUpdates()).toHaveLength(0);
    expect(lastReply()).toMatch(/still booked/i);
    // And the pending is cleared, so a later stray "yes" can't resurrect it.
    expect(h.writes.some(w => w.table === 'aegis_memory' && w.op === 'delete')).toBe(true);
  });

  it('an ambiguous reply re-asks rather than cancelling', async () => {
    h.reads['time_off_requests'] = [APPROVED_ROW];
    await handleTimeOffCancelConfirmation(msg('hmm what does that mean'), contact, pendingCancel());

    expect(timeOffUpdates()).toHaveLength(0);
    expect(lastReply()).toMatch(/YES or NO/);
  });

  it('logs the cancellation with the request id for the audit trail', async () => {
    h.reads['time_off_requests'] = [APPROVED_ROW];
    await handleTimeOffCancelConfirmation(msg('yes'), contact, pendingCancel());

    const logged = h.activity.find(a => a.action === 'time_off_cancelled_by_employee');
    expect(logged).toBeDefined();
    expect(logged!.entity_id).toBe(REQUEST_ID);
  });

  it('retires the manager magic-link tokens so a stale email button cannot resurrect it', async () => {
    h.reads['time_off_requests'] = [APPROVED_ROW];
    await handleTimeOffCancelConfirmation(msg('yes'), contact, pendingCancel());

    const tokenDelete = h.writes.find(
      w => w.table === 'aegis_memory' && w.op === 'delete' && w.filters['like:source'] === 'decision_token:%',
    );
    expect(tokenDelete).toBeDefined();
  });

  it('notifies the manager by EMAIL (managers have no phone in the data model)', async () => {
    h.reads['time_off_requests'] = [APPROVED_ROW];
    h.reads['users'] = [{ email: 'jack@example.com', name: 'Jack' }];
    await handleTimeOffCancelConfirmation(msg('yes'), contact, pendingCancel());

    expect(h.emails).toHaveLength(1);
    expect(h.emails[0].subject).toMatch(/cancelled their approved time off/i);
  });
});

// ── Failing safely ───────────────────────────────────────────────────────────

describe('L3 · it fails closed and says so', () => {
  it('LANDMINE: if migration 022 has not run, the employee is TOLD, not thanked', async () => {
    // Without the migration the UPDATE violates time_off_requests_status_check
    // (23514). Reporting success here would leave the employee believing they're
    // working that day while the schedule still has them off.
    h.reads['time_off_requests'] = [APPROVED_ROW];
    h.updateError = { message: 'new row for relation "time_off_requests" violates check constraint "time_off_requests_status_check"' };

    await handleTimeOffCancelConfirmation(msg('yes'), contact, pendingCancel());

    expect(lastReply()).toMatch(/still booked/i);
    expect(lastReply()).not.toMatch(/\bDone\b|cancelled and you're back/i);
    expect(lastReply()).toMatch(/let your manager know/i);
    expect(h.activity.some(a => a.action === 'time_off_cancelled_by_employee')).toBe(false);
  });

  it('refuses to act on a stale confirmation if the request is no longer approved', async () => {
    // The question may be an hour old; a manager could have changed it since.
    h.reads['time_off_requests'] = [{ ...APPROVED_ROW, status: 'denied' }];
    await handleTimeOffCancelConfirmation(msg('yes'), contact, pendingCancel());

    expect(timeOffUpdates()).toHaveLength(0);
    expect(lastReply()).toMatch(/no longer showing as approved/i);
  });

  it('refuses if the request has vanished entirely', async () => {
    h.reads['time_off_requests'] = [];
    await handleTimeOffCancelConfirmation(msg('yes'), contact, pendingCancel());
    expect(timeOffUpdates()).toHaveLength(0);
    expect(lastReply()).toMatch(/no longer showing as approved/i);
  });

  it('an EXPIRED pending row is dropped rather than honoured', async () => {
    h.reads['aegis_memory'] = [{
      id: 'mem-1',
      content: JSON.stringify(pendingCancel({ expires_at: new Date(Date.now() - 1000).toISOString() })),
    }];
    expect(await getPendingTimeOffCancel(COMPANY, EMPLOYEE)).toBe(null);
    expect(h.writes.some(w => w.table === 'aegis_memory' && w.op === 'delete')).toBe(true);
  });
});

// ── The reactive path shares the proactive wording ───────────────────────────

describe('L3 · askToCancelTimeOff is the single confirmation voice (Rule 0b)', () => {
  it('carries the reactive lead but keeps the same question and YES/NO ask', async () => {
    await askToCancelTimeOff({
      message: msg("I'll take Riley's Friday shift"),
      contact,
      request: { id: REQUEST_ID, start_date: '2026-08-01', end_date: '2026-08-01' },
      lead: "You can't take Riley's PM shift on that date because you have approved time off then — but you can cancel it if you want the shift.",
    });

    expect(lastReply()).toMatch(/because you have approved time off/i);
    expect(lastReply()).toMatch(/are you sure/i);
    expect(lastReply()).toMatch(/Reply YES/);
    expect(lastReply()).not.toMatch(/reply CANCEL/i);
    // Still only an offer.
    expect(timeOffUpdates()).toHaveLength(0);
  });
});

// ── MULTI-DAY: naming one date cancels the WHOLE approved range ──────────────
//
// Approved time off is a RANGE. An employee who texts "cancel my time off Aug 1"
// while holding an approved Aug 1–5 is cancelling all five days — there is no
// partial cancellation (see the scope decision in time-off.ts: shrinking an
// approved range would mean silently editing, or splitting, a decision the
// manager made).
//
// So the one thing that must never happen is a single-date mention wiping a
// multi-day approval without the employee SEEING the full span before they say
// yes. These pin that.

import { countDaysInclusive } from '../time-off';

const MULTI_DAY_ROW = { id: 'to-multi', status: 'approved', start_date: '2026-08-01', end_date: '2026-08-05' };

describe('L3 · a multi-day approval shows its FULL range before it is cancelled', () => {
  it('naming ONE date inside the range confirms the WHOLE range, not that date', async () => {
    h.reads['time_off_requests'] = [MULTI_DAY_ROW];
    // The employee only said "Aug 1".
    await handleCancelTimeOff(msg('cancel my time off Aug 1'), contact, { date: '2026-08-01' });

    // The confirmation must show the END of the range too, or they'd say yes to
    // five days having read one. (The renderer spells both ends out in full:
    // "Saturday, August 1 through Wednesday, August 5".)
    expect(lastReply()).toMatch(/August 1/);
    expect(lastReply()).toMatch(/through .*August 5/);
    expect(lastReply()).toMatch(/are you sure/i);
  });

  it('and says the span out loud — "all 5 days ... not just the one day"', async () => {
    h.reads['time_off_requests'] = [MULTI_DAY_ROW];
    await handleCancelTimeOff(msg('cancel my time off Aug 1'), contact, { date: '2026-08-01' });

    expect(lastReply()).toMatch(/all 5 days/i);
    expect(lastReply()).toMatch(/not just the one day/i);
  });

  it('the parked pending row targets the whole request, with the full range', async () => {
    h.reads['time_off_requests'] = [MULTI_DAY_ROW];
    await handleCancelTimeOff(msg('cancel my time off Aug 3'), contact, { date: '2026-08-03' });

    const ins = h.writes.find(w => w.table === 'aegis_memory' && w.op === 'insert')!;
    const parked = JSON.parse(ins.payload!.content as string) as {
      request_id: string; start_date: string; end_date: string; display_range: string;
    };
    expect(parked.request_id).toBe('to-multi');
    expect(parked.start_date).toBe('2026-08-01');   // NOT the Aug 3 they named
    expect(parked.end_date).toBe('2026-08-05');
    expect(parked.display_range).toMatch(/August 1/);
    expect(parked.display_range).toMatch(/through .*August 5/);
  });

  it('YES cancels the ONE request — no range rewriting, no row splitting', async () => {
    h.reads['time_off_requests'] = [MULTI_DAY_ROW];
    await handleTimeOffCancelConfirmation(
      msg('yes'), contact,
      pendingCancel({ request_id: 'to-multi', start_date: '2026-08-01', end_date: '2026-08-05', display_range: 'Aug 1–5, 2026' }),
    );

    const upd = timeOffUpdates();
    expect(upd).toHaveLength(1);
    expect(upd[0].payload!.status).toBe('cancelled');
    // Partial cancellation is explicitly NOT supported: the dates must be left
    // exactly as the manager approved them.
    expect(upd[0].payload).not.toHaveProperty('start_date');
    expect(upd[0].payload).not.toHaveProperty('end_date');
    // And exactly one row is touched — no second "remainder" request invented.
    expect(h.writes.filter(w => w.table === 'time_off_requests' && w.op === 'insert')).toHaveLength(0);
  });

  it('a SINGLE-day request is unchanged — no span clause, no noise', async () => {
    h.reads['time_off_requests'] = [APPROVED_ROW];
    await handleCancelTimeOff(msg('cancel my time off Aug 1'), contact, { date: '2026-08-01' });
    expect(lastReply()).not.toMatch(/all \d+ days/i);
    expect(lastReply()).toMatch(/are you sure/i);
  });
});

describe('L3 · countDaysInclusive', () => {
  it('counts both ends', () => {
    expect(countDaysInclusive('2026-08-01', '2026-08-01')).toBe(1);
    expect(countDaysInclusive('2026-08-01', '2026-08-05')).toBe(5);
  });

  it('is DST-proof across a spring-forward boundary', () => {
    // Anchored at noon UTC; a naive local-midnight diff undercounts here.
    expect(countDaysInclusive('2026-03-07', '2026-03-09')).toBe(3);
  });

  it('degrades to 1 on garbage rather than throwing mid-confirmation', () => {
    expect(countDaysInclusive('2026-08-05', '2026-08-01')).toBe(1);
    expect(countDaysInclusive('nonsense', '2026-08-01')).toBe(1);
  });
});
