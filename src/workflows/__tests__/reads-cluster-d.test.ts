import { describe, it, expect, vi } from 'vitest';

// ── Batch-1.5 Cluster D reads: #16 who's-free, #3 shifts follow-up ───────────────
// operational-query.ts pulls in the Anthropic client/env/DB at module load; mock
// those so the pure helpers import side-effect-free.
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

import { summarizeAvailableByDate, isFreeStaffQuery, resolveShiftScope, collectAssignments } from '../operational-query';

// 2026-06-08 is a Monday. 2026-06-13 is the Saturday of that week.
const SAT = '2026-06-13';

describe('isFreeStaffQuery (#16)', () => {
  it('fires on who\'s-free phrasings', () => {
    expect(isFreeStaffQuery("who's free Saturday?")).toBe(true);
    expect(isFreeStaffQuery('who is available saturday')).toBe(true);
    expect(isFreeStaffQuery('anyone free this weekend?')).toBe(true);
    expect(isFreeStaffQuery('who can work Saturday')).toBe(true);
  });
  it('does NOT fire on who\'s-working (that path already works)', () => {
    expect(isFreeStaffQuery("who's working Saturday?")).toBe(false);
    expect(isFreeStaffQuery('how many guards on Saturday')).toBe(false);
  });
});

describe('summarizeAvailableByDate (#16)', () => {
  const employees = [
    { id: 'e1', name: 'Luka', primary_role: 'Lifeguard' },
    { id: 'e2', name: 'Riley', primary_role: 'Lifeguard' },
    { id: 'e3', name: 'Casey', primary_role: 'Headguard' },
  ];
  // Saturday = day_of_week 6. All three available Saturday.
  const availability = [
    { employee_id: 'e1', day_of_week: 6, start_time: '09:00', end_time: '21:00' },
    { employee_id: 'e2', day_of_week: 6, start_time: '09:00', end_time: '21:00' },
    { employee_id: 'e3', day_of_week: 6, start_time: '09:00', end_time: '21:00' },
  ];
  // Luka is already scheduled Saturday; Riley + Casey are free.
  const assignments = collectAssignments([
    { data: { assignments: [{ date: SAT, employee_id: 'e1', employee_name: 'Luka', shift_name: 'AM', role: 'Lifeguard', start_time: '09:00', end_time: '13:00' }] } },
  ]);

  it('lists available-but-not-scheduled people for the date', () => {
    const out = summarizeAvailableByDate(employees, availability, assignments, [SAT]);
    expect(out).toMatch(/Riley/);
    expect(out).toMatch(/Casey/);
    expect(out).not.toMatch(/Luka/); // already scheduled → not "free"
  });

  it('reports nobody-available cleanly when everyone available is scheduled', () => {
    const allAssigned = collectAssignments([
      { data: { assignments: [
        { date: SAT, employee_id: 'e1', employee_name: 'Luka', shift_name: 'AM', role: 'Lifeguard', start_time: '09:00', end_time: '13:00' },
        { date: SAT, employee_id: 'e2', employee_name: 'Riley', shift_name: 'AM', role: 'Lifeguard', start_time: '09:00', end_time: '13:00' },
        { date: SAT, employee_id: 'e3', employee_name: 'Casey', shift_name: 'AM', role: 'Headguard', start_time: '09:00', end_time: '13:00' },
      ] } },
    ]);
    const out = summarizeAvailableByDate(employees, availability, allAssigned, [SAT]);
    expect(out).toMatch(/nobody available/i);
  });
});

describe('resolveShiftScope (#3 — week phrase beats a stray extracted date)', () => {
  const today = '2026-06-08'; // Monday
  it('an explicit "next week" wins over a spurious single extracted date', () => {
    const scope = resolveShiftScope('what about next week?', '2026-06-15', today);
    expect(scope.kind).toBe('week');
    if (scope.kind === 'week') expect(scope.label).toBe('next week');
  });
  it('a specific date with NO week phrase still resolves to that day', () => {
    const scope = resolveShiftScope('what about June 15?', '2026-06-15', today);
    expect(scope.kind).toBe('date');
  });
  it('no date and no week phrase → upcoming', () => {
    expect(resolveShiftScope('what are my shifts?', null, today).kind).toBe('upcoming');
  });
});
