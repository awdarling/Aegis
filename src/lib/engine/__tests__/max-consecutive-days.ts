/// <reference types="node" />
// Runtime tests for the max_consecutive_days_worked engine constraint.
//
// Same shape as smoke.ts — a runtime block guarded by require.main === module
// so importing the file is side-effect-free.
//
// Run: npx ts-node src/lib/engine/__tests__/max-consecutive-days.ts

import {
  DEFAULT_ENGINE_SETTINGS,
  type EngineSettings,
} from '../../constraints/types';
import type {
  Availability,
  Employee,
  ShiftRequirement,
  ShiftType,
} from '../../../db/types';
import { runScheduleBuild, type BuildData } from '../../../workflows/schedule-build';

function expect(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

// Build a tiny 1-employee / 7-day-demand fixture. The week runs Mon
// 2026-06-01 through Sun 2026-06-07 — getUTCDay() values 1..0 (Mon..Sun).
function buildSingleEmployeeWeekFixture(): BuildData {
  const COMPANY_ID = 'company-maxconsec';
  const ST_ID = 'st-daily';

  const shiftType: ShiftType = {
    id: ST_ID,
    company_id: COMPANY_ID,
    name: 'Daily',
    start_time: '09:00',
    end_time: '13:00',
    days_active: [0, 1, 2, 3, 4, 5, 6],
    active: true,
    created_at: '2026-01-01T00:00:00Z',
  };
  const req: ShiftRequirement = {
    id: 'req-daily',
    company_id: COMPANY_ID,
    shift_name: 'Daily',
    role: 'Lifeguard',
    required_count: 1,
    start_time: '09:00',
    end_time: '13:00',
    days_active: [0, 1, 2, 3, 4, 5, 6],
    shift_type_id: ST_ID,
  };

  const emp: Employee = {
    id: 'emp-solo',
    company_id: COMPANY_ID,
    name: 'Solo Lifeguard',
    primary_role: 'Lifeguard',
    qualified_roles: ['Lifeguard'],
    max_weekly_hours: 40,  // 7 × 4h = 28h < 40h — weekly cap never binds
    contact_phone: null,
    contact_email: null,
    active: true,
    created_at: '2026-01-01T00:00:00Z',
    individual_wage: null,
    is_veteran: false,
  };

  const availability: Availability[] = [0, 1, 2, 3, 4, 5, 6].map(dow => ({
    id: `av-${emp.id}-${dow}`,
    employee_id: emp.id,
    company_id: COMPANY_ID,
    day_of_week: dow,
    start_time: '00:00',
    end_time: '23:59',
  }));

  return {
    employees: [emp],
    availByEmp: new Map([[emp.id, availability]]),
    toMap: new Map(),
    shiftTypes: [shiftType],
    shiftRequirements: [req],
    conflicts: [],
    policies: [],
    events: [],
    companyName: 'Test Co',
    companyTimezone: 'America/New_York',
  };
}

const WEEK_START = '2026-06-01';
const WEEK_END = '2026-06-07';
const SOLO_ID = 'emp-solo';

// (a) Regression — with maxConsecutiveDaysWorked unset (default null), the
// engine behaves identically to the pre-feature path. The 1-employee, 7-day,
// 40h-cap fixture must produce 7 assignments, 0 gaps, and zero
// 'max_consecutive_days_reached' dispositions.
function runRegressionNoCapSmoke(): void {
  const data = buildSingleEmployeeWeekFixture();
  const result = runScheduleBuild(
    data,
    DEFAULT_ENGINE_SETTINGS,  // maxConsecutiveDaysWorked: null
    null,
    [],
    WEEK_START,
    WEEK_END,
  );

  expect(
    result.totalRequired === 7,
    `Regression: totalRequired === 7 (got ${result.totalRequired})`,
  );
  expect(
    result.totalFilled === 7,
    `Regression: all 7 demanded slots filled with the lone employee (totalFilled === 7, got ${result.totalFilled})`,
  );
  expect(
    result.gaps.length === 0,
    `Regression: no gaps under default settings (got ${result.gaps.length})`,
  );
  expect(
    result.assignments.every(a => a.employee_id === SOLO_ID),
    `Regression: every assignment goes to the solo employee`,
  );

  const allMaxConsec = result.gaps.flatMap(g =>
    g.per_employee_dispositions.filter(d => d.reason === 'max_consecutive_days_reached'),
  );
  expect(
    allMaxConsec.length === 0,
    `Regression: zero 'max_consecutive_days_reached' dispositions anywhere (got ${allMaxConsec.length})`,
  );
}

// (b) Enforcement — same fixture, but max=5. Expected per the step-3 spec
// ("consecutive worked-day run WITHIN the build week, computed strictly from
// assignments already made"):
//   - Days 1–5 (Mon–Fri) are filled.
//   - Day 6 (Sat) is rejected because the candidate's run including Sat would
//     be 6 (Mon..Sat), exceeding max=5 → gap with reason
//     'max_consecutive_days_reached'.
//   - Day 7 (Sun) is FILLED — Saturday wasn't worked, so the run resets and
//     placing on Sun is a fresh run of length 1, within the cap.
//
// NOTE: the step-4 brief's expected outcome ("days 6–7 become GAPS") would
// require a different semantic — e.g. a permanent post-cap lockout for the
// rest of the week — that the step-3 spec does not describe. The
// implementation follows the spec; this test asserts the spec-consistent
// outcome and documents the deviation explicitly in BUILD_NOTES.
function runEnforcementMaxFiveSmoke(): void {
  const data = buildSingleEmployeeWeekFixture();
  const settings: EngineSettings = {
    ...DEFAULT_ENGINE_SETTINGS,
    maxConsecutiveDaysWorked: 5,
  };
  const result = runScheduleBuild(
    data,
    settings,
    null,
    [],
    WEEK_START,
    WEEK_END,
  );

  expect(
    result.totalRequired === 7,
    `Enforcement: totalRequired === 7 (got ${result.totalRequired})`,
  );

  const assignedDates = result.assignments
    .filter(a => a.employee_id === SOLO_ID)
    .map(a => a.date)
    .sort();
  const expectedAssigned = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-07'];
  expect(
    JSON.stringify(assignedDates) === JSON.stringify(expectedAssigned),
    `Enforcement: solo employee placed Mon–Fri + Sun, NOT Sat (got [${assignedDates.join(', ')}])`,
  );
  expect(
    result.totalFilled === 6,
    `Enforcement: 6 of 7 slots filled — 1 gap on Sat (totalFilled === 6, got ${result.totalFilled})`,
  );

  const satGaps = result.gaps.filter(g => g.date === '2026-06-06');
  expect(
    satGaps.length === 1,
    `Enforcement: exactly 1 gap on Sat 2026-06-06 (got ${satGaps.length})`,
  );
  const satGap = satGaps[0];
  expect(
    !!satGap && satGap.per_employee_dispositions.length === 1,
    `Enforcement: Sat gap classifies the 1 qualified employee (got ${satGap?.per_employee_dispositions.length})`,
  );
  const satDisp = satGap?.per_employee_dispositions[0];
  expect(
    satDisp?.employee_id === SOLO_ID && satDisp?.reason === 'max_consecutive_days_reached',
    `Enforcement: Sat gap disposition is (${SOLO_ID}, 'max_consecutive_days_reached') (got ${satDisp?.employee_id}/${satDisp?.reason})`,
  );

  const sunGaps = result.gaps.filter(g => g.date === '2026-06-07');
  expect(
    sunGaps.length === 0,
    `Enforcement: Sun has no gap — run reset after Sat (got ${sunGaps.length})`,
  );

  const sunAssignments = result.assignments.filter(a => a.date === '2026-06-07');
  expect(
    sunAssignments.length === 1 && sunAssignments[0]?.employee_id === SOLO_ID,
    `Enforcement: Sun is filled by the solo employee (got ${sunAssignments.length} assignments, employee ${sunAssignments[0]?.employee_id})`,
  );

  // Other gaps (Mon–Fri) must not exist.
  const offDayGaps = result.gaps.filter(g => g.date !== '2026-06-06');
  expect(
    offDayGaps.length === 0,
    `Enforcement: no other gaps besides Sat (got ${offDayGaps.length})`,
  );
}

if (require.main === module) {
  runRegressionNoCapSmoke();
  console.log('');
  runEnforcementMaxFiveSmoke();
  if (!process.exitCode) console.log('\nAll max-consecutive-days checks passed.');
}
