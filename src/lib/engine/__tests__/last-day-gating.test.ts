import { describe, it, expect, vi } from 'vitest';

// ── L1 regression suite — the build engine honors employees.last_day ──────────
//
// THE BUG (live at Watermark, reported 2026-08-16): a manager acknowledges that
// someone is leaving mid-week. `employees.last_day` has been live since
// migration 020 (2026-08-13), but Feature B deliberately left the BUILDER
// untouched and shipped only a non-blocking pre-publish advisory. So the
// builder happily rostered a departing employee across the whole week — the
// manager had to catch it by eye, every week, for every departure.
//
// THE BOUNDARY, which is the entire subtlety here: the employee WORKS their
// last day. So the gate is `date > last_day`, strictly — NOT `>=`, and NOT a
// blanket roster exclude. Someone leaving Wednesday must still be schedulable
// Sun/Mon/Tue/WED and unschedulable Thu/Fri/Sat, inside one build of one week.
// That is why this is a per-DATE filter in buildEligibility and not a filter on
// the roster query (which loads `active = true` for the whole week; a departing
// employee is still active every day of their final week).
//
// The same boundary is used by scheduler/employee-offboarding.ts, which flips
// active=false only once `last_day < today`. If either side ever moves to `>=`,
// employees lose their contracted final shift. These tests pin it.

// Import-time mocks — same shape as the other full-build engine suites
// (fairness-floor / fairness-cross-week). runScheduleBuild is pure, but the
// module graph reaches env + supabase + messaging at import time.
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
import { runScheduleBuild, type BuildData } from '../../../workflows/schedule-build';
import { buildEligibility, isPastLastDay } from '../eligibility';
import type { CanvasSlot } from '../types';
import type { Employee, Availability, ShiftType, ShiftRequirement } from '../../../db/types';

const CO = 'company-lastday';

// Sunday-start week. Wednesday is the interesting day: it is the mid-week
// last_day in most of these cases.
const WEEK_START = '2026-06-21'; // Sunday
const WEEK_END = '2026-06-27';   // Saturday
const SUN = '2026-06-21';
const MON = '2026-06-22';
const TUE = '2026-06-23';
const WED = '2026-06-24';
const THU = '2026-06-25';
const FRI = '2026-06-26';
const SAT = '2026-06-27';
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function emp(id: string, opts: { last_day?: string | null; max?: number } = {}): Employee {
  const e: Employee = {
    id, company_id: CO, name: id, primary_role: 'Lifeguard', qualified_roles: ['Lifeguard'],
    max_weekly_hours: opts.max ?? 60, contact_phone: null, contact_email: null, active: true,
    created_at: '2026-01-01T00:00:00Z', individual_wage: null, is_veteran: false,
  };
  (e as unknown as Record<string, unknown>).sex = 'female';
  if (opts.last_day !== undefined) e.last_day = opts.last_day;
  return e;
}

function availAllWeek(empId: string): Availability[] {
  return ALL_DAYS.map(dow => ({
    id: `av-${empId}-${dow}`, employee_id: empId, company_id: CO,
    day_of_week: dow, start_time: '00:00', end_time: '23:59',
  }));
}

// One 6-hour shift, one head required, every day of the week.
const shiftType: ShiftType = {
  id: 'st-day', company_id: CO, name: 'Day', start_time: '09:00:00', end_time: '15:00:00',
  days_active: ALL_DAYS, active: true, created_at: '2026-01-01T00:00:00Z',
};
const requirement: ShiftRequirement = {
  id: 'r-day', company_id: CO, shift_name: 'Day', role: 'Lifeguard', required_count: 1,
  start_time: '00:00', end_time: '00:00', days_active: ALL_DAYS, shift_type_id: 'st-day',
};

function data(employees: Employee[]): BuildData {
  const availByEmp = new Map<string, Availability[]>();
  for (const e of employees) availByEmp.set(e.id, availAllWeek(e.id));
  return {
    employees, availByEmp, toMap: new Map(),
    shiftTypes: [shiftType], shiftRequirements: [requirement],
    conflicts: [], policies: [], events: [],
    companyName: 'Last Day Test', companyTimezone: 'America/New_York',
  } as BuildData;
}

function build(employees: Employee[]) {
  return runScheduleBuild(data(employees), DEFAULT_ENGINE_SETTINGS, null, [], WEEK_START, WEEK_END);
}

function datesFor(
  result: { assignments: Array<{ employee_id: string; date: string }> },
  empId: string,
): string[] {
  return result.assignments.filter(a => a.employee_id === empId).map(a => a.date).sort();
}

function slotOn(date: string): CanvasSlot {
  return {
    date, shift_type_id: 'st-day', shift_name: 'Day', shift_requirement_id: 'r-day',
    role: 'Lifeguard', accepted_roles: ['Lifeguard'], start_time: '09:00', end_time: '15:00',
    hours: 6, required_count: 1, slot_index: 0, is_priority: false,
  };
}

// ── The pure predicate — the boundary itself ─────────────────────────────────

describe('L1 · isPastLastDay — the employee WORKS their last day', () => {
  const leaver = emp('leaver', { last_day: WED });

  it('is FALSE on the last day itself (the whole point — they work it)', () => {
    expect(isPastLastDay(leaver, WED)).toBe(false);
  });

  it('is FALSE for every day before the last day', () => {
    for (const d of [SUN, MON, TUE]) expect(isPastLastDay(leaver, d)).toBe(false);
  });

  it('is TRUE for every day after the last day', () => {
    for (const d of [THU, FRI, SAT]) expect(isPastLastDay(leaver, d)).toBe(true);
  });

  it('is FALSE for an employee with no last_day (null, undefined, or empty)', () => {
    expect(isPastLastDay(emp('stayer'), SAT)).toBe(false);
    expect(isPastLastDay(emp('stayer', { last_day: null }), SAT)).toBe(false);
    expect(isPastLastDay(emp('stayer', { last_day: '' }), SAT)).toBe(false);
  });

  it('tolerates a timestamp-shaped value rather than silently mis-comparing', () => {
    // Defensive: the column is `date`, but a future loader/cast could hand us
    // 'YYYY-MM-DDTHH:MM:SSZ'. Raw lexicographic compare of WED vs
    // '2026-06-24T00:00:00Z' would call WED "before" it and wrongly allow THU
    // through only after slicing. Pin the sliced behaviour.
    const ts = emp('ts', { last_day: '2026-06-24T00:00:00Z' });
    expect(isPastLastDay(ts, WED)).toBe(false);
    expect(isPastLastDay(ts, THU)).toBe(true);
  });
});

// ── The eligibility chokepoint ──────────────────────────────────────────────

describe('L1 · buildEligibility gates on last_day and says why', () => {
  const leaver = emp('leaver', { last_day: WED });
  const availByEmp = new Map([[leaver.id, availAllWeek(leaver.id)]]);

  it('keeps the leaver eligible through their last day', () => {
    for (const d of [SUN, MON, TUE, WED]) {
      const pool = buildEligibility(slotOn(d), [leaver], availByEmp, new Map(), []);
      expect(pool.employees.map(e => e.id)).toEqual(['leaver']);
    }
  });

  it('removes the leaver after their last day, with a manager-legible reason', () => {
    const pool = buildEligibility(slotOn(THU), [leaver], availByEmp, new Map(), []);
    expect(pool.employees).toHaveLength(0);
    expect(pool.removed_reasons.get('leaver')).toBe('past their last day');
  });
});

// ── End-to-end build — the behaviour Alexander actually asked for ────────────

describe('L1 · a full week build honors a mid-week last_day', () => {
  it('THE ASK: schedules the leaver through Wednesday and never after', () => {
    // Only person on the roster, so every day they are eligible for is theirs.
    const leaver = emp('leaver', { last_day: WED });
    const dates = datesFor(build([leaver]), 'leaver');

    expect(dates).toEqual([SUN, MON, TUE, WED]);
    expect(dates).toContain(WED);              // they WORK their last day
    expect(dates).not.toContain(THU);
    expect(dates).not.toContain(FRI);
    expect(dates).not.toContain(SAT);
  });

  it('the remaining days go to whoever is still on the roster — not dropped', () => {
    // Regression against an over-broad fix: gating the leaver must not cost the
    // schedule its Thu–Sat coverage when someone else can work it.
    const leaver = emp('leaver', { last_day: WED });
    const stayer = emp('stayer');
    const result = build([leaver, stayer]);

    const leaverDates = datesFor(result, 'leaver');
    const covered = new Set(result.assignments.map(a => a.date));

    expect(leaverDates.every(d => d <= WED)).toBe(true);
    for (const d of [SUN, MON, TUE, WED, THU, FRI, SAT]) expect(covered.has(d)).toBe(true);
    expect(result.assignments).toHaveLength(7); // one head × seven days
    expect(result.gaps).toHaveLength(0);
  });

  it('an employee with NO last_day is completely unaffected (the common case)', () => {
    const stayer = emp('stayer');
    const dates = datesFor(build([stayer]), 'stayer');
    expect(dates).toEqual([SUN, MON, TUE, WED, THU, FRI, SAT]);
  });

  it('a last_day AFTER the build week has no effect at all', () => {
    const leavingLater = emp('leaving_later', { last_day: '2026-07-15' });
    const dates = datesFor(build([leavingLater]), 'leaving_later');
    expect(dates).toEqual([SUN, MON, TUE, WED, THU, FRI, SAT]);
  });

  it('a last_day BEFORE the build week removes them from every day of it', () => {
    // The daily sweep would normally have flipped active=false already, but the
    // builder must not depend on that job having run.
    const gone = emp('gone', { last_day: '2026-06-10' });
    const stayer = emp('stayer');
    const result = build([gone, stayer]);

    expect(datesFor(result, 'gone')).toEqual([]);
    expect(datesFor(result, 'stayer')).toHaveLength(7);
  });

  it('last_day on the FIRST day of the week still gives them that day', () => {
    // Boundary case at the low end: Sunday leaver works Sunday, nothing else.
    const leaver = emp('leaver', { last_day: SUN });
    const stayer = emp('stayer');
    const result = build([leaver, stayer]);
    expect(datesFor(result, 'leaver')).toEqual([SUN]);
  });

  it('last_day on the LAST day of the week leaves the whole week intact', () => {
    // Boundary case at the high end: Saturday leaver works the full week. If
    // anyone ever "simplifies" the gate to `>=`, this test fails.
    const leaver = emp('leaver', { last_day: SAT });
    expect(datesFor(build([leaver]), 'leaver')).toEqual([SUN, MON, TUE, WED, THU, FRI, SAT]);
  });

  it('reports a real GAP after the last day rather than silently rostering them', () => {
    // Leaver is the only qualified person. Thu–Sat must surface as unfilled
    // work the manager can see, not as a quietly-kept assignment.
    const leaver = emp('leaver', { last_day: WED });
    const result = build([leaver]);

    const gapDates = new Set(result.gaps.map(g => g.date));
    for (const d of [THU, FRI, SAT]) expect(gapDates.has(d)).toBe(true);
    for (const d of [SUN, MON, TUE, WED]) expect(gapDates.has(d)).toBe(false);
  });

  it('the gap reason names the departure instead of blaming availability', () => {
    const leaver = emp('leaver', { last_day: WED });
    const result = build([leaver]);
    const thuGap = result.gaps.find(g => g.date === THU);

    expect(thuGap).toBeDefined();
    // Pre-fix this said "All qualified employees are unavailable on Thursday",
    // which sent managers hunting through availability for a problem that
    // wasn't there.
    expect(thuGap!.reason).toMatch(/left the team|last day/i);
    expect(thuGap!.reason).not.toMatch(/unavailable/i);
  });

  it('the per-employee disposition says they departed, not "unchosen by ranker"', () => {
    // The rich gap description names every candidate and why each was passed
    // over. Pre-fix a departed employee landed in 'eligible_but_unchosen' —
    // the manager was told the ranker made a choice it never made.
    const leaver = emp('leaver', { last_day: WED });
    const result = build([leaver]);
    const thuGap = result.gaps.find(g => g.date === THU);

    const d = thuGap!.per_employee_dispositions.find(x => x.employee_id === 'leaver');
    expect(d).toBeDefined();
    expect(d!.reason).toBe('past_last_day');
    expect(thuGap!.description).toMatch(/past their last day/i);
  });

  it('the SAME employee shows no departure disposition before their last day', () => {
    // Pins that the disposition is per-DATE. Wednesday is filled by the leaver,
    // so we look at a second unfilled slot on a day they can still work.
    const leaver = emp('leaver', { last_day: WED, max: 6 }); // one shift only
    const result = build([leaver]);
    const monGap = result.gaps.find(g => g.date === MON);

    // They took Sunday (max 6h), so Monday is a gap — but for HOURS, not death.
    expect(monGap).toBeDefined();
    const d = monGap!.per_employee_dispositions.find(x => x.employee_id === 'leaver');
    expect(d!.reason).toBe('max_hours_reached');
  });
});
