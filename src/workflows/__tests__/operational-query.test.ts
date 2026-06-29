import { describe, it, expect, vi } from 'vitest';

// operational-query.ts pulls in the Anthropic client, env, and the DB client at
// module load (via its imports). Mock those so importing the pure summarization
// helpers is side-effect-free.
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({
  env: { ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k', SENDGRID_FROM_EMAIL: 'a@b.test', SENDGRID_FROM_NAME: 'Aegis', BASE_URL: 'http://localhost:3000', NODE_ENV: 'test' },
}));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn() }));
vi.mock('../../ai/claude', () => ({ generateReply: vi.fn(), withAnthropicRetry: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ computeWageEstimate: vi.fn() }));
vi.mock('../payroll', () => ({ handleWageRateSync: vi.fn() }));

import { collectAssignments, summarizeStaffingByDate, buildDataContext, formatMyShiftsReply, type MyShift } from '../operational-query';

// One Watermark-shaped schedule row. Erin works two shifts on Jun 17 (a double),
// so she must be counted ONCE in that day's headcount.
const scheduleRow = {
  week_start: '2026-06-14',
  week_end: '2026-06-20',
  status: 'published',
  data: {
    assignments: [
      { date: '2026-06-17', employee_id: 'e1', employee_name: 'Erin Berigan', shift_name: 'AM', role: 'Headguard', start_time: '11:00', end_time: '15:30', hours: 4.5 },
      { date: '2026-06-17', employee_id: 'e1', employee_name: 'Erin Berigan', shift_name: 'PM', role: 'Headguard', start_time: '15:30', end_time: '21:15', hours: 5.75 },
      { date: '2026-06-17', employee_id: 'e2', employee_name: 'Lucas Penn', shift_name: 'PM', role: 'Lifeguard', start_time: '15:00', end_time: '21:15', hours: 6.25 },
      { date: '2026-06-17', employee_id: 'e3', employee_name: 'Audrey Rook', shift_name: 'AM', role: 'Lifeguard', start_time: '09:00', end_time: '15:00', hours: 6 },
      { date: '2026-06-18', employee_id: 'e2', employee_name: 'Lucas Penn', shift_name: 'AM', role: 'Lifeguard', start_time: '09:00', end_time: '15:00', hours: 6 },
    ],
    gaps: [
      { date: '2026-06-18', shift_name: 'PM', role: 'Lifeguard', required_count: 2, filled_count: 1 },
    ],
  },
};

describe('collectAssignments', () => {
  it('pulls every assignment out of schedules.data.assignments', () => {
    const out = collectAssignments([scheduleRow]);
    expect(out).toHaveLength(5);
    expect(out[0].employee_name).toBe('Erin Berigan');
    expect(out[0].role).toBe('Headguard');
  });

  it('skips rows with no data or malformed assignments without throwing', () => {
    expect(collectAssignments([{}])).toEqual([]);
    expect(collectAssignments([{ data: { assignments: [{ date: '2026-06-17' }] } }])).toEqual([]); // no name
  });
});

describe('summarizeStaffingByDate', () => {
  const summary = summarizeStaffingByDate(collectAssignments([scheduleRow]));

  it('counts a person working a same-day double ONLY ONCE', () => {
    // Jun 17 has Erin (x2 shifts), Lucas, Audrey = 3 distinct people, not 4.
    expect(summary).toMatch(/Jun 17: 3 on duty/);
  });

  it('breaks the day down by role with names', () => {
    expect(summary).toContain('Headguard (1): Erin Berigan');
    expect(summary).toMatch(/Lifeguard \(2\): Audrey Rook, Lucas Penn/);
  });

  it('reports each date present', () => {
    expect(summary).toMatch(/Jun 18: 1 on duty/);
  });

  it('returns empty string when there are no assignments', () => {
    expect(summarizeStaffingByDate([])).toBe('');
  });
});

describe('buildDataContext', () => {
  it('renders schedules as a readable staffing summary, not a raw JSON dump', () => {
    const ctx = buildDataContext({ schedules: [scheduleRow] });
    expect(ctx).toContain('Who is on duty each day:');
    expect(ctx).toContain('3 on duty');
    expect(ctx).toContain('Unfilled coverage:');
    // It must NOT dump the raw assignments array key.
    expect(ctx).not.toContain('"assignments"');
  });

  it('never chops a record mid-structure (full rows, capped by count)', () => {
    // 200 employee rows: every shown row is complete JSON, and the overflow is
    // summarized — there is no mid-record character truncation.
    const employees = Array.from({ length: 200 }, (_, i) => ({ id: `id${i}`, name: `Emp ${i}`, primary_role: 'Lifeguard' }));
    const ctx = buildDataContext({ employees });
    expect(ctx).toContain('employees (200):');
    expect(ctx).toContain('…and 120 more');
    // The last shown row (index 79) is intact, parseable JSON.
    const lines = ctx.split('\n').filter(l => l.startsWith('{'));
    expect(() => JSON.parse(lines[lines.length - 1])).not.toThrow();
  });

  it('skips empty tables', () => {
    expect(buildDataContext({ employees: [], schedules: [] })).toBe('');
  });
});

// #12 — employee "what are my shifts?" reply formatting.
describe('formatMyShiftsReply', () => {
  const shifts: MyShift[] = [
    { date: '2026-07-04', role: 'Lifeguard', shift_name: 'PM', start_time: '13:00', end_time: '21:00', hours: 8 },
    { date: '2026-07-06', role: 'Lifeguard', shift_name: 'AM', start_time: '09:00', end_time: '13:00', hours: 4 },
  ];

  it('lists upcoming shifts with a total-hours summary', () => {
    const out = formatMyShiftsReply('Dana Reed', shifts, { kind: 'upcoming' });
    expect(out).toMatch(/2 shifts coming up/);
    expect(out).toMatch(/12h in total/);
    expect(out).toMatch(/Saturday, July 4/);
    expect(out).toMatch(/1:00 PM–9:00 PM/);
    expect(out).toMatch(/That's 12h in all/);
    expect(out).not.toMatch(/homebase/i);     // employee-facing: no Homebase CTA
  });

  it('singular phrasing for one shift', () => {
    const out = formatMyShiftsReply('Dana Reed', [shifts[0]], { kind: 'upcoming' });
    expect(out).toMatch(/1 shift coming up/);
  });

  it('empty upcoming → friendly "nothing scheduled" note', () => {
    const out = formatMyShiftsReply('Dana Reed', [], { kind: 'upcoming' });
    expect(out).toMatch(/don't have any upcoming shifts/i);
    expect(out).not.toMatch(/homebase/i);
  });

  it('date scope with no shift says they are off that day', () => {
    const out = formatMyShiftsReply('Dana Reed', [], { kind: 'date', date: '2026-07-05' });
    expect(out).toMatch(/not scheduled on Sunday, July 5/);
  });

  it('date scope lists just that day, no weekly total', () => {
    const out = formatMyShiftsReply('Dana Reed', [shifts[0]], { kind: 'date', date: '2026-07-04' });
    expect(out).toMatch(/what you're on for Saturday, July 4/);
    expect(out).not.toMatch(/in all/);
  });
});
