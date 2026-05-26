// Compile-time smoke test. Confirms the engine module surface matches what
// the build workflow expects to import. No runtime execution — this file is
// not run; it just has to compile.

import { getWeekBounds } from '../week-bounds';
import { buildCanvas } from '../canvas';
import {
  buildEligibility,
  isAvailableForShift,
  isBlockedByTOForSlot,
  isQualifiedForRole,
  isVeteranOnlyDate,
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
