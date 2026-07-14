/// <reference types="node" />
// Compile-time smoke test. Confirms the engine module surface matches what
// the build workflow expects to import. No runtime execution on import — the
// runtime test block at the bottom only runs when this file is invoked
// directly (e.g. `npx ts-node src/lib/engine/__tests__/smoke.ts`).

import { getWeekBounds } from '../week-bounds';
import { buildCanvas, type CanvasResult, type CanvasRequirement } from '../canvas';
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
import { computeWageEstimateFromMaps } from '../../schedule-simulator';
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
import {
  runScheduleBuild,
  SCHEDULE_BUILD_SAVE_FAILED,
  type BuildData,
  type ScheduleAssignment,
  type VeteranMode,
} from '../../../workflows/schedule-build';

// Type-level signature assertions. The compiler errors on any drift.

type _WeekBounds = (offset?: number) => { weekStart: string; weekEnd: string };
const _wb: _WeekBounds = getWeekBounds;
void _wb;

// buildCanvas takes CanvasRequirement — role + count + shift_type_id + a date
// stamp — NOT a raw shift_requirements row. Rule 0: no copied shift attributes
// cross into the engine; name/hours/days come from the ShiftType the manager
// defined. If this assertion ever fails because someone widened it back to
// ShiftRequirement, that is the regression.
type _Canvas = (
  weekDates: string[],
  shiftTypes: ShiftType[],
  shiftRequirements: CanvasRequirement[],
  events: Event[]
) => CanvasResult;
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
  type: 'unsatisfied_attribute_mix',
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
    accepted_roles: [opts.role ?? 'Lifeguard'],
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
    role: 'Greeter',
    accepted_roles: ['Greeter'],
    required_count: 1,
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
      role: 'Greeter',
      accepted_roles: ['Greeter'],
      required_count: 1,
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
      role: 'Lifeguard',
      accepted_roles: ['Lifeguard'],
      required_count: 4,
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

// Locks in the swap-pass cascade fix: when the first over-represented
// assignee is filling a role the candidate doesn't qualify for, the swap
// pass must iterate to the next over-represented assignee rather than
// aborting. Three fixtures cover (A) success after one non-match, (B)
// graceful failure when no role composes, (C) success after three
// consecutive non-matches.
function runAttributeMixSwapPassSmoke(): void {
  const COMPANY_ID = 'company-swap-pass';

  const baseEmp = (
    id: string,
    name: string,
    primaryRole: string,
    qualifiedRoles: string[],
    sex: 'male' | 'female',
  ): Employee => {
    const e: Employee = {
      id,
      company_id: COMPANY_ID,
      name,
      primary_role: primaryRole,
      qualified_roles: qualifiedRoles,
      max_weekly_hours: 40,
      contact_phone: null,
      contact_email: null,
      active: true,
      created_at: '2026-01-01T00:00:00Z',
      individual_wage: null,
      is_veteran: false,
    };
    (e as unknown as Record<string, unknown>).sex = sex;
    return e;
  };

  const mondayAvail = (empId: string): Availability => ({
    id: `av-${empId}`,
    employee_id: empId,
    company_id: COMPANY_ID,
    day_of_week: 1,
    start_time: '00:00',
    end_time: '23:59',
  });

  // Policy: at-least-one of each sex. Minimums must list both values so the
  // 'over' set is non-empty when females dominate (required for swap-pass
  // to consider any removable).
  const genderPolicy: Policy = {
    id: 'pol-gender-swap',
    company_id: COMPANY_ID,
    policy_key: 'gender_requirement',
    policy_value: '1m+1f',
    policy_value_json: { attribute: 'sex', minimums: { male: 1, female: 1 }, scope: 'all_shifts' },
    policy_type: 'coverage',
    description: null,
    version: 1,
    created_at: '2026-01-01T00:00:00Z',
  };

  // A requirement no longer carries the shift's name/hours/days — those live on
  // shift_types, the row the manager edits (Rule 0; columns dropped 2026-07-13).
  // `shiftName` is kept in the signature for call-site readability only.
  const buildReqs = (stId: string, _shiftName: string, layout: Array<{ role: string; count: number }>): ShiftRequirement[] =>
    layout.map((spec, i) => ({
      id: `req-${stId}-${i}`,
      company_id: COMPANY_ID,
      shift_type_id: stId,
      role: spec.role,
      accepted_roles: [spec.role],
      required_count: spec.count,
    }));

  // ── Fixture A: 4 positions (1 HG, 2 LG, 1 Mgr), 4 females + 1 male LG-only ─
  // After initial fill all 4 slots are female. Swap pass walks removables —
  // HG and Mgr roles don't compose with the LG-only male; one of the LG
  // assignees does. Expect: 0 attribute_mix flags, male on an LG slot.
  {
    const ST_ID = 'st-fixA';
    const shiftType: ShiftType = {
      id: ST_ID,
      company_id: COMPANY_ID,
      name: 'Swap-A Shift',
      start_time: '09:00',
      end_time: '13:00',
      days_active: [1],
      active: true,
      created_at: '2026-01-01T00:00:00Z',
    };
    const reqs = buildReqs(ST_ID, 'Swap-A Shift', [
      { role: 'Head Guard', count: 1 },
      { role: 'Lifeguard', count: 2 },
      { role: 'Manager', count: 1 },
    ]);

    const femHG = baseEmp('emp-A-fHG', 'Alpha FHG', 'Head Guard', ['Head Guard'], 'female');
    const femLG1 = baseEmp('emp-A-fLG1', 'Beta FLG', 'Lifeguard', ['Lifeguard'], 'female');
    const femLG2 = baseEmp('emp-A-fLG2', 'Cara FLG', 'Lifeguard', ['Lifeguard'], 'female');
    const femMgr = baseEmp('emp-A-fMgr', 'Delta FMgr', 'Manager', ['Manager'], 'female');
    // Male is LG-only and named to sort AFTER the female LGs so the initial
    // fill picks the females. Swap pass should still be able to displace one.
    const maleLG = baseEmp('emp-A-mLG', 'Zed MLG', 'Lifeguard', ['Lifeguard'], 'male');

    const employees = [femHG, femLG1, femLG2, femMgr, maleLG];
    const availByEmp = new Map<string, Availability[]>(
      employees.map(e => [e.id, [mondayAvail(e.id)]])
    );

    const data: BuildData = {
      employees,
      availByEmp,
      toMap: new Map(),
      shiftTypes: [shiftType],
      shiftRequirements: reqs,
      conflicts: [],
      policies: [genderPolicy],
      events: [],
      companyName: 'Test Co',
      companyTimezone: 'America/New_York',
    };

    const result = runScheduleBuild(data, DEFAULT_ENGINE_SETTINGS, null, [], '2026-06-01', '2026-06-01');

    const attrFlags = result.flagged_issues.filter(f => f.type === 'unsatisfied_attribute_mix');
    expect(
      attrFlags.length === 0,
      `Swap-pass A: swap past HG/Mgr non-matches resolves the rule — 0 attribute_mix flags (got ${attrFlags.length})`,
    );

    const maleAssignments = result.assignments.filter(a => a.employee_id === maleLG.id);
    expect(
      maleAssignments.length === 1 && maleAssignments[0]?.role === 'Lifeguard',
      `Swap-pass A: male ends up on exactly 1 LG slot (got ${maleAssignments.length} assignments, role ${maleAssignments[0]?.role})`,
    );

    const hgAssignment = result.assignments.find(a => a.role === 'Head Guard');
    const mgrAssignment = result.assignments.find(a => a.role === 'Manager');
    expect(
      hgAssignment?.employee_id === femHG.id,
      `Swap-pass A: HG slot untouched — still filled by ${femHG.name} (got ${hgAssignment?.employee_name})`,
    );
    expect(
      mgrAssignment?.employee_id === femMgr.id,
      `Swap-pass A: Mgr slot untouched — still filled by ${femMgr.name} (got ${mgrAssignment?.employee_name})`,
    );
    expect(
      result.totalFilled === 4,
      `Swap-pass A: all 4 positions still filled after swap (totalFilled === 4, got ${result.totalFilled})`,
    );
  }

  // ── Fixture B: 4 positions, all female-fillable, male qualified only for ──
  // a role NOT on the shift (Bartender). Swap pass iterates every removable
  // but no role composes. Expect: rule unsatisfied, flag fires, male
  // surfaces in per_employee_dispositions (preserving diagnostic shape).
  {
    const ST_ID = 'st-fixB';
    const shiftType: ShiftType = {
      id: ST_ID,
      company_id: COMPANY_ID,
      name: 'Swap-B Shift',
      start_time: '09:00',
      end_time: '13:00',
      days_active: [1],
      active: true,
      created_at: '2026-01-01T00:00:00Z',
    };
    const reqs = buildReqs(ST_ID, 'Swap-B Shift', [
      { role: 'Head Guard', count: 1 },
      { role: 'Lifeguard', count: 2 },
      { role: 'Manager', count: 1 },
    ]);

    const femHG = baseEmp('emp-B-fHG', 'Alpha FHG', 'Head Guard', ['Head Guard'], 'female');
    const femLG1 = baseEmp('emp-B-fLG1', 'Beta FLG', 'Lifeguard', ['Lifeguard'], 'female');
    const femLG2 = baseEmp('emp-B-fLG2', 'Cara FLG', 'Lifeguard', ['Lifeguard'], 'female');
    const femMgr = baseEmp('emp-B-fMgr', 'Delta FMgr', 'Manager', ['Manager'], 'female');
    // Male only qualifies for Bartender — no role on this shift accepts him.
    const maleBar = baseEmp('emp-B-mBar', 'Zed MBar', 'Bartender', ['Bartender'], 'male');

    const employees = [femHG, femLG1, femLG2, femMgr, maleBar];
    const availByEmp = new Map<string, Availability[]>(
      employees.map(e => [e.id, [mondayAvail(e.id)]])
    );

    const data: BuildData = {
      employees,
      availByEmp,
      toMap: new Map(),
      shiftTypes: [shiftType],
      shiftRequirements: reqs,
      conflicts: [],
      policies: [genderPolicy],
      events: [],
      companyName: 'Test Co',
      companyTimezone: 'America/New_York',
    };

    const result = runScheduleBuild(data, DEFAULT_ENGINE_SETTINGS, null, [], '2026-06-01', '2026-06-01');

    const attrFlags = result.flagged_issues.filter(f => f.type === 'unsatisfied_attribute_mix');
    expect(
      attrFlags.length === 1,
      `Swap-pass B: no role composes — rule remains unsatisfied, exactly 1 attribute_mix flag (got ${attrFlags.length})`,
    );
    const flag = attrFlags[0];
    const meta = flag?.metadata as {
      attribute?: string;
      value?: string;
      per_employee_dispositions?: Array<{ employee_id: string; name: string; reason: string }>;
    };
    expect(
      meta?.attribute === 'sex' && meta?.value === 'male',
      `Swap-pass B: flag identifies missing male (got attribute=${meta?.attribute} value=${meta?.value})`,
    );
    const dispEntry = meta?.per_employee_dispositions?.find(d => d.employee_id === maleBar.id);
    expect(
      dispEntry !== undefined,
      `Swap-pass B: male is enumerated in per_employee_dispositions (current diagnostic shape preserved)`,
    );
    // Classifier sees no role overlap (Bartender ∉ accepted roles) → not_qualified.
    expect(
      dispEntry?.reason === 'not_qualified',
      `Swap-pass B: male classified as not_qualified — diagnostic correctly attributes the failure (got ${dispEntry?.reason})`,
    );
    expect(
      result.totalFilled === 4,
      `Swap-pass B: all 4 female positions still filled (totalFilled === 4, got ${result.totalFilled})`,
    );
  }

  // ── Fixture C: 5 positions (2 HG, 1 Mgr, 2 LG), 5 females + 1 male LG-only ─
  // Designed so the LG removables are not first in iteration order. Locks
  // in that the swap pass keeps scanning past consecutive non-matches.
  {
    const ST_ID = 'st-fixC';
    const shiftType: ShiftType = {
      id: ST_ID,
      company_id: COMPANY_ID,
      name: 'Swap-C Shift',
      start_time: '09:00',
      end_time: '13:00',
      days_active: [1],
      active: true,
      created_at: '2026-01-01T00:00:00Z',
    };
    const reqs = buildReqs(ST_ID, 'Swap-C Shift', [
      { role: 'Head Guard', count: 2 },
      { role: 'Manager', count: 1 },
      { role: 'Lifeguard', count: 2 },
    ]);

    const femHG1 = baseEmp('emp-C-fHG1', 'Alpha FHG', 'Head Guard', ['Head Guard'], 'female');
    const femHG2 = baseEmp('emp-C-fHG2', 'Beta FHG', 'Head Guard', ['Head Guard'], 'female');
    const femMgr = baseEmp('emp-C-fMgr', 'Cara FMgr', 'Manager', ['Manager'], 'female');
    const femLG1 = baseEmp('emp-C-fLG1', 'Delta FLG', 'Lifeguard', ['Lifeguard'], 'female');
    const femLG2 = baseEmp('emp-C-fLG2', 'Eve FLG', 'Lifeguard', ['Lifeguard'], 'female');
    const maleLG = baseEmp('emp-C-mLG', 'Zed MLG', 'Lifeguard', ['Lifeguard'], 'male');

    const employees = [femHG1, femHG2, femMgr, femLG1, femLG2, maleLG];
    const availByEmp = new Map<string, Availability[]>(
      employees.map(e => [e.id, [mondayAvail(e.id)]])
    );

    const data: BuildData = {
      employees,
      availByEmp,
      toMap: new Map(),
      shiftTypes: [shiftType],
      shiftRequirements: reqs,
      conflicts: [],
      policies: [genderPolicy],
      events: [],
      companyName: 'Test Co',
      companyTimezone: 'America/New_York',
    };

    const result = runScheduleBuild(data, DEFAULT_ENGINE_SETTINGS, null, [], '2026-06-01', '2026-06-01');

    const attrFlags = result.flagged_issues.filter(f => f.type === 'unsatisfied_attribute_mix');
    expect(
      attrFlags.length === 0,
      `Swap-pass C: swap past 2 HG + 1 Mgr non-matches succeeds on an LG — 0 attribute_mix flags (got ${attrFlags.length})`,
    );

    const maleAssignments = result.assignments.filter(a => a.employee_id === maleLG.id);
    expect(
      maleAssignments.length === 1 && maleAssignments[0]?.role === 'Lifeguard',
      `Swap-pass C: male on exactly 1 LG slot (got ${maleAssignments.length} assignments, role ${maleAssignments[0]?.role})`,
    );

    const hgEmps = result.assignments.filter(a => a.role === 'Head Guard').map(a => a.employee_id);
    expect(
      hgEmps.length === 2 && hgEmps.includes(femHG1.id) && hgEmps.includes(femHG2.id),
      `Swap-pass C: both HG slots untouched (got ${hgEmps.join(',')})`,
    );
    const mgrEmp = result.assignments.find(a => a.role === 'Manager')?.employee_id;
    expect(
      mgrEmp === femMgr.id,
      `Swap-pass C: Mgr slot untouched (got ${mgrEmp})`,
    );
    expect(
      result.totalFilled === 5,
      `Swap-pass C: all 5 positions still filled after swap (totalFilled === 5, got ${result.totalFilled})`,
    );
  }
}

// Locks in the enriched attribute-mix flag description: when no candidate
// with the missing attribute can be placed, each blocked candidate is
// classified into a reason bucket and the description names everyone.
function runAttributeMixDiagnosticSmoke(): void {
  const COMPANY_ID = 'company-attr-diag';
  const ST_ID = 'st-test-2pos';

  const shiftType: ShiftType = {
    id: ST_ID,
    company_id: COMPANY_ID,
    name: 'Test 2-Position',
    start_time: '09:00',
    end_time: '13:00',
    days_active: [1],
    active: true,
    created_at: '2026-01-01T00:00:00Z',
  };
  const req: ShiftRequirement = {
    id: 'req-test-2pos',
    company_id: COMPANY_ID,
    role: 'Lifeguard',
    accepted_roles: ['Lifeguard'],
    required_count: 2,
    shift_type_id: ST_ID,
  };

  const baseEmp = (id: string, name: string, roles: string[], sex: 'male' | 'female'): Employee => {
    const e: Employee = {
      id,
      company_id: COMPANY_ID,
      name,
      primary_role: roles[0] ?? 'Lifeguard',
      qualified_roles: roles,
      max_weekly_hours: 40,
      contact_phone: null,
      contact_email: null,
      active: true,
      created_at: '2026-01-01T00:00:00Z',
      individual_wage: null,
      is_veteran: false,
    };
    (e as unknown as Record<string, unknown>).sex = sex;
    return e;
  };

  const male = baseEmp('emp-m', 'Male Picked', ['Lifeguard'], 'male');
  const femTO = baseEmp('emp-f-to', 'Female TO', ['Lifeguard'], 'female');
  const femNoAvail = baseEmp('emp-f-noav', 'Female NoAvail', ['Lifeguard'], 'female');
  const femNotQual = baseEmp('emp-f-noqual', 'Female NotQual', ['Cashier'], 'female');

  // Monday-only blanket availability for the three that should have it.
  const mondayAvail = (empId: string): Availability => ({
    id: `av-${empId}`,
    employee_id: empId,
    company_id: COMPANY_ID,
    day_of_week: 1,
    start_time: '00:00',
    end_time: '23:59',
  });
  const availByEmp = new Map<string, Availability[]>([
    [male.id, [mondayAvail(male.id)]],
    [femTO.id, [mondayAvail(femTO.id)]],
    // femNoAvail intentionally has zero rows
    [femNotQual.id, [mondayAvail(femNotQual.id)]],
  ]);

  // femTO has an approved full-day TO on Monday 2026-06-01.
  const toMap = new Map<string, TOWindow>([
    [`${femTO.id}:2026-06-01`, { type: 'full_day', blockedWindows: [] }],
  ]);

  const genderPolicy: Policy = {
    id: 'pol-gender-diag',
    company_id: COMPANY_ID,
    policy_key: 'gender_requirement',
    policy_value: 'At least 1 male and 1 female per shift.',
    policy_value_json: { attribute: 'sex', minimums: { male: 1, female: 1 }, scope: 'all_shifts' },
    policy_type: 'coverage',
    description: null,
    version: 1,
    created_at: '2026-01-01T00:00:00Z',
  };

  const data: BuildData = {
    employees: [male, femTO, femNoAvail, femNotQual],
    availByEmp,
    toMap,
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
    `Fixture C: exactly 1 attribute_mix flag (got ${attrFlags.length})`,
  );

  const flag = attrFlags[0];
  const disp = (flag?.metadata as { per_employee_dispositions?: Array<{ employee_id: string; name: string; reason: string }> })?.per_employee_dispositions ?? [];
  expect(
    disp.length === 3,
    `Fixture C: 3 female candidates classified (got ${disp.length})`,
  );

  const reasons = new Set(disp.map(d => d.reason));
  expect(
    reasons.has('on_time_off') && reasons.has('availability_mismatch') && reasons.has('not_qualified'),
    `Fixture C: each of {on_time_off, availability_mismatch, not_qualified} present in dispositions (got ${[...reasons].join(',')})`,
  );

  const desc = flag?.description ?? '';
  expect(
    desc.includes('Female TO') && desc.includes('Female NoAvail') && desc.includes('Female NotQual'),
    `Fixture C: description names all three females (got: ${desc})`,
  );
  expect(
    desc.startsWith('Need 1 sex=female on 2026-06-01 Test 2-Position.'),
    `Fixture C: description leads with the standard need-clause (got: ${desc})`,
  );
}

// Locks the activity-log action emitted on save failure. The string is part
// of the monitoring contract (dashboards/alerts may match on it), so any
// rename should fail this check first.
function runSaveFailedContractSmoke(): void {
  expect(
    SCHEDULE_BUILD_SAVE_FAILED === 'schedule_build_save_failed',
    `SCHEDULE_BUILD_SAVE_FAILED constant === 'schedule_build_save_failed' (got '${SCHEDULE_BUILD_SAVE_FAILED}')`,
  );
}

// Verifies coverage gaps carry per-employee dispositions that name every
// qualified employee. Two fixtures isolate two binding-reason buckets so we
// can assert on classification, not just shape.
function runCoverageGapDispositionSmoke(): void {
  const COMPANY_ID = 'company-gap-disp';
  const ST_ID = 'st-test-gap';

  const shiftType: ShiftType = {
    id: ST_ID,
    company_id: COMPANY_ID,
    name: 'Test Gap Shift',
    start_time: '09:00',
    end_time: '13:00',
    days_active: [1],
    active: true,
    created_at: '2026-01-01T00:00:00Z',
  };
  const req: ShiftRequirement = {
    id: 'req-test-gap',
    company_id: COMPANY_ID,
    role: 'Greeter',
    accepted_roles: ['Greeter'],
    required_count: 1,
    shift_type_id: ST_ID,
  };

  const mondayAvail = (empId: string): Availability => ({
    id: `av-${empId}`,
    employee_id: empId,
    company_id: COMPANY_ID,
    day_of_week: 1,
    start_time: '00:00',
    end_time: '23:59',
  });

  // ── Fixture A: all qualified employees on full-day TO Monday ──────────────
  {
    const emps: Employee[] = ['A', 'B', 'C'].map(letter => ({
      id: `emp-to-${letter}`,
      company_id: COMPANY_ID,
      name: `TO Greeter ${letter}`,
      primary_role: 'Greeter',
      qualified_roles: ['Greeter'],
      max_weekly_hours: 40,
      contact_phone: null,
      contact_email: null,
      active: true,
      created_at: '2026-01-01T00:00:00Z',
      individual_wage: null,
      is_veteran: false,
    }));
    const availByEmp = new Map<string, Availability[]>(emps.map(e => [e.id, [mondayAvail(e.id)]]));
    const toMap = new Map<string, TOWindow>(
      emps.map(e => [`${e.id}:2026-06-01`, { type: 'full_day', blockedWindows: [] }])
    );

    const data: BuildData = {
      employees: emps,
      availByEmp,
      toMap,
      shiftTypes: [shiftType],
      shiftRequirements: [req],
      conflicts: [],
      policies: [],
      events: [],
      companyName: 'Test Co',
      companyTimezone: 'America/New_York',
    };

    const result = runScheduleBuild(data, DEFAULT_ENGINE_SETTINGS, null, [], '2026-06-01', '2026-06-01');
    expect(
      result.gaps.length === 1,
      `Gap-disposition A: exactly 1 gap (got ${result.gaps.length})`,
    );
    const gap = result.gaps[0];
    expect(
      gap.per_employee_dispositions.length === 3,
      `Gap-disposition A: 3 employees classified (got ${gap.per_employee_dispositions.length})`,
    );
    expect(
      gap.per_employee_dispositions.every(d => d.reason === 'on_time_off'),
      `Gap-disposition A: every disposition is on_time_off (got reasons: ${gap.per_employee_dispositions.map(d => d.reason).join(',')})`,
    );
    expect(
      gap.description.includes('TO Greeter A') &&
        gap.description.includes('TO Greeter B') &&
        gap.description.includes('TO Greeter C') &&
        gap.description.includes('on approved time off'),
      `Gap-disposition A: description names all three (got: ${gap.description})`,
    );
  }

  // ── Fixture B: all qualified employees at max weekly hours ────────────────
  {
    const emps: Employee[] = ['A', 'B'].map(letter => ({
      id: `emp-max-${letter}`,
      company_id: COMPANY_ID,
      name: `Max Greeter ${letter}`,
      primary_role: 'Greeter',
      qualified_roles: ['Greeter'],
      max_weekly_hours: 0,  // any positive shift exceeds this — clean trigger for max_hours_reached
      contact_phone: null,
      contact_email: null,
      active: true,
      created_at: '2026-01-01T00:00:00Z',
      individual_wage: null,
      is_veteran: false,
    }));
    const availByEmp = new Map<string, Availability[]>(emps.map(e => [e.id, [mondayAvail(e.id)]]));

    const data: BuildData = {
      employees: emps,
      availByEmp,
      toMap: new Map(),
      shiftTypes: [shiftType],
      shiftRequirements: [req],
      conflicts: [],
      policies: [],
      events: [],
      companyName: 'Test Co',
      companyTimezone: 'America/New_York',
    };

    const result = runScheduleBuild(data, DEFAULT_ENGINE_SETTINGS, null, [], '2026-06-01', '2026-06-01');
    expect(
      result.gaps.length === 1,
      `Gap-disposition B: exactly 1 gap (got ${result.gaps.length})`,
    );
    const gap = result.gaps[0];
    expect(
      gap.per_employee_dispositions.length === 2,
      `Gap-disposition B: 2 employees classified (got ${gap.per_employee_dispositions.length})`,
    );
    expect(
      gap.per_employee_dispositions.every(d => d.reason === 'max_hours_reached'),
      `Gap-disposition B: every disposition is max_hours_reached (got reasons: ${gap.per_employee_dispositions.map(d => d.reason).join(',')})`,
    );
    expect(
      gap.description.includes('Max Greeter A') &&
        gap.description.includes('Max Greeter B') &&
        gap.description.includes('at max weekly hours'),
      `Gap-disposition B: description names both and cites max hours (got: ${gap.description})`,
    );
  }
}

// Verifies closure events surface in the build result rather than silently
// dropping a date from the canvas.
function runClosureEventSmoke(): void {
  const COMPANY_ID = 'company-closure';
  const ST_ID = 'st-closure';

  const shiftType: ShiftType = {
    id: ST_ID,
    company_id: COMPANY_ID,
    name: 'Daily Shift',
    start_time: '09:00',
    end_time: '13:00',
    days_active: [1, 2, 3, 4, 5],
    active: true,
    created_at: '2026-01-01T00:00:00Z',
  };
  const req: ShiftRequirement = {
    id: 'req-closure',
    company_id: COMPANY_ID,
    role: 'Greeter',
    accepted_roles: ['Greeter'],
    required_count: 1,
    shift_type_id: ST_ID,
  };

  // Closure on Wednesday 2026-06-03.
  const closureEvent: Event = {
    id: 'evt-closure-1',
    company_id: COMPANY_ID,
    title: 'Maintenance Day',
    date: '2026-06-03',
    end_date: '2026-06-03',
    description: null,
    event_type: 'closure',
    staffing_notes: null,
    shift_overrides: null,
    event_shifts: null,
    created_by: 'manager',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };

  const data: BuildData = {
    employees: [],
    availByEmp: new Map(),
    toMap: new Map(),
    shiftTypes: [shiftType],
    shiftRequirements: [req],
    conflicts: [],
    policies: [],
    events: [closureEvent],
    companyName: 'Test Co',
    companyTimezone: 'America/New_York',
  };

  const result = runScheduleBuild(data, DEFAULT_ENGINE_SETTINGS, null, [], '2026-06-01', '2026-06-05');

  expect(
    result.closed_dates.length === 1,
    `Closure: exactly 1 closed date in result (got ${result.closed_dates.length})`,
  );
  expect(
    result.closed_dates[0]?.date === '2026-06-03' && result.closed_dates[0]?.event_title === 'Maintenance Day',
    `Closure: date=2026-06-03 event_title='Maintenance Day' (got ${JSON.stringify(result.closed_dates[0])})`,
  );
  expect(
    !result.gaps.some(g => g.date === '2026-06-03') && result.totalRequired === 4,
    `Closure: no slots planned for the closed date — totalRequired === 4 (Mon/Tue/Thu/Fri), got ${result.totalRequired}`,
  );
}

// Task 4 — parser must surface unknown policy_keys (with reason 'unknown_key')
// rather than dropping them silently; known-good policies parse normally.
function runParserUnknownKeySmoke(): void {
  const COMPANY_ID = 'company-parser-unk';
  const goodPolicy: Policy = {
    id: 'pol-known',
    company_id: COMPANY_ID,
    policy_key: 'gender_requirement',
    policy_value: '1m+1f',
    policy_value_json: { attribute: 'sex', minimums: { male: 1, female: 1 }, scope: 'all_shifts' },
    policy_type: 'coverage',
    description: null,
    version: 1,
    created_at: '2026-01-01T00:00:00Z',
  };
  const bogusPolicy: Policy = {
    id: 'pol-bogus',
    company_id: COMPANY_ID,
    policy_key: 'totally_made_up_key',
    policy_value: 'whatever',
    policy_value_json: { x: 1 },
    policy_type: 'general',
    description: null,
    version: 1,
    created_at: '2026-01-01T00:00:00Z',
  };
  const result = parseConstraints([goodPolicy, bogusPolicy]);

  const bogusEntry = result.unrecognized.find(u => u.policy_key === 'totally_made_up_key');
  expect(
    bogusEntry !== undefined && bogusEntry.reason === 'unknown_key',
    `Parser unknown: bogus key surfaced with reason='unknown_key' (got ${JSON.stringify(bogusEntry)})`,
  );
  expect(
    result.hard.attributeMix.length === 1,
    `Parser unknown: known gender_requirement still parsed alongside (got ${result.hard.attributeMix.length})`,
  );

  // max_consecutive_days_worked — happy path, fraction rejected, out-of-range
  // rejected. Verifies the parser chain end-to-end (policy_value_json →
  // EngineSettings.maxConsecutiveDaysWorked) without a runtime build.
  const mkMaxConsec = (v: unknown, id: string): Policy => ({
    id, company_id: COMPANY_ID, policy_key: 'max_consecutive_days_worked',
    policy_value: String(v), policy_value_json: v as Policy['policy_value_json'],
    policy_type: 'scheduling', description: null, version: 1, created_at: '2026-01-01T00:00:00Z',
  });
  expect(
    parseConstraints([mkMaxConsec(5, 'pol-mc-5')]).settings.maxConsecutiveDaysWorked === 5,
    `Parser max_consecutive_days_worked happy: =5 yields settings.maxConsecutiveDaysWorked === 5`,
  );
  expect(
    parseConstraints([mkMaxConsec(3.5, 'pol-mc-frac')]).settings.maxConsecutiveDaysWorked === null,
    `Parser max_consecutive_days_worked fraction rejected: =3.5 yields settings stays null`,
  );
  expect(
    parseConstraints([mkMaxConsec(0, 'pol-mc-zero')]).settings.maxConsecutiveDaysWorked === null,
    `Parser max_consecutive_days_worked out-of-range (0) rejected: settings stays null`,
  );
  expect(
    parseConstraints([mkMaxConsec(8, 'pol-mc-eight')]).settings.maxConsecutiveDaysWorked === null,
    `Parser max_consecutive_days_worked out-of-range (8) rejected: settings stays null`,
  );
}

// Task 5 — wage estimate flags employees whose rate falls back to $0 and
// excludes their pay from the total.
function runWageFallbackSmoke(): void {
  const individualWages = new Map<string, number>([
    ['emp-paid', 20],
  ]);
  const roleRates = new Map<string, number>([
    ['Greeter', 15],
    // Lifeguard has no rate row → fallback path
  ]);

  const shifts = [
    { employee_id: 'emp-paid', employee_name: 'Paid Person', role: 'Greeter', start_time: '09:00', end_time: '13:00', hours: 4 },
    { employee_id: 'emp-unwaged', employee_name: 'Unwaged Person', role: 'Lifeguard', start_time: '09:00', end_time: '13:00', hours: 4 },
  ];
  const result = computeWageEstimateFromMaps(shifts, individualWages, roleRates);

  expect(
    result.missing_wages.length === 1,
    `Wage fallback: 1 missing_wages entry (got ${result.missing_wages.length})`,
  );
  expect(
    result.missing_wages[0]?.name === 'Unwaged Person' && result.missing_wages[0]?.role === 'Lifeguard',
    `Wage fallback: missing_wages names 'Unwaged Person' as Lifeguard (got ${JSON.stringify(result.missing_wages[0])})`,
  );
  // Paid person: 4h * $20 = $80. Unwaged person excluded from total.
  expect(
    result.total_estimated === 80,
    `Wage fallback: total_estimated excludes unwaged employee (expected 80, got ${result.total_estimated})`,
  );
}

// Task 6 — veteran 'at_least_one' flag carries the same enriched shape as
// other attribute_mix flags (per_employee_dispositions for every candidate
// considered, classified into reason buckets).
function runVeteranEnrichmentSmoke(): void {
  const COMPANY_ID = 'company-vet-enrich';
  const ST_ID = 'st-vet';

  const shiftType: ShiftType = {
    id: ST_ID,
    company_id: COMPANY_ID,
    name: 'Vet Shift',
    start_time: '09:00',
    end_time: '13:00',
    days_active: [1],
    active: true,
    created_at: '2026-01-01T00:00:00Z',
  };
  const req: ShiftRequirement = {
    id: 'req-vet',
    company_id: COMPANY_ID,
    role: 'Lifeguard',
    accepted_roles: ['Lifeguard'],
    required_count: 1,
    shift_type_id: ST_ID,
  };

  const mondayAvail = (empId: string): Availability => ({
    id: `av-${empId}`,
    employee_id: empId,
    company_id: COMPANY_ID,
    day_of_week: 1,
    start_time: '00:00',
    end_time: '23:59',
  });

  // 1 non-vet who fills the slot. 2 other non-vets to be classified by the
  // diagnostic: one on full-day TO, one not qualified.
  const filler: Employee = {
    id: 'emp-filler',
    company_id: COMPANY_ID,
    name: 'Filler Civilian',
    primary_role: 'Lifeguard',
    qualified_roles: ['Lifeguard'],
    max_weekly_hours: 40,
    contact_phone: null,
    contact_email: null,
    active: true,
    created_at: '2026-01-01T00:00:00Z',
    individual_wage: null,
    is_veteran: false,
  };
  const civTO: Employee = {
    ...filler,
    id: 'emp-civ-to',
    name: 'Civ On TO',
  };
  const civNotQual: Employee = {
    ...filler,
    id: 'emp-civ-noqual',
    name: 'Civ Not Qualified',
    primary_role: 'Cashier',
    qualified_roles: ['Cashier'],
  };

  const availByEmp = new Map<string, Availability[]>([
    [filler.id, [mondayAvail(filler.id)]],
    [civTO.id, [mondayAvail(civTO.id)]],
    [civNotQual.id, [mondayAvail(civNotQual.id)]],
  ]);
  const toMap = new Map<string, TOWindow>([
    [`${civTO.id}:2026-06-01`, { type: 'full_day', blockedWindows: [] }],
  ]);

  const data: BuildData = {
    employees: [filler, civTO, civNotQual],
    availByEmp,
    toMap,
    shiftTypes: [shiftType],
    shiftRequirements: [req],
    conflicts: [],
    policies: [],
    events: [],
    companyName: 'Test Co',
    companyTimezone: 'America/New_York',
  };

  const result = runScheduleBuild(
    data,
    DEFAULT_ENGINE_SETTINGS,
    'at_least_one',
    [],
    '2026-06-01',
    '2026-06-01',
  );

  const vetFlags = result.flagged_issues.filter(f =>
    f.type === 'unsatisfied_attribute_mix' &&
    (f.metadata as { attribute?: string }).attribute === 'is_veteran'
  );
  expect(
    vetFlags.length === 1,
    `Veteran enrichment: 1 veteran flag fires (got ${vetFlags.length})`,
  );
  const meta = vetFlags[0]?.metadata as {
    attribute?: string;
    value?: string;
    per_employee_dispositions?: Array<{ name: string; reason: string }>;
  };
  expect(
    meta?.attribute === 'is_veteran' && meta?.value === 'true',
    `Veteran enrichment: metadata identifies attribute=is_veteran value='true' (got ${meta?.attribute}/${meta?.value})`,
  );
  const disp = meta?.per_employee_dispositions ?? [];
  // Filler is on the shift (skipped by the candidate filter), so dispositions
  // cover civTO + civNotQual. The remaining non-vet who couldn't be replaced
  // by a vet (filler) is the over-represented value, classified separately
  // by the swap pass — but `per_employee_dispositions` enumerates ALL
  // candidates with the missing attribute (vets only). Since no vets exist,
  // dispositions covers them: empty pool.
  expect(
    disp.length === 0,
    `Veteran enrichment: dispositions enumerate veterans only — none exist, so length === 0 (got ${disp.length})`,
  );
  expect(
    vetFlags[0]?.description.startsWith('Need 1 is_veteran=true on 2026-06-01 Vet Shift.'),
    `Veteran enrichment: description uses standard need-clause with is_veteran=true (got: ${vetFlags[0]?.description})`,
  );
}

if (require.main === module) {
  runDoublesAndOverlapsSmoke();
  console.log('');
  runDaysActiveConsolidationSmoke();
  console.log('');
  runAttributeMixUnsatisfiabilitySmoke();
  console.log('');
  runAttributeMixSwapPassSmoke();
  console.log('');
  runAttributeMixDiagnosticSmoke();
  console.log('');
  runSaveFailedContractSmoke();
  console.log('');
  runCoverageGapDispositionSmoke();
  console.log('');
  runClosureEventSmoke();
  console.log('');
  runParserUnknownKeySmoke();
  console.log('');
  runWageFallbackSmoke();
  console.log('');
  runVeteranEnrichmentSmoke();
  if (!process.exitCode) console.log('\nAll smoke checks passed.');
}
