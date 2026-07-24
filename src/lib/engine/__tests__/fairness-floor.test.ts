import { describe, it, expect } from 'vitest';

// Same import-time mocks as fairness-cross-week (env + supabase + messaging).
import { vi } from 'vitest';
vi.mock('../../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local', SUPABASE_SERVICE_ROLE_KEY: 'test', BASE_URL: 'https://test.local',
    ANTHROPIC_API_KEY: 'test', SENDGRID_API_KEY: 'test', SENDGRID_FROM_EMAIL: 'a@test.local',
    TWILIO_ACCOUNT_SID: 'test', TWILIO_AUTH_TOKEN: 'test',
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
import { runScheduleBuild, type BuildData } from '../../../workflows/schedule-build';
import type { Employee, Availability, ShiftType, ShiftRequirement } from '../../../db/types';

const CO = 'company-floor';
const WEEK_START = '2026-06-21'; // Sunday
const WEEK_END = '2026-06-27';
const WED = '2026-06-24';
const MON_FRI = [1, 2, 3, 4, 5];
const FLOOR_ON = DEFAULT_ENGINE_SETTINGS;                                   // default: enabled
const FLOOR_OFF = { ...DEFAULT_ENGINE_SETTINGS, fairnessFloorEnabled: false };

function emp(id: string, opts: { vet?: boolean; max?: number } = {}): Employee {
  const e: Employee = {
    id, company_id: CO, name: id, primary_role: 'Lifeguard', qualified_roles: ['Lifeguard'],
    max_weekly_hours: opts.max ?? 60, contact_phone: null, contact_email: null, active: true,
    created_at: '2026-01-01T00:00:00Z', individual_wage: null, is_veteran: opts.vet ?? false,
  };
  (e as unknown as Record<string, unknown>).sex = 'female';
  return e;
}
function availDays(empId: string, days: number[]): Availability[] {
  return days.map(dow => ({
    id: `av-${empId}-${dow}`, employee_id: empId, company_id: CO,
    day_of_week: dow, start_time: '00:00', end_time: '23:59',
  }));
}
const stPm: ShiftType = { id: 'st-pm', company_id: CO, name: 'Afternoon', start_time: '15:00:00', end_time: '21:00:00', days_active: MON_FRI, active: true, created_at: '2026-01-01T00:00:00Z' };
const reqPm: ShiftRequirement = { id: 'r-pm', company_id: CO, shift_name: 'Afternoon', role: 'Lifeguard', required_count: 1, start_time: '00:00', end_time: '00:00', days_active: MON_FRI, shift_type_id: 'st-pm' };

function data(employees: Employee[], avail: Map<string, Availability[]>, extra: Partial<BuildData> = {}): BuildData {
  return {
    employees, availByEmp: avail, toMap: new Map(),
    shiftTypes: [stPm], shiftRequirements: [reqPm],
    conflicts: [], policies: [], events: [],
    companyName: 'Floor Test', companyTimezone: 'America/New_York',
    ...extra,
  } as BuildData;
}
function hoursByEmp(assignments: Array<{ employee_id: string; hours: number }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of assignments) m.set(a.employee_id, (m.get(a.employee_id) ?? 0) + a.hours);
  return m;
}
function hasSameDayDouble(assignments: Array<{ date: string; employee_id: string }>): boolean {
  const seen = new Set<string>();
  for (const a of assignments) {
    const k = `${a.date}|${a.employee_id}`;
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

describe('FAIRNESS-2 · within-week floor rescues a starved eligible employee', () => {
  // A hoarded hours recently (huge prior) so cross-week memory would hand EVERY
  // slot this week to B — leaving the fully-available, unexcused A at zero.
  const A = emp('A_guard');
  const B = emp('B_guard');
  const avail = new Map([[A.id, availDays(A.id, MON_FRI)], [B.id, availDays(B.id, MON_FRI)]]);
  const priorHoursMap = new Map<string, number>([['A_guard', 1000]]);

  it('WITHOUT the floor, A is starved to zero (the reported bug)', () => {
    const r = runScheduleBuild(data([A, B], avail), FLOOR_OFF, null, [], WEEK_START, WEEK_END, { priorHoursMap });
    const h = hoursByEmp(r.assignments);
    expect(h.get('A_guard') ?? 0).toBe(0);
    expect(h.get('B_guard') ?? 0).toBe(30);
  });

  it('WITH the floor (default), A is lifted to the role floor and B is trimmed', () => {
    const r = runScheduleBuild(data([A, B], avail), FLOOR_ON, null, [], WEEK_START, WEEK_END, { priorHoursMap });
    const h = hoursByEmp(r.assignments);
    const roleMeanHalf = 0.5 * (30 / 2); // ratio 0.5 × role mean (15) = 7.5
    expect(h.get('A_guard') ?? 0).toBeGreaterThanOrEqual(roleMeanHalf);
    expect(h.get('B_guard') ?? 0).toBeGreaterThan(h.get('A_guard') ?? 0); // memory still leads
    expect((h.get('A_guard') ?? 0) + (h.get('B_guard') ?? 0)).toBe(30);   // no hours invented
    expect(r.assignments).toHaveLength(5);                                 // no slots dropped
    expect(r.gaps).toHaveLength(0);                                        // no gaps introduced
    expect(hasSameDayDouble(r.assignments)).toBe(false);
  });
});

describe('FAIRNESS-2 · the floor never violates a hard constraint', () => {
  it('respects max_weekly_hours (a capped starved employee is not overfilled)', () => {
    const A = emp('A_guard', { max: 6 });   // can take exactly one 6h shift
    const B = emp('B_guard');
    const avail = new Map([[A.id, availDays(A.id, MON_FRI)], [B.id, availDays(B.id, MON_FRI)]]);
    const r = runScheduleBuild(data([A, B], avail), FLOOR_ON, null, [], WEEK_START, WEEK_END, { priorHoursMap: new Map([['A_guard', 1000]]) });
    const h = hoursByEmp(r.assignments);
    expect(h.get('A_guard') ?? 0).toBe(6);   // lifted off zero, but capped
    expect(h.get('A_guard') ?? 0).toBeLessThanOrEqual(A.max_weekly_hours);
  });

  it('respects availability (only gives the starved employee days they can work)', () => {
    const A = emp('A_guard');
    const B = emp('B_guard');
    const avail = new Map([[A.id, availDays(A.id, [3])], [B.id, availDays(B.id, MON_FRI)]]); // A only Wednesday
    const r = runScheduleBuild(data([A, B], avail), FLOOR_ON, null, [], WEEK_START, WEEK_END, { priorHoursMap: new Map([['A_guard', 1000]]) });
    const aDays = r.assignments.filter(a => a.employee_id === 'A_guard').map(a => a.date);
    expect(aDays.length).toBeGreaterThan(0);          // rescued
    expect(aDays.every(d => d === WED)).toBe(true);    // only on the day A is available
  });

  it('respects a veteran requirement (never hands a veteran-locked slot to a non-vet)', () => {
    const V = emp('V_vet', { vet: true });
    const A = emp('A_guard');                          // non-veteran, starved
    const avail = new Map([[V.id, availDays(V.id, MON_FRI)], [A.id, availDays(A.id, MON_FRI)]]);
    const withRule = data([V, A], avail, {
      experienceRules: [{
        shift_type_id: 'st-pm', days_of_week: MON_FRI, role: 'Lifeguard',
        mode: 'all_veterans', min_count: null,
        season_start: '2026-06-01', season_end: '2026-07-31', active: true,
      }],
    } as unknown as Partial<BuildData>);
    const r = runScheduleBuild(withRule, FLOOR_ON, null, [], WEEK_START, WEEK_END);
    const h = hoursByEmp(r.assignments);
    expect(h.get('A_guard') ?? 0).toBe(0);             // floor must NOT break the all-veterans rule
    expect(r.assignments.every(a => a.employee_id === 'V_vet')).toBe(true);
  });
});
