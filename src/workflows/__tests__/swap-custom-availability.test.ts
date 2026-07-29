import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Custom-availability in the swap candidate pool (fix #3) ───────────────────
//
// THE GAP: buildSwapCandidates loaded only the recurring `availability` table
// and ignored `custom_availability`. So the broadcast/pickup pool could offer a
// shift to someone on a date-limited or rotating availability block — someone the
// scheduling ENGINE would never place that week. The engine resolves effective
// availability via resolveAvailabilityForWeek (CUSTOM-AVAIL-ALIGN); the swap
// candidate builder must consult the SAME resolver so the two agree on who can
// work a shift.
//
// THESE TESTS PIN THE WIRING (the resolver's own logic is covered by
// custom-availability.test.ts): a candidate whose active custom block moves them
// OFF the shift day is dropped from the pool — but ONLY when a published schedule
// row (with week bounds) exists, since the resolution is anchored to the week.

vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local',
    SUPABASE_SERVICE_ROLE_KEY: 'test',
    BASE_URL: 'https://test.local',
    ANTHROPIC_API_KEY: 'test',
    SENDGRID_API_KEY: 'test',
    SENDGRID_FROM_EMAIL: 'a@test.local',
    EMAIL_ONLY: true,
  },
}));

// A driveable Supabase stub keyed by table. Every chain method returns the same
// thenable builder; awaiting the chain at any point resolves to that table's
// dataset. `schedulesRow` is swapped between the two assertions to toggle whether
// a published schedule (and therefore custom-availability resolution) is present.
const data: {
  employees: unknown[];
  availability: unknown[];
  custom_availability: unknown[];
  time_off_requests: unknown[];
  schedulesRow: unknown;
  employee_conflicts: unknown[];
} = {
  employees: [],
  availability: [],
  custom_availability: [],
  time_off_requests: [],
  schedulesRow: null,
  employee_conflicts: [],
};

function builder(result: unknown, single = false) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  for (const m of ['select', 'eq', 'is', 'lte', 'gte', 'or', 'order', 'limit']) b[m] = chain;
  b.maybeSingle = () => b;
  b.single = () => b;
  b.then = (resolve: (v: unknown) => unknown) =>
    resolve({ data: single ? result : result, error: null });
  return b;
}

vi.mock('../../db/client', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'schedules') return builder(data.schedulesRow, true);
      return builder((data as Record<string, unknown[]>)[table] ?? []);
    },
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

import { buildSwapCandidates } from '../shift-swap';

const COMPANY = 'co-1';
const SHIFT_DATE = '2026-07-06';
const DOW = new Date(SHIFT_DATE + 'T12:00:00Z').getUTCDay();
const OTHER_DOW = (DOW + 1) % 7;

function emp(id: string, name: string) {
  return {
    id,
    company_id: COMPANY,
    name,
    qualified_roles: ['Lifeguard'],
    max_weekly_hours: 40,
    active: true,
  };
}

function availRow(employee_id: string, day_of_week: number) {
  return { employee_id, company_id: COMPANY, day_of_week, start_time: '09:00:00', end_time: '21:00:00' };
}

const PUBLISHED_ROW = {
  data: { assignments: [], gaps: [], summary: '' },
  week_start: '2026-07-05',
  week_end: '2026-07-11',
};

const CALL = {
  company_id: COMPANY,
  requester_id: 'req',
  shift_date: SHIFT_DATE,
  role: 'Lifeguard',
  accepted_roles: ['Lifeguard'],
  shift_start: '15:00:00',
  shift_end: '21:00:00',
  shift_hours: 6,
};

beforeEach(() => {
  data.employees = [emp('req', 'Requester'), emp('bob', 'Bob'), emp('carol', 'Carol')];
  // Both Bob and Carol are recurringly available on the shift day.
  data.availability = [availRow('bob', DOW), availRow('carol', DOW)];
  data.time_off_requests = [];
  data.employee_conflicts = [];
  // Bob has an ACTIVE date-limited custom block that moves him to a DIFFERENT
  // day — so for this week he is NOT available on the shift day.
  data.custom_availability = [{
    employee_id: 'bob',
    company_id: COMPANY,
    type: 'date_limited',
    end_date: '2026-07-31',
    cycle_weeks: null,
    cycle_start_date: null,
    patterns: [{ day_of_week: OTHER_DOW, start_time: '09:00:00', end_time: '21:00:00' }],
    active: true,
    created_at: '2026-07-01T00:00:00Z',
  }];
  data.schedulesRow = PUBLISHED_ROW;
});

describe('buildSwapCandidates — custom availability', () => {
  it('drops a candidate whose active custom block moves them off the shift day', async () => {
    const out = await buildSwapCandidates(CALL);
    const ids = out.map(e => e.id);
    expect(ids).toContain('carol');   // recurring availability, no override → eligible
    expect(ids).not.toContain('bob'); // date-limited block → not available this week
  });

  it('keeps recurring availability when NO published schedule exists (nothing to anchor to)', async () => {
    data.schedulesRow = null;
    const out = await buildSwapCandidates(CALL);
    const ids = out.map(e => e.id);
    // With no week to resolve against, custom availability is not applied and
    // Bob falls back to his recurring (shift-day) availability.
    expect(ids).toContain('bob');
    expect(ids).toContain('carol');
  });

  it('never returns the requester', async () => {
    const out = await buildSwapCandidates(CALL);
    expect(out.map(e => e.id)).not.toContain('req');
  });
});
