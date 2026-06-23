import { describe, it, expect, vi } from 'vitest';

// runScheduleBuild is pure orchestration over the BuildData passed in, but the
// module pulls in env + the Supabase client at import. Mock those so we can
// drive the real engine with fixtures (same pattern as the other vitest specs).
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
import { shiftsOverlap } from '../eligibility';
import { runScheduleBuild, type BuildData } from '../../../workflows/schedule-build';
import type { Employee, Availability, Policy, ShiftType, ShiftRequirement } from '../../../db/types';

// Wednesday 2026-06-24 (June 1 2026 is a Monday → +23 days = Wednesday, dow 3).
const WED = '2026-06-24';
const DOW = 3;
const CO = 'company-flex';

function emp(id: string, roles: string[], sex: 'male' | 'female', isVet = false): Employee {
  const e: Employee = {
    id, company_id: CO, name: id, primary_role: roles[0], qualified_roles: roles,
    max_weekly_hours: 40, contact_phone: null, contact_email: null, active: true,
    created_at: '2026-01-01T00:00:00Z', individual_wage: null, is_veteran: isVet,
  };
  (e as unknown as Record<string, unknown>).sex = sex;
  return e;
}
function allDayAvail(empId: string): Availability {
  return { id: `av-${empId}`, employee_id: empId, company_id: CO, day_of_week: DOW, start_time: '00:00', end_time: '23:59' };
}
function windowAvail(empId: string, start: string, end: string): Availability {
  return { id: `av-${empId}`, employee_id: empId, company_id: CO, day_of_week: DOW, start_time: start, end_time: end };
}
function st(id: string, name: string, start: string, end: string, days: number[]): ShiftType {
  return { id, company_id: CO, name, start_time: start, end_time: end, days_active: days, active: true, created_at: '2026-01-01T00:00:00Z' };
}
function req(id: string, stId: string, name: string, role: string, count: number, days: number[]): ShiftRequirement {
  return { id, company_id: CO, shift_name: name, role, required_count: count, start_time: '00:00', end_time: '00:00', days_active: days, shift_type_id: stId };
}

const genderPolicy: Policy = {
  id: 'pol-gender', company_id: CO, policy_key: 'gender_requirement',
  policy_value: '1m+1f concurrent',
  policy_value_json: { scope: 'concurrent_coverage', attribute: 'sex', minimums: { male: 1, female: 1 }, on_infeasible: 'flag', population_roles: ['Headguard', 'Lifeguard'] },
  policy_type: 'coverage', description: null, version: 1, created_at: '2026-01-01T00:00:00Z',
};

// ── Shift types mirroring Watermark's overlapping shifts ──────────────────────
const amWeekday = st('st-am', 'AM Weekday', '11:00:00', '15:30:00', [1, 2, 3, 4, 5]);
const flex = st('st-flex', 'Flex', '13:00:00', '21:00:00', [0, 1, 2, 3, 4, 5, 6]); // overlaps AM 13:00–15:30
const afternoon = st('st-pm', 'Afternoon', '15:00:00', '21:15:00', [0, 1, 2, 3, 4, 5, 6]);

describe('FLEX double-booking invariant — no one works two overlapping shifts', () => {
  // Michael is the only Headguard AND a qualified Lifeguard. Every Lifeguard is
  // on AM (11:00–15:30), which overlaps Flex (13:00–21:00). So Flex MUST gap —
  // nobody can legally take it. If the engine double-books, Michael (or a LG)
  // lands on both AM and Flex.
  const employees = [
    emp('Michael', ['Headguard', 'Lifeguard'], 'male', true),
    emp('LG_male_1', ['Lifeguard'], 'male'),
    emp('LG_male_2', ['Lifeguard'], 'male'),
  ];
  const data: BuildData = {
    employees,
    availByEmp: new Map(employees.map(e => [e.id, [allDayAvail(e.id)]])),
    toMap: new Map(),
    shiftTypes: [amWeekday, flex],
    shiftRequirements: [
      req('r-am-hg', 'st-am', 'AM Weekday', 'Headguard', 1, [1, 2, 3, 4, 5]),
      req('r-am-lg', 'st-am', 'AM Weekday', 'Lifeguard', 2, [1, 2, 3, 4, 5]),
      req('r-flex', 'st-flex', 'Flex', 'Lifeguard', 1, [0, 1, 2, 3, 4, 5, 6]),
    ],
    conflicts: [], policies: [genderPolicy], events: [],
    companyName: 'Flex Test', companyTimezone: 'America/New_York',
  };

  const result = runScheduleBuild(data, DEFAULT_ENGINE_SETTINGS, null, [], WED, WED);

  it('never assigns one person to two overlapping shifts on the same day', () => {
    const byEmpDay = new Map<string, typeof result.assignments>();
    for (const a of result.assignments) {
      const k = `${a.employee_id}|${a.date}`;
      if (!byEmpDay.has(k)) byEmpDay.set(k, []);
      byEmpDay.get(k)!.push(a);
    }
    const doubles: string[] = [];
    for (const [k, list] of byEmpDay) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (shiftsOverlap(list[i].start_time, list[i].end_time, list[j].start_time, list[j].end_time)) {
            doubles.push(`${k}: ${list[i].shift_name} ${list[i].start_time}-${list[i].end_time} ↔ ${list[j].shift_name} ${list[j].start_time}-${list[j].end_time}`);
          }
        }
      }
    }
    expect(doubles).toEqual([]);
  });

  it('leaves Flex as a gap rather than double-booking an AM guard onto it', () => {
    const michaelOnFlex = result.assignments.some(a => a.employee_id === 'Michael' && a.shift_name === 'Flex');
    expect(michaelOnFlex).toBe(false);
  });
});

describe('FLEX gender coverage — a guard on Flex must count toward the concurrent rule', () => {
  // AM is all-male. The only female is a Lifeguard who can only land on Flex
  // (13:00–21:00), because the males occupy AM (11:00–15:30) which overlaps Flex.
  const employees = [
    emp('HG_male', ['Headguard'], 'male'),
    emp('LG_male', ['Lifeguard'], 'male'),
    emp('LG_female', ['Lifeguard'], 'female'),
  ];
  // Force the reported scenario: the female can ONLY work Flex hours (13:00–
  // 21:00), so AM (11:00–15:30) is all-male and the only female on the day is
  // the Flex guard. A correct engine counts her toward the gender rule from
  // 13:00 on; the bug would keep flagging "no female" during her Flex hours.
  const data: BuildData = {
    employees,
    availByEmp: new Map([
      ['HG_male', [allDayAvail('HG_male')]],
      ['LG_male', [allDayAvail('LG_male')]],
      ['LG_female', [windowAvail('LG_female', '13:00', '21:00')]],
    ]),
    toMap: new Map(),
    shiftTypes: [amWeekday, flex],
    shiftRequirements: [
      req('r-am-hg', 'st-am', 'AM Weekday', 'Headguard', 1, [1, 2, 3, 4, 5]),
      req('r-am-lg', 'st-am', 'AM Weekday', 'Lifeguard', 1, [1, 2, 3, 4, 5]),
      req('r-flex', 'st-flex', 'Flex', 'Lifeguard', 1, [0, 1, 2, 3, 4, 5, 6]),
    ],
    conflicts: [], policies: [genderPolicy], events: [],
    companyName: 'Flex Test', companyTimezone: 'America/New_York',
  };

  const result = runScheduleBuild(data, DEFAULT_ENGINE_SETTINGS, null, [], WED, WED);
  const sexFlags = result.flagged_issues.filter(f => f.type === 'unsatisfied_sex_coverage');

  it('places the female on Flex', () => {
    const femaleOnFlex = result.assignments.some(a => a.employee_id === 'LG_female' && a.shift_name === 'Flex');
    expect(femaleOnFlex).toBe(true);
  });

  it('does NOT flag a female-coverage gap during the hours the Flex female is on duty (13:00–21:00)', () => {
    const flagsDuringFlex = sexFlags.filter(f => {
      const w = (f.metadata as { time_window?: { start: string; end: string } }).time_window;
      // any flagged window that overlaps 13:00–21:00 means the Flex female wasn't counted
      return w ? shiftsOverlap(w.start, w.end, '13:00:00', '21:00:00') && f.metadata.missing_sex === 'female' : false;
    });
    expect(flagsDuringFlex).toEqual([]);
  });
});

// The REAL Watermark pattern (from saved schedules): a scarce role-holder —
// usually the only Manager — placed on AM (11:00–15:30) AND Afternoon
// (15:00–21:15), which overlap 15:00–15:30. This reproduces that exact shape
// against the current engine to determine whether it's a live bug or stale data.
describe('FLEX/overlap — scarce Manager must not be double-booked AM + Afternoon', () => {
  const employees = [emp('Mgr_only', ['Manager'], 'male')];
  const data: BuildData = {
    employees,
    availByEmp: new Map([['Mgr_only', [allDayAvail('Mgr_only')]]]),
    toMap: new Map(),
    shiftTypes: [amWeekday, afternoon],
    shiftRequirements: [
      req('r-am-mgr', 'st-am', 'AM Weekday', 'Manager', 1, [1, 2, 3, 4, 5]),
      req('r-pm-mgr', 'st-pm', 'Afternoon', 'Manager', 1, [0, 1, 2, 3, 4, 5, 6]),
    ],
    conflicts: [], policies: [], events: [],
    companyName: 'Flex Test', companyTimezone: 'America/New_York',
  };
  const result = runScheduleBuild(data, DEFAULT_ENGINE_SETTINGS, null, [], WED, WED);

  it('does not place the only Manager on both AM and Afternoon (overlap 15:00–15:30)', () => {
    const mgr = result.assignments.filter(a => a.employee_id === 'Mgr_only');
    const overlapDouble = mgr.length === 2 &&
      shiftsOverlap(mgr[0].start_time, mgr[0].end_time, mgr[1].start_time, mgr[1].end_time);
    expect(overlapDouble).toBe(false);
  });
});
