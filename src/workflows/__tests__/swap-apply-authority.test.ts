import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── D2 regression suite ───────────────────────────────────────────────────────
//
// THE BUG: a swap could be marked status='approved' — and BOTH employees emailed
// "your swap has been approved!" — while the schedule was never changed. The
// approve path set the status FIRST, then tried to apply the swap inside an
// `if (schedRow && receiver)` guard, and sent the notifications OUTSIDE that
// guard. No published schedule (or no matching assignment) meant: row says
// approved, everyone is told it's done, schedule untouched. The person who
// believed they were covered didn't show up.
//
// THE CONTRACT THESE TESTS PIN: executeScheduleSwap/Trade must REPORT whether
// the schedule actually changed. A caller may not announce an approval it did
// not get. `{ ok: true }` is only ever returned when a real assignment moved
// AND the write succeeded.

vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local',
    SUPABASE_SERVICE_ROLE_KEY: 'test',
    BASE_URL: 'https://test.local',
    ANTHROPIC_API_KEY: 'test',
    SENDGRID_API_KEY: 'test',
    SENDGRID_FROM_EMAIL: 'a@test.local',
    TWILIO_ACCOUNT_SID: 'test',
    TWILIO_AUTH_TOKEN: 'test',
    EMAIL_ONLY: true,
  },
}));

// A driveable Supabase stub. `scheduleRow` is what the SELECT resolves to;
// `writeError` is what the UPDATE reports. `updates` records what we wrote, so a
// test can assert that a FAILED apply wrote nothing at all.
const state: {
  scheduleRow: unknown;
  writeError: { message: string } | null;
  updates: Array<Record<string, unknown>>;
} = { scheduleRow: null, writeError: null, updates: [] };

vi.mock('../../db/client', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            single: async () => ({ data: state.scheduleRow, error: null }),
          }),
        }),
      }),
      update: (patch: Record<string, unknown>) => {
        state.updates.push(patch);
        return { eq: async () => ({ error: state.writeError }) };
      },
    }),
  },
}));

vi.mock('../../ai/claude', () => ({
  generateReply: vi.fn(),
  classifyIntent: vi.fn(),
  AnthropicOverloadError: class AnthropicOverloadError extends Error {},
}));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ computeWageEstimate: vi.fn(async () => 0) }));

import { executeScheduleSwap, executeScheduleTrade } from '../shift-swap';

const SCHEDULE_ID = 'sched-1';
const COMPANY = 'co-1';

function assignment(employee_id: string, date: string, shift_name = 'Afternoon') {
  return {
    employee_id,
    employee_name: employee_id,
    date,
    shift_name,
    role: 'Lifeguard',
    start_time: '15:00',
    end_time: '21:00',
    hours: 6,
  };
}

beforeEach(() => {
  state.scheduleRow = null;
  state.writeError = null;
  state.updates = [];
});

describe('executeScheduleSwap — the schedule write is authoritative', () => {
  it('returns ok WITH the schedule_id when a real assignment moves', async () => {
    state.scheduleRow = {
      id: SCHEDULE_ID,
      data: { assignments: [assignment('emp-requester', '2026-07-18')] },
      staffing_report: {},
    };

    const r = await executeScheduleSwap(
      COMPANY, SCHEDULE_ID, '2026-07-18', 'Afternoon',
      'emp-requester', 'emp-receiver', 'Receiver',
    );

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.schedule_id).toBe(SCHEDULE_ID);
    expect(state.updates).toHaveLength(1); // the schedule really was written
  });

  it('returns NOT ok when the schedule cannot be found — and writes NOTHING', async () => {
    state.scheduleRow = null; // no published schedule for that week

    const r = await executeScheduleSwap(
      COMPANY, SCHEDULE_ID, '2026-07-18', 'Afternoon',
      'emp-requester', 'emp-receiver', 'Receiver',
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('schedule_not_found');
    expect(state.updates).toHaveLength(0);
  });

  it('returns NOT ok when no assignment matches — the old code WROTE A NO-OP and reported success', async () => {
    // Somebody else's shift. applySwapToAssignments changes nothing.
    state.scheduleRow = {
      id: SCHEDULE_ID,
      data: { assignments: [assignment('someone-else', '2026-07-18')] },
      staffing_report: {},
    };

    const r = await executeScheduleSwap(
      COMPANY, SCHEDULE_ID, '2026-07-18', 'Afternoon',
      'emp-requester', 'emp-receiver', 'Receiver',
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_matching_assignment');
    // The regression: it used to fall through and write the unchanged
    // assignments back, then return void — indistinguishable from success.
    expect(state.updates).toHaveLength(0);
  });

  it('returns NOT ok when the DB rejects the write (previously swallowed)', async () => {
    state.scheduleRow = {
      id: SCHEDULE_ID,
      data: { assignments: [assignment('emp-requester', '2026-07-18')] },
      staffing_report: {},
    };
    state.writeError = { message: 'permission denied' };

    const r = await executeScheduleSwap(
      COMPANY, SCHEDULE_ID, '2026-07-18', 'Afternoon',
      'emp-requester', 'emp-receiver', 'Receiver',
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('write_failed');
  });
});

describe('executeScheduleTrade — same contract', () => {
  const sideA = { date: '2026-07-18', shift_name: 'Afternoon', employee_id: 'emp-a', employee_name: 'A' };
  const sideB = { date: '2026-07-19', shift_name: 'Morning', employee_id: 'emp-b', employee_name: 'B' };

  it('returns ok when both sides move', async () => {
    state.scheduleRow = {
      id: SCHEDULE_ID,
      data: {
        assignments: [
          assignment('emp-a', '2026-07-18', 'Afternoon'),
          assignment('emp-b', '2026-07-19', 'Morning'),
        ],
      },
      staffing_report: {},
    };

    const r = await executeScheduleTrade(COMPANY, SCHEDULE_ID, sideA, sideB);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.schedule_id).toBe(SCHEDULE_ID);
  });

  it('returns NOT ok when the shifts are not on the schedule — and writes nothing', async () => {
    state.scheduleRow = {
      id: SCHEDULE_ID,
      data: { assignments: [assignment('someone-else', '2026-07-18')] },
      staffing_report: {},
    };

    const r = await executeScheduleTrade(COMPANY, SCHEDULE_ID, sideA, sideB);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_matching_assignment');
    expect(state.updates).toHaveLength(0);
  });

  it('returns NOT ok when the schedule is missing', async () => {
    state.scheduleRow = null;
    const r = await executeScheduleTrade(COMPANY, SCHEDULE_ID, sideA, sideB);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('schedule_not_found');
    expect(state.updates).toHaveLength(0);
  });
});
