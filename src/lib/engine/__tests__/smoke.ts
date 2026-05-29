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
import type { ScheduleAssignment, VeteranMode } from '../../../workflows/schedule-build';

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

if (require.main === module) {
  runDoublesAndOverlapsSmoke();
  if (!process.exitCode) console.log('\nAll doubles/overlap smoke checks passed.');
}
