import { describe, it, expect, vi } from 'vitest';

// runScheduleBuild is pure orchestration over the BuildData passed in, but the
// module pulls in env + the Supabase client at import. Mock those so we can
// drive the real engine with fixtures (same pattern as flex-configurability).
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

const CO = 'company-fairness';
// A full Sun–Sat week. 2026-06-21 is a Sunday.
const WEEK_START = '2026-06-21';
const WEEK_END = '2026-06-27';
const WED = '2026-06-24'; // dow 3, used by the single-day cases

function emp(id: string, isVet = false, sex: 'male' | 'female' = 'female'): Employee {
  const e: Employee = {
    id, company_id: CO, name: id, primary_role: 'Lifeguard', qualified_roles: ['Lifeguard'],
    max_weekly_hours: 40, contact_phone: null, contact_email: null, active: true,
    created_at: '2026-01-01T00:00:00Z', individual_wage: null, is_veteran: isVet,
  };
  (e as unknown as Record<string, unknown>).sex = sex;
  return e;
}
// One availability row per day-of-week so the employee is open all week.
function availAllWeek(empId: string): Availability[] {
  return [0, 1, 2, 3, 4, 5, 6].map(dow => ({
    id: `av-${empId}-${dow}`, employee_id: empId, company_id: CO,
    day_of_week: dow, start_time: '00:00', end_time: '23:59',
  }));
}
function stAfternoon(days: number[]): ShiftType {
  return { id: 'st-pm', company_id: CO, name: 'Afternoon', start_time: '15:00:00', end_time: '21:00:00', days_active: days, active: true, created_at: '2026-01-01T00:00:00Z' };
}
function reqLG(count: number, days: number[]): ShiftRequirement {
  return { id: 'r-pm-lg', company_id: CO, shift_name: 'Afternoon', role: 'Lifeguard', required_count: count, start_time: '00:00', end_time: '00:00', days_active: days, shift_type_id: 'st-pm' };
}
function baseData(employees: Employee[], days: number[], count = 1): BuildData {
  return {
    employees,
    availByEmp: new Map(employees.map(e => [e.id, availAllWeek(e.id)])),
    toMap: new Map(),
    shiftTypes: [stAfternoon(days)],
    shiftRequirements: [reqLG(count, days)],
    conflicts: [], policies: [], events: [],
    companyName: 'Fairness Test', companyTimezone: 'America/New_York',
  };
}
// Stable fingerprint of who works which day.
function fingerprint(assignments: Array<{ date: string; employee_id: string }>): string {
  return assignments.map(a => `${a.date}|${a.employee_id}`).sort().join('  ');
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

describe('FAIRNESS-1 · determinism preserved when no seed is supplied', () => {
  const employees = [emp('LG0'), emp('LG1'), emp('LG2'), emp('LG3'), emp('LG4'), emp('LG5'), emp('LG6')];
  it('two seedless builds of the same week are identical (legacy behavior intact)', () => {
    const a = runScheduleBuild(baseData(employees, ALL_DAYS), DEFAULT_ENGINE_SETTINGS, null, [], WEEK_START, WEEK_END);
    const b = runScheduleBuild(baseData(employees, ALL_DAYS), DEFAULT_ENGINE_SETTINGS, null, [], WEEK_START, WEEK_END);
    expect(fingerprint(a.assignments)).toBe(fingerprint(b.assignments));
  });
});

describe('FAIRNESS-1 · seeded rotation breaks identical rebuilds', () => {
  const employees = [emp('LG0'), emp('LG1'), emp('LG2'), emp('LG3'), emp('LG4'), emp('LG5'), emp('LG6')];

  it('the same seed reproduces the same schedule', () => {
    const a = runScheduleBuild(baseData(employees, ALL_DAYS), DEFAULT_ENGINE_SETTINGS, null, [], WEEK_START, WEEK_END, { tieBreakSeed: 'seed-x' });
    const b = runScheduleBuild(baseData(employees, ALL_DAYS), DEFAULT_ENGINE_SETTINGS, null, [], WEEK_START, WEEK_END, { tieBreakSeed: 'seed-x' });
    expect(fingerprint(a.assignments)).toBe(fingerprint(b.assignments));
  });

  it('different seeds produce more than one distinct schedule (rotation works)', () => {
    const prints = new Set<string>();
    for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6']) {
      const r = runScheduleBuild(baseData(employees, ALL_DAYS), DEFAULT_ENGINE_SETTINGS, null, [], WEEK_START, WEEK_END, { tieBreakSeed: seed });
      prints.add(fingerprint(r.assignments));
    }
    expect(prints.size).toBeGreaterThan(1);
  });

  it('rotation spreads the work — every interchangeable guard gets used across seeds', () => {
    const workers = new Set<string>();
    for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) {
      const r = runScheduleBuild(baseData(employees, ALL_DAYS), DEFAULT_ENGINE_SETTINGS, null, [], WEEK_START, WEEK_END, { tieBreakSeed: seed });
      for (const a of r.assignments) workers.add(a.employee_id);
    }
    // Seedless, only the alphabetically-first 7 would ever appear; with rotation
    // the whole interchangeable pool shows up across builds.
    expect(workers.size).toBe(employees.length);
  });
});

describe('FAIRNESS-1 · cross-week memory biases toward the under-worked', () => {
  const employees = [emp('LG0'), emp('LG1'), emp('LG2')];

  it('with no memory, a single slot goes to the alphabetically-first guard (tie)', () => {
    const r = runScheduleBuild(baseData(employees, [3], 1), DEFAULT_ENGINE_SETTINGS, null, [], WED, WED);
    expect(r.assignments).toHaveLength(1);
    expect(r.assignments[0].employee_id).toBe('LG0');
  });

  it('a guard who worked a lot in recent weeks is NOT chosen when a peer is idle', () => {
    const priorHoursMap = new Map<string, number>([['LG0', 100]]); // LG0 hoarded recently
    const r = runScheduleBuild(baseData(employees, [3], 1), DEFAULT_ENGINE_SETTINGS, null, [], WED, WED, { priorHoursMap });
    expect(r.assignments).toHaveLength(1);
    expect(r.assignments[0].employee_id).not.toBe('LG0');
  });
});

describe('FAIRNESS-1 · veteran requirement swap picks the least-worked veteran', () => {
  // Roster order puts V1 first — the OLD code took the first eligible veteran
  // (V1). The fix must instead take the least-worked eligible veteran (V2).
  const V1 = emp('V1_vet', true);
  const V2 = emp('V2_vet', true);
  const N1 = emp('N1_non', false); // alphabetically before the vets → wins the main fill
  const employees = [V1, V2, N1];

  const data: BuildData = {
    ...baseData(employees, [3], 1),
    // All-veterans rule on the Afternoon Lifeguard slot for this day/season.
    experienceRules: [{
      shift_type_id: 'st-pm', days_of_week: [3], role: 'Lifeguard',
      mode: 'all_veterans', min_count: null,
      season_start: '2026-06-01', season_end: '2026-07-31', active: true,
    }],
  } as unknown as BuildData;

  it('swaps in V2 (fewest recent hours), not V1 (first in roster)', () => {
    const priorHoursMap = new Map<string, number>([['V1_vet', 100]]); // V1 hoarded recently
    const r = runScheduleBuild(data, DEFAULT_ENGINE_SETTINGS, null, [], WED, WED, { priorHoursMap });
    const pm = r.assignments.find(a => a.shift_name === 'Afternoon');
    expect(pm).toBeTruthy();
    expect(pm!.employee_id).toBe('V2_vet');
  });
});
