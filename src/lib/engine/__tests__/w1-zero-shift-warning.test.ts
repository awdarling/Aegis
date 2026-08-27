import { describe, it, expect, vi } from 'vitest';

// ── W-1 branch 3 (J-1d): "0 shifts" warning from the engine's own gate ────────
//
// Mia Shaffer, week of 2026-08-17 (Jack's audit): approved partial time off
// 09:00–13:00 and 15:00–21:00 every day Aug 17–21, plus an availability
// override 09:00–12:00 every day through Aug 23. The AM shifts are 11:00–15:30
// (weekday) / 09:00–15:30 (weekend), so nothing fit. The builder was RIGHT to
// give her nothing; the defect was that nobody was told. The flag must come
// from buildEligibility — the same chain the fill loop used — never a second
// implementation ([GAPREASON-DUP]).

vi.mock('../../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local', SUPABASE_SERVICE_ROLE_KEY: 'test', BASE_URL: 'https://test.local',
    ANTHROPIC_API_KEY: 'test', SENDGRID_API_KEY: 'test', SENDGRID_FROM_EMAIL: 'a@test.local',
  },
}));
vi.mock('../../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../../ai/claude', () => ({
  generateReply: vi.fn(), classifyIntent: vi.fn(), withAnthropicRetry: vi.fn(),
  AnthropicOverloadError: class AnthropicOverloadError extends Error {},
}));
vi.mock('../../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn(), normalizeReSubject: (s: string) => s }));
vi.mock('../../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../schedule-simulator', () => ({ computeWageEstimate: vi.fn() }));

import { DEFAULT_ENGINE_SETTINGS } from '../../constraints/types';
import { runScheduleBuild, buildStaffingReport, summarizeAvailabilityWindows, summarizeTimeOffWindows, type BuildData, type FlaggedIssue } from '../../../workflows/schedule-build';
import { buildTOMap } from '../../to-window';
import type { Employee, Availability, ShiftType, ShiftRequirement } from '../../../db/types';

const CO = 'watermark';
const WEEK_START = '2026-08-16'; // Sunday
const WEEK_END = '2026-08-22';
const ALL = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];

function emp(id: string, name: string, opts: { active?: boolean; last_day?: string | null } = {}): Employee {
  const e: Employee = {
    id, company_id: CO, name, primary_role: 'Lifeguard', qualified_roles: ['Lifeguard'],
    max_weekly_hours: 40, contact_phone: null, contact_email: null, active: opts.active ?? true,
    created_at: '2026-01-01T00:00:00Z', individual_wage: null, is_veteran: false,
  };
  (e as unknown as Record<string, unknown>).sex = 'female';
  if (opts.last_day !== undefined) (e as unknown as Record<string, unknown>).last_day = opts.last_day;
  return e;
}
function avail(empId: string, days: number[], start: string, end: string): Availability[] {
  return days.map(dow => ({ id: `av-${empId}-${dow}`, employee_id: empId, company_id: CO, day_of_week: dow, start_time: start, end_time: end }));
}
const amWeekday: ShiftType = { id: 'st-amwd', company_id: CO, name: 'AM Weekday', start_time: '11:00:00', end_time: '15:30:00', days_active: WEEKDAYS, active: true, created_at: '2026-01-01T00:00:00Z' };
const amWeekend: ShiftType = { id: 'st-amwe', company_id: CO, name: 'AM Weekend', start_time: '09:00:00', end_time: '15:30:00', days_active: WEEKEND, active: true, created_at: '2026-01-01T00:00:00Z' };
const reqs: ShiftRequirement[] = [
  { id: 'r-amwd', company_id: CO, shift_name: 'AM Weekday', role: 'Lifeguard', required_count: 1, start_time: '00:00', end_time: '00:00', days_active: WEEKDAYS, shift_type_id: 'st-amwd' },
  { id: 'r-amwe', company_id: CO, shift_name: 'AM Weekend', role: 'Lifeguard', required_count: 1, start_time: '00:00', end_time: '00:00', days_active: WEEKEND, shift_type_id: 'st-amwe' },
];

const weekDates = ['2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22'];

function build(employees: Employee[], availByEmp: Map<string, Availability[]>, toMap = new Map()) {
  const data: BuildData = {
    employees, availByEmp, toMap, shiftTypes: [amWeekday, amWeekend], shiftRequirements: reqs,
    conflicts: [], policies: [], events: [], companyName: 'Watermark', companyTimezone: 'America/Detroit',
  } as BuildData;
  return { data, result: runScheduleBuild(data, DEFAULT_ENGINE_SETTINGS, null, [], WEEK_START, WEEK_END) };
}
const zeroFlags = (issues: FlaggedIssue[]) => issues.filter((f): f is Extract<FlaggedIssue, { type: 'zero_shifts' }> => f.type === 'zero_shifts');

describe('Mia Shaffer, week of Aug 17 — 0 shifts, and the build SAYS so with the engine\'s reason', () => {
  const mia = emp('mia', 'Mia Shaffer');
  const kori = emp('kori', 'Kori Baumann');
  const availByEmp = new Map<string, Availability[]>([
    ['mia', avail('mia', ALL, '09:00', '12:00')],           // the override Jack approved
    ['kori', avail('kori', ALL, '08:00', '21:00')],
  ]);
  // Two approved partial time-offs Aug 17–21: 09:00–13:00 and 15:00–21:00.
  const toMap = buildTOMap(weekDates, [
    { employee_id: 'mia', start_date: '2026-08-17', end_date: '2026-08-21', time_off_type: 'partial',
      partial_days: ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21'].map(date => ({ date, type: 'custom_hours' as const, start_time: '09:00', end_time: '13:00' })) },
    { employee_id: 'mia', start_date: '2026-08-17', end_date: '2026-08-21', time_off_type: 'partial',
      partial_days: ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21'].map(date => ({ date, type: 'custom_hours' as const, start_time: '15:00', end_time: '21:00' })) },
  ]);

  it('flags Mia with 0 shifts; Kori (who worked) is not flagged', () => {
    const { result } = build([mia, kori], availByEmp, toMap);
    expect(result.assignments.some(a => a.employee_id === 'mia')).toBe(false);
    const flags = zeroFlags(result.flagged_issues);
    expect(flags.map(f => f.metadata.employee_name)).toEqual(['Mia Shaffer']);
  });

  it('the reason is the engine\'s own: availability 09:00–12:00 covers no shift (all 7 slots)', () => {
    const { result } = build([mia, kori], availByEmp, toMap);
    const f = zeroFlags(result.flagged_issues)[0];
    // buildEligibility checks availability BEFORE time off, so every slot is
    // removed as "unavailable" — the same order the fill loop used.
    expect(f.metadata.reasons['unavailable on this day/time']).toBe(7);
    expect(f.metadata.eligible_slots).toBe(0);
    expect(f.metadata.availability).toBe('Sun–Sat 09:00–12:00');
    expect(f.metadata.time_off).toBe('Aug 17–21 09:00–13:00 and 15:00–21:00');
    expect(f.description).toBe('Mia Shaffer: 0 shifts — unavailable on this day/time (7 slots). availability Sun–Sat 09:00–12:00; time off Aug 17–21 09:00–13:00 and 15:00–21:00.');
    expect(f.date).toBe(WEEK_START);
  });

  it('with an availability that DOES cover the shifts, the time off is what blocks her — and the flag says so', () => {
    const wide = new Map<string, Availability[]>([
      ['mia', avail('mia', ALL, '08:00', '21:00')],
      ['kori', avail('kori', ALL, '08:00', '21:00')],
    ]);
    // Weekend Aug 16 + 22 are open (no TO) — she gets those, so a full TO week is used instead.
    const fullTo = buildTOMap(weekDates, [{ employee_id: 'mia', start_date: '2026-08-16', end_date: '2026-08-22', time_off_type: 'full_day', partial_days: null }]);
    const { result } = build([mia, kori], wide, fullTo);
    const f = zeroFlags(result.flagged_issues)[0];
    expect(f).toBeDefined();
    expect(f.metadata.reasons['approved time off']).toBe(7);
    expect(f.description).toMatch(/approved time off \(7 slots\)\. time off Aug 16–22 \(all day\)\./);
  });

  it('surfaces in the staffing report (aegis_notes + zero_shift_employees)', () => {
    const { data, result } = build([mia, kori], availByEmp, toMap);
    const report = buildStaffingReport(result.assignments, result.gaps, result.totalRequired, result.totalFilled, data.employees, [], result.closed_dates, result.flagged_issues) as Record<string, unknown>;
    expect(String(report.aegis_notes)).toMatch(/Mia Shaffer: 0 shifts/);
    const z = report.zero_shift_employees as Array<{ name: string }>;
    expect(z.map(x => x.name)).toEqual(['Mia Shaffer']);
  });
});

describe('who is NOT flagged', () => {
  it('an inactive employee, and one whose last day was before the week', () => {
    const gone = emp('gone', 'Letizia Cumbo-Nacheli', { last_day: '2026-08-10' });
    const inactive = emp('inactive', 'Cameron Osterhaven', { active: false });
    const kori = emp('kori', 'Kori Baumann');
    const { result } = build([gone, inactive, kori], new Map([['kori', avail('kori', ALL, '08:00', '21:00')]]));
    expect(zeroFlags(result.flagged_issues)).toEqual([]);
  });

  it('a fully-eligible employee who simply lost every ranking is flagged as "eligible but never chosen"', () => {
    // Two people, one slot per day, identical availability: one gets ~all AM slots
    // only if fairness is off; with the fairness floor on both get some. Force it
    // by giving B no qualification for the role instead → B is "not qualified".
    const a = emp('a', 'Ava');
    const b = emp('b', 'Ben');
    (b as unknown as Record<string, unknown>).qualified_roles = ['Greeter'];
    const { result } = build([a, b], new Map([['a', avail('a', ALL, '08:00', '21:00')], ['b', avail('b', ALL, '08:00', '21:00')]]));
    const f = zeroFlags(result.flagged_issues)[0];
    expect(f.metadata.employee_name).toBe('Ben');
    expect(f.description).toMatch(/not qualified for Lifeguard \(7 slots\)/);
  });
});

describe('summaries', () => {
  it('summarizeAvailabilityWindows groups consecutive days sharing a window', () => {
    expect(summarizeAvailabilityWindows([...avail('x', WEEKDAYS, '11:00', '15:30'), ...avail('x', WEEKEND, '09:00', '15:30')])).toBe('Sun 09:00–15:30; Mon–Fri 11:00–15:30; Sat 09:00–15:30');
    expect(summarizeAvailabilityWindows([])).toBe('none on file');
  });
  it('summarizeTimeOffWindows groups consecutive days sharing a window', () => {
    const m = buildTOMap(weekDates, [{ employee_id: 'x', start_date: '2026-08-18', end_date: '2026-08-19', time_off_type: 'full_day', partial_days: null }]);
    expect(summarizeTimeOffWindows('x', m, weekDates)).toBe('Aug 18–19 (all day)');
    expect(summarizeTimeOffWindows('nobody', m, weekDates)).toBe('none');
  });
});
