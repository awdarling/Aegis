import type { Availability, Employee, EmployeeConflict } from '../../db/types';
import type { EngineSettings } from '../constraints/types';
import type { TOWindow } from '../to-window';
import { isAvailableForShift, isBlockedByTOForSlot, sameDayDoubleReason } from './eligibility';
import type { CanvasSlot, WeekState } from './types';

// Shared per-candidate disposition vocabulary. Attribute-mix shortage
// diagnostics and coverage-gap diagnostics both classify employees against
// these codes so the manager-facing language stays uniform across flag types.
export type DispositionReasonCode =
  | 'not_qualified'
  | 'on_time_off'
  | 'max_hours_reached'
  | 'max_consecutive_days_reached'
  | 'in_conflict'
  | 'availability_mismatch'
  | 'doubles_blocked'
  | 'eligible_but_unchosen';

export interface EmployeeDisposition {
  employee_id: string;
  name: string;
  reason: DispositionReasonCode;
}

export interface DispositionContext {
  // Any one canvas slot from the target (date, shift_name) group. The slot
  // supplies start/end/hours/shift_type_id — all slots in the group share
  // these because they come from the same shift_type.
  slot: CanvasSlot;
  // All roles the shift accepts on this date. Built from the distinct
  // `role` values across every canvas slot in the (date, shift_name) group.
  acceptedRoles: Set<string>;
  // Employees already placed on this shift on this date — used both as a
  // skip-list when classifying candidates and as the cohabitants for
  // conflict checks.
  assignedIds: Set<string>;
  weekState: WeekState;
  deps: {
    employees: Employee[];
    availByEmp: Map<string, Availability[]>;
    toMap: Map<string, TOWindow>;
    conflicts: EmployeeConflict[];
    settings: EngineSettings;
  };
}

export const REASON_LABELS: Record<DispositionReasonCode, string> = {
  on_time_off: 'on approved time off',
  max_hours_reached: 'at max weekly hours',
  doubles_blocked: 'already working another shift today (doubles not allowed)',
  in_conflict: 'in hard conflict with assigned staff',
  availability_mismatch: 'unavailable per regular availability',
  not_qualified: 'not qualified for the role',
  eligible_but_unchosen: 'eligible but not chosen by ranker',
};

// Order controls the grouped sentence in formatDispositionList. Listed
// first → mentioned first. Bucketed roughly by "managers can act fastest"
// (TO and hours first; structural reasons last).
export const REASON_ORDER: DispositionReasonCode[] = [
  'on_time_off',
  'max_hours_reached',
  'doubles_blocked',
  'in_conflict',
  'availability_mismatch',
  'not_qualified',
  'eligible_but_unchosen',
];

function hardConflict(empId: string, cohabIds: string[], conflicts: EmployeeConflict[]): boolean {
  for (const other of cohabIds) {
    for (const c of conflicts) {
      if (c.severity !== 'never') continue;
      if (
        (c.employee_id_1 === empId && c.employee_id_2 === other) ||
        (c.employee_id_2 === empId && c.employee_id_1 === other)
      ) {
        return true;
      }
    }
  }
  return false;
}

// Classifies a single employee against a shift slot. The first matching
// condition wins, so e.g. an unqualified employee on TO surfaces as
// 'not_qualified' (the more actionable signal for the manager).
//
// The order here is load-bearing — coverage-gap and attribute-mix reasons
// must agree on which bucket "wins" for a given candidate. Do not reorder
// without updating both callers' tests.
export function classifyEmployeeForSlot(emp: Employee, ctx: DispositionContext): DispositionReasonCode {
  const cohabIds = Array.from(ctx.assignedIds);
  const qualifies = emp.qualified_roles.some(r => ctx.acceptedRoles.has(r));
  if (!qualifies) return 'not_qualified';
  if (isBlockedByTOForSlot(emp, ctx.slot, ctx.deps.toMap)) return 'on_time_off';
  if ((ctx.weekState.weeklyHoursMap.get(emp.id) ?? 0) + ctx.slot.hours > emp.max_weekly_hours) {
    return 'max_hours_reached';
  }
  if (sameDayDoubleReason(emp.id, ctx.slot, ctx.weekState, ctx.deps.settings) !== null) {
    return 'doubles_blocked';
  }
  if (hardConflict(emp.id, cohabIds, ctx.deps.conflicts)) return 'in_conflict';
  if (!isAvailableForShift(emp, ctx.slot, ctx.deps.availByEmp)) return 'availability_mismatch';
  return 'eligible_but_unchosen';
}

// Builds the grouped human-readable phrase from a list of dispositions,
// e.g. "3 on approved time off (Anna, Beth, Carol); 1 at max weekly hours
// (Dana)". Returns empty string when the list is empty so callers can
// branch on length explicitly.
export function formatDispositionList(dispositions: EmployeeDisposition[]): string {
  if (dispositions.length === 0) return '';
  const groups = new Map<DispositionReasonCode, string[]>();
  for (const d of dispositions) {
    if (!groups.has(d.reason)) groups.set(d.reason, []);
    groups.get(d.reason)!.push(d.name);
  }
  const parts: string[] = [];
  for (const r of REASON_ORDER) {
    const names = groups.get(r);
    if (!names || names.length === 0) continue;
    parts.push(`${names.length} ${REASON_LABELS[r]} (${names.join(', ')})`);
  }
  return parts.join('; ');
}
