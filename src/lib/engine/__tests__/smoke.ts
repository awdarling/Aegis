/// <reference types="node" />
// Compile-time smoke test. Confirms the engine module surface matches what
// the build workflow expects to import. No runtime execution on import — the
// runtime test block at the bottom only runs when this file is invoked
// directly (e.g. `npx ts-node src/lib/engine/__tests__/smoke.ts`).

import { getWeekBounds } from '../week-bounds';
import { buildCanvas } from '../canvas';
import {
  buildEligibility,
  isAvailableForShift,
  isBlockedByTOForSlot,
  isQualifiedForRole,
  isVeteranOnlyDate,
  sameDayDoubleReason,
  shiftsOverlap,
  type VeteranOnlyRange,
} from '../eligibility';
import { rankCandidates } from '../ranker';
import { resolveBannedPairConflict } from '../cascade';
import { enforceAttributeMixForShift } from '../attribute-mix';
import { parseConstraints } from '../../constraints/parser';
import {
  DEFAULT_ENGINE_SETTINGS,
  type AttributeMixConstraint,
  type ConstraintType,
  type EngineSettings,
  type ParsedConstraints,
} from '../../constraints/types';
import type {
  Employee,
  Availability,
  EmployeeConflict,
  Event,
  Policy,
  ShiftRequirement,
  ShiftType,
} from '../../../db/types';
import type {
  CanvasSlot,
  CandidatePool,
  FlaggedIssue,
  WeekState,
} from '../types';
import type { TOWindow } from '../../to-window';
import { runScheduleBuild, type BuildData, type ScheduleAssignment, type VeteranMode } from '../../../workflows/schedule-build';

// Type-level signature assertions. The compiler errors on any drift.

type _WeekBounds = (offset?: number) => { weekStart: string; weekEnd: string };
const _wb: _WeekBounds = getWeekBounds;
void _wb;

type _Canvas = (
  weekDates: string[],
  shiftTypes: ShiftType[],
  shiftRequirements: ShiftRequirement[],
  events: Event[]
) => CanvasSlot[];
const _c: _Canvas = buildCanvas;
void _c;

type _Elig = (
  slot: CanvasSlot,
  employees: Employee[],
  availByEmp: Map<string, Availability[]>,
  toMap: Map<string, TOWindow>,
  veteranOnlyDates: VeteranOnlyRange[]
) => CandidatePool;
const _e: _Elig = buildEligibility;
void _e;

type _IsQual = (emp: Employee, role: string) => boolean;
const _iq: _IsQual = isQualifiedForRole;
void _iq;

type _IsAvail = (emp: Employee, slot: CanvasSlot, availByEmp: Map<string, Availability[]>) => boolean;
const _ia: _IsAvail = isAvailableForShift;
void _ia;

type _IsTO = (emp: Employee, slot: CanvasSlot, toMap: Map<string, TOWindow>) => boolean;
const _it: _IsTO = isBlockedByTOForSlot;
void _it;

type _IsVet = (date: string, ranges: VeteranOnlyRange[]) => boolean;
const _iv: _IsVet = isVeteranOnlyDate;
void _iv;

type _Rank = (
  pool: Employee[],
  slot: CanvasSlot,
  weekState: WeekState,
  conflicts: EmployeeConflict[],
  settings: EngineSettings,
  veteranMode: VeteranMode
) => Employee[];
const _r: _Rank = rankCandidates;
void _r;

const _resolver = resolveBannedPairConflict;
void _resolver;

const _enforcer = enforceAttributeMixForShift;
void _enforcer;

const _parser: (policies: Policy[]) => ParsedConstraints = parseConstraints;
void _parser;

// Sanity: types exist.
const _defaults: EngineSettings = DEFAULT_ENGINE_SETTINGS;
void _defaults;
const _ct: ConstraintType = 'attribute_mix';
void _ct;
const _amix: AttributeMixConstraint = {
  type: 'attribute_mix',
  attribute: 'is_veteran',
  minimums: { true: 1 },
  scope: 'all_shifts',
};
void _amix;
const _fi: FlaggedIssue = {
  type: 'unresolvable_conflict',
  date: '2026-01-01',
  shift_name: 'Lunch',
  description: 'sample',
  metadata: {},
};
void _fi;
const _sa: ScheduleAssignment = {
  date: '2026-01-01',
  employee_id: 'x',
  employee_name: 'x',
  shift_name: 'Lunch',
  role: 'Server',
  start_time: '09:00',
  end_time: '17:00',
  hours: 8,
};
void _sa;

// Signature assertions for the new same-day-doubles surface.
type _Overlap = (aStart: string, aEnd: string, bStart: string, bEnd: string) => boolean;
const _ov: _Overlap = shiftsOverlap;
void _ov;

type _SameDay = (
  empId: string,
  slot: CanvasSlot,
  weekState: WeekState,
  settings: EngineSettings,
) => string | null;
const _sd: _SameDay = sameDayDoubleReason;
void _sd;

// ── Runtime test block ───────────────────────────────────────────────────────
// Only runs when this file is invoked directly. Imports leave runtime alone.

function emptyWeekState(): WeekState {
  return {
    weeklyHoursMap: new Map(),
    assignments: [],
    gaps: [],
    flagged_issues: [],
  };
}

function makeSlot(opts: Partial<CanvasSlot> & { date: string; start_time: string; end_time: string }): CanvasSlot {
  return {
    date: opts.date,
    shift_type_id: opts.shift_type_id ?? 'st',
    shift_name: opts.shift_name ?? 'Shift',
    shift_requirement_id: opts.shift_requirement_id ?? 'req',
    role: opts.role ?? 'Lifeguard',
    start_time: opts.start_time,
    end_time: opts.end_time,
    hours: opts.hours ?? 4,
    required_count: opts.required_count ?? 1,
    slot_index: opts.slot_index ?? 0,
    is_priority: opts.is_priority ?? false,
  };
}

function makeAssignment(date: string, employee_id: string, start_time: string, end_time: string): ScheduleAssignment {
  return {
    date,
    employee_id,
    employee_name: employee_id,
    shift_name: 'Other',
    role: 'Lifeguard',
    start_time,
    end_time,
    hours: 4,
  };
}

function expect(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

function runDoublesAndOverlapsSmoke(): void {
  // Pure overlap function — unit-level sanity.
  expect(shiftsOverlap('09:00', '15:30', '15:00', '21:15') === true,
    "shiftsOverlap: ('09:00','15:30','15:00','21:15') → true (30-min overlap)");
  expect(shiftsOverlap('09:00', '15:00', '15:00', '21:00') === false,
    "shiftsOverlap: ('09:00','15:00','15:00','21:00') → false (touching, not overlapping)");
  expect(shiftsOverlap('11:00', '15:30', '13:00', '21:00') === true,
    "shiftsOverlap: ('11:00','15:30','13:00','21:00') → true");
  expect(shiftsOverlap('09:00:00', '15:30:00', '15:00:00', '21:15:00') === true,
    'shiftsOverlap: HH:MM:SS inputs normalized to HH:MM');

  const policyNever: EngineSettings = { ...DEFAULT_ENGINE_SETTINGS, doublesPolicy: 'never' };
  const policyEmergency: EngineSettings = { ...DEFAULT_ENGINE_SETTINGS, doublesPolicy: 'emergency_only' };
  const policyAllow: EngineSettings = { ...DEFAULT_ENGINE_SETTINGS, doublesPolicy: 'allow' };

  const DATE = '2026-06-15';
  const empId = 'emp-1';

  // Scenario 1: AM 11:00-15:30 already assigned. Slot is Afternoon
  // 15:00-21:15 (30-min overlap). Both shifts on same date.
  const overlapState = emptyWeekState();
  overlapState.assignments.push(makeAssignment(DATE, empId, '11:00', '15:30'));
  const afternoonOverlap = makeSlot({ date: DATE, start_time: '15:00', end_time: '21:15' });

  // Test A — policy 'never' + overlap: REJECT (block reason given).
  expect(
    sameDayDoubleReason(empId, afternoonOverlap, overlapState, policyNever)
      === 'already scheduled for an overlapping shift this day',
    "Test A: policy 'never' + overlap → rejected as overlap (not as policy)",
  );

  // Test B — policy 'allow' + overlap: STILL REJECT (overlap is physical).
  expect(
    sameDayDoubleReason(empId, afternoonOverlap, overlapState, policyAllow)
      === 'already scheduled for an overlapping shift this day',
    "Test B: policy 'allow' + overlap → still rejected (hard physical constraint)",
  );

  // Test B-bis — policy 'emergency_only' + overlap: STILL REJECT.
  expect(
    sameDayDoubleReason(empId, afternoonOverlap, overlapState, policyEmergency)
      === 'already scheduled for an overlapping shift this day',
    "policy 'emergency_only' + overlap → rejected as overlap",
  );

  // Scenario 2: AM 09:00-12:00 already assigned. Slot is Afternoon
  // 15:00-18:00 (NO overlap).
  const cleanState = emptyWeekState();
  cleanState.assignments.push(makeAssignment(DATE, empId, '09:00', '12:00'));
  const afternoonClean = makeSlot({ date: DATE, start_time: '15:00', end_time: '18:00' });

  // Test C — policy 'allow' + non-overlapping same-day: ACCEPT.
  expect(
    sameDayDoubleReason(empId, afternoonClean, cleanState, policyAllow) === null,
    "Test C: policy 'allow' + non-overlapping → accepted (null)",
  );

  // Test D — policy 'never' + non-overlapping same-day: REJECT by policy.
  expect(
    sameDayDoubleReason(empId, afternoonClean, cleanState, policyNever)
      === 'doubles not allowed by company policy',
    "Test D: policy 'never' + non-overlapping → rejected by policy",
  );

  // Test E — policy 'emergency_only' + non-overlapping: REJECT (no emergency
  // context in standard build, treated as 'never' for now).
  expect(
    sameDayDoubleReason(empId, afternoonClean, cleanState, policyEmergency)
      === 'doubles not allowed by company policy',
    "Test E: policy 'emergency_only' + non-overlapping → rejected (no emergency context)",
  );

  // Scenario 3: no existing same-day assignments at all.
  expect(
    sameDayDoubleReason(empId, afternoonClean, emptyWeekState(), policyNever) === null,
    'no same-day assignments → accepted regardless of policy',
  );

  // Scenario 4: existing same-day assignment is for a different employee.
  const otherEmpState = emptyWeekState();
  otherEmpState.assignments.push(makeAssignment(DATE, 'someone-else', '11:00', '15:30'));
  expect(
    sameDayDoubleReason(empId, afternoonOverlap, otherEmpState, policyNever) === null,
    "different employee's overlapping assignment → does not block",
  );

  // Scenario 5: existing assignment is on a different date.
  const otherDateState = emptyWeekState();
  otherDateState.assignments.push(makeAssignment('2026-06-14', empId, '11:00', '15:30'));
  expect(
    sameDayDoubleReason(empId, afternoonOverlap, otherDateState, policyNever) === null,
    'same employee, different date → does not block',
  );
}

// Regression: shift_requirements.days_active must be ignored end-to-end.
// Only the parent shift_type's days_active gates which days the engine plans
// for. This calls runScheduleBuild (the production entry point) so the test
// covers the canvas-build pre-filter inside schedule-build.ts — the
// dispositive site for the Watermark Greeter bug. Direct buildCanvas calls
// rely on schedule-build's stamping mechanism and are out of scope here.
function runDaysActiveConsolidationSmoke(): void {
  const COMPANY_ID = 'company-1';
  const ST_ID = 'st-weekday-greeter';

  const shiftType: ShiftType = {
    id: ST_ID,
    company_id: COMPANY_ID,
    name: 'Weekday Greeter',
    start_time: '09:00',
    end_time: '13:00',
    days_active: [1, 2, 3, 4, 5], // Mon-Fri on shift_type — correct
    active: true,
    created_at: '2026-01-01T00:00:00Z',
  };

  // The bug condition: parent shift_type says Mon-Fri, requirement says []
  // (stale). Pre-fix engine silently dropped all 5 weekday slots.
  const stale: ShiftRequirement = {
    id: 'req-greeter',
    company_id: COMPANY_ID,
    shift_name: 'Weekday Greeter',
    role: 'Greeter',
    required_count: 1,
    start_time: '09:00',
    end_time: '13:00',
    days_active: [], // ← the bug condition
    shift_type_id: ST_ID,
  };

  const data: BuildData = {
    employees: [],
    availByEmp: new Map(),
    toMap: new Map(),
    shiftTypes: [shiftType],
    shiftRequirements: [stale],
    conflicts: [],
    policies: [],
    events: [],
    companyName: 'Test Co',
    companyTimezone: 'America/New_York',
  };

  // Week of Mon 2026-06-01 → Sun 2026-06-07.
  const result = runScheduleBuild(
    data,
    DEFAULT_ENGINE_SETTINGS,
    null,
    [],
    '2026-06-01',
    '2026-06-07',
  );

  expect(
    result.totalRequired === 5,
    `engine planned 5 weekday slots even with shift_requirement.days_active = [] (got ${result.totalRequired})`,
  );
  expect(
    result.totalFilled === 0,
    'no employees in fixture, so zero slots filled (totalFilled === 0)',
  );
  expect(
    result.gaps.length === 5 && result.gaps.every(g => g.role === 'Greeter' && g.shift_name === 'Weekday Greeter'),
    'all 5 missed slots show as Greeter gaps under the Weekday Greeter shift',
  );
  expect(
    new Set(result.gaps.map(g => g.date)).size === 5 &&
      result.gaps.map(g => g.date).every(d => /^2026-06-0[1-5]$/.test(d)),
    'gap dates cover Mon-Fri exactly (one per weekday, no weekend, no dupes)',
  );

  // Sanity check: a shift_type with empty days_active produces zero slots
  // even if the requirement's own days_active would have permitted them.
  const inactiveST: ShiftType = { ...shiftType, days_active: [] };
  const inactiveData: BuildData = { ...data, shiftTypes: [inactiveST] };
  const inactiveResult = runScheduleBuild(
    inactiveData,
    DEFAULT_ENGINE_SETTINGS,
    null,
    [],
    '2026-06-01',
    '2026-06-07',
  );
  expect(
    inactiveResult.totalRequired === 0,
    'shift_type with empty days_active produces no slots (sole source of truth)',
  );
}

// Locks in the attribute-mix unsatisfiability skip. A rule whose minimums
// sum exceeds the total positions on a shift must be silently skipped (no
// flag), but a rule that COULD be satisfied with the right pool but isn't
// (because no candidates with the needed attribute exist) must still flag.
function runAttributeMixUnsatisfiabilitySmoke(): void {
  const COMPANY_ID = 'company-attr-mix';

  // Shared policy: needs 1 male + 1 female per shift (sum = 2).
  const genderPolicy: Policy = {
    id: 'pol-gender',
    company_id: COMPANY_ID,
    policy_key: 'gender_requirement',
    policy_value: 'At least 1 male and 1 female per shift.',
    policy_value_json: { attribute: 'sex', minimums: { male: 1, female: 1 }, scope: 'all_shifts' },
    policy_type: 'coverage',
    description: null,
    version: 1,
    created_at: '2026-01-01T00:00:00Z',
  };

  // Monday-only availability for our fixture employees.
  const mondayAvail = (id: string, empId: string): Availability => ({
    id,
    employee_id: empId,
    company_id: COMPANY_ID,
    day_of_week: 1,
    start_time: '00:00',
    end_time: '23:59',
  });

  // ── Fixture A: UNSATISFIABLE (1 position, rule needs 2) ────────────────────
  {
    const ST_ID = 'st-test-greeter';
    const shiftType: ShiftType = {
      id: ST_ID,
      company_id: COMPANY_ID,
      name: 'Test Greeter',
      start_time: '09:00',
      end_time: '13:00',
      days_active: [1],
      active: true,
      created_at: '2026-01-01T00:00:00Z',
    };
    const req: ShiftRequirement = {
      id: 'req-test-greeter',
      company_id: COMPANY_ID,
      shift_name: 'Test Greeter',
      role: 'Greeter',
      required_count: 1,
      start_time: '09:00',
      end_time: '13:00',
      days_active: [1],
      shift_type_id: ST_ID,
    };
    const male: Employee = {
      id: 'emp-male-1',
      company_id: COMPANY_ID,
      name: 'Male One',
      primary_role: 'Greeter',
      qualified_roles: ['Greeter'],
      max_weekly_hours: 40,
      contact_phone: null,
      contact_email: null,
      active: true,
      created_at: '2026-01-01T00:00:00Z',
      individual_wage: null,
      is_veteran: false,
    };
    // `sex` is read by attribute-mix via dynamic attribute lookup; the
    // hand-written Employee type doesn't list it, so cast through unknown.
    (male as unknown as Record<string, unknown>).sex = 'male';

    const availByEmp = new Map<string, Availability[]>([[male.id, [mondayAvail('av-m1', male.id)]]]);

    const data: BuildData = {
      employees: [male],
      availByEmp,
      toMap: new Map(),
      shiftTypes: [shiftType],
      shiftRequirements: [req],
      conflicts: [],
      policies: [genderPolicy],
      events: [],
      companyName: 'Test Co',
      companyTimezone: 'America/New_York',
    };

    const result = runScheduleBuild(
      data,
      DEFAULT_ENGINE_SETTINGS,
      null,
      [],
      '2026-06-01',
      '2026-06-01',
    );

    const attrFlags = result.flagged_issues.filter(f => f.type === 'unsatisfied_attribute_mix');
    expect(
      attrFlags.length === 0,
      `Fixture A: rule needs 2 (1m+1f) on a 1-position shift — no attribute_mix flags (got ${attrFlags.length})`,
    );
    expect(
      result.totalFilled === 1,
      `Fixture A: the male still fills the 1 Greeter slot (totalFilled === 1, got ${result.totalFilled})`,
    );
  }

  // ── Fixture B: SATISFIABLE BUT UNSATISFIED (4 positions, no females) ───────
  {
    const ST_ID = 'st-test-big';
    const shiftType: ShiftType = {
      id: ST_ID,
      company_id: COMPANY_ID,
      name: 'Test Big Shift',
      start_time: '09:00',
      end_time: '13:00',
      days_active: [1],
      active: true,
      created_at: '2026-01-01T00:00:00Z',
    };
    const req: ShiftRequirement = {
      id: 'req-test-big',
      company_id: COMPANY_ID,
      shift_name: 'Test Big Shift',
      role: 'Lifeguard',
      required_count: 4,
      start_time: '09:00',
      end_time: '13:00',
      days_active: [1],
      shift_type_id: ST_ID,
    };

    const males: Employee[] = [1, 2, 3, 4].map(n => ({
      id: `emp-male-${n}`,
      company_id: COMPANY_ID,
      name: `Male ${n}`,
      primary_role: 'Lifeguard',
      qualified_roles: ['Lifeguard'],
      max_weekly_hours: 40,
      contact_phone: null,
      contact_email: null,
      active: true,
      created_at: '2026-01-01T00:00:00Z',
      individual_wage: null,
      is_veteran: false,
    }));
    for (const m of males) (m as unknown as Record<string, unknown>).sex = 'male';

    const availByEmp = new Map<string, Availability[]>(
      males.map(m => [m.id, [mondayAvail(`av-${m.id}`, m.id)]])
    );

    const data: BuildData = {
      employees: males,
      availByEmp,
      toMap: new Map(),
      shiftTypes: [shiftType],
      shiftRequirements: [req],
      conflicts: [],
      policies: [genderPolicy],
      events: [],
      companyName: 'Test Co',
      companyTimezone: 'America/New_York',
    };

    const result = runScheduleBuild(
      data,
      DEFAULT_ENGINE_SETTINGS,
      null,
      [],
      '2026-06-01',
      '2026-06-01',
    );

    const attrFlags = result.flagged_issues.filter(f => f.type === 'unsatisfied_attribute_mix');
    expect(
      attrFlags.length === 1,
      `Fixture B: 4-position shift, no females — exactly 1 attribute_mix flag (got ${attrFlags.length})`,
    );
    expect(
      attrFlags[0]?.metadata.attribute === 'sex' && attrFlags[0]?.metadata.value === 'female',
      `Fixture B: flag identifies the missing female (attribute=sex, value=female)`,
    );
    expect(
      result.totalFilled === 4,
      `Fixture B: all 4 positions still filled with males (totalFilled === 4, got ${result.totalFilled})`,
    );
  }
}

if (require.main === module) {
  runDoublesAndOverlapsSmoke();
  console.log('');
  runDaysActiveConsolidationSmoke();
  console.log('');
  runAttributeMixUnsatisfiabilitySmoke();
  if (!process.exitCode) console.log('\nAll smoke checks passed.');
}
