import type { Availability, Employee, EmployeeConflict } from '../../db/types';
import type { TOWindow } from '../to-window';
import type { ScheduleAssignment } from '../../workflows/schedule-build';
import type { AttributeMixConstraint, EngineSettings } from '../constraints/types';
import { buildEligibility, sameDayDoubleReason, type VeteranOnlyRange } from './eligibility';
import type { CanvasSlot, FlaggedIssue, WeekState } from './types';

interface ShiftContext {
  date: string;
  shift_type_id: string;
  shift_name: string;
}

interface AttrMixDeps {
  employees: Employee[];
  employeeById: Map<string, Employee>;
  availByEmp: Map<string, Availability[]>;
  toMap: Map<string, TOWindow>;
  conflicts: EmployeeConflict[];
  veteranOnlyDates: VeteranOnlyRange[];
  canvasSlots: CanvasSlot[];
  settings: EngineSettings;
}

export interface SwapOperation {
  assignment_index: number;
  new_employee_id: string;
  new_employee_name: string;
}

export interface AttrMixResult {
  satisfied: boolean;
  swaps: SwapOperation[];
  flagged: FlaggedIssue | null;
}

// Read a typed attribute value from an Employee. Booleans are stringified
// to match the minimums map keys ('true' / 'false'). Strings and numbers
// are stringified as-is. Null/undefined → 'unknown'.
function readAttr(emp: Employee, attribute: string): string {
  const rec = emp as unknown as Record<string, unknown>;
  const v = rec[attribute];
  if (v === null || v === undefined) return 'unknown';
  return String(v);
}

function constraintAppliesToShift(c: AttributeMixConstraint, shift: ShiftContext, slotReqId?: string): boolean {
  if (c.scope === 'all_shifts') return true;
  if (c.scope === 'shift_type') return c.scope_target === shift.shift_name;
  if (c.scope === 'specific_shift') return c.scope_target === slotReqId;
  return false;
}

function countByAttr(
  assignments: ScheduleAssignment[],
  employeeById: Map<string, Employee>,
  attribute: string
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of assignments) {
    const emp = employeeById.get(a.employee_id);
    if (!emp) continue;
    const v = readAttr(emp, attribute);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}

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

// Tries to satisfy each attribute_mix constraint applicable to this shift by
// swapping out a single over-represented assignment for an under-represented
// candidate. Returns the swaps applied and any flagged issues for unsatisfiable
// constraints.
export function enforceAttributeMixForShift(
  shiftAssignments: ScheduleAssignment[],
  shiftAssignmentIndices: number[],
  constraints: AttributeMixConstraint[],
  shift: ShiftContext,
  slotReqId: string | undefined,
  weekState: WeekState,
  deps: AttrMixDeps
): AttrMixResult {
  const applicable = constraints.filter(c => constraintAppliesToShift(c, shift, slotReqId));
  if (applicable.length === 0 || shiftAssignments.length === 0) {
    return { satisfied: true, swaps: [], flagged: null };
  }

  // Total fillable positions for this shift on this date. A rule whose
  // minimums sum exceeds this is mathematically unsatisfiable and would
  // otherwise generate phantom flags on every run (e.g. a 1m+1f rule on a
  // single-position Greeter shift).
  const totalPositions = deps.canvasSlots.filter(
    s => s.date === shift.date && s.shift_name === shift.shift_name
  ).length;

  const swaps: SwapOperation[] = [];
  let flagged: FlaggedIssue | null = null;

  for (const c of applicable) {
    const requiredSum = Object.values(c.minimums).reduce((a, b) => a + b, 0);
    if (requiredSum > totalPositions) {
      console.log(
        `[attribute-mix] skipped ${c.attribute} rule on ${shift.date} ${shift.shift_name}: ` +
        `${requiredSum} positions required, only ${totalPositions} available`
      );
      continue;
    }
    let counts = countByAttr(shiftAssignments, deps.employeeById, c.attribute);
    const unsatisfied: string[] = [];
    for (const [value, need] of Object.entries(c.minimums)) {
      const have = counts.get(value) ?? 0;
      if (have < need) unsatisfied.push(value);
    }
    if (unsatisfied.length === 0) continue;

    for (const wantValue of unsatisfied) {
      const need = c.minimums[wantValue] - (counts.get(wantValue) ?? 0);
      let placed = 0;
      for (let pass = 0; pass < need; pass++) {
        const over = Object.entries(c.minimums)
          .filter(([v, n]) => (counts.get(v) ?? 0) > n)
          .map(([v]) => v);

        const removableIdx = shiftAssignments.findIndex(a => {
          const emp = deps.employeeById.get(a.employee_id);
          if (!emp) return false;
          const v = readAttr(emp, c.attribute);
          return over.includes(v);
        });
        if (removableIdx < 0) break;

        const removable = shiftAssignments[removableIdx];
        const removableSlot = deps.canvasSlots.find(
          s => s.date === removable.date && s.shift_name === removable.shift_name && s.role === removable.role
        );
        if (!removableSlot) break;

        const eligible = buildEligibility(removableSlot, deps.employees, deps.availByEmp, deps.toMap, deps.veteranOnlyDates);
        const cohabIds = shiftAssignments
          .filter((_, i) => i !== removableIdx)
          .map(a => a.employee_id);

        // Same-day-doubles check needs to see weekState as if the row we're
        // about to overwrite were already gone — otherwise the displaced
        // employee's existing assignment would look like a candidate's
        // existing same-day commitment, and any candidate matching the row's
        // own employee_id would self-reject. Filter the to-be-replaced row
        // out of the view.
        const assignIdxForView = shiftAssignmentIndices[removableIdx];
        const viewState: WeekState = {
          ...weekState,
          assignments: weekState.assignments.filter((_, i) => i !== assignIdxForView),
        };

        const replacement = eligible.employees.find(e => {
          if (readAttr(e, c.attribute) !== wantValue) return false;
          if (cohabIds.includes(e.id)) return false;
          if (hardConflict(e.id, cohabIds, deps.conflicts)) return false;
          const cur = weekState.weeklyHoursMap.get(e.id) ?? 0;
          if (cur + removableSlot.hours > e.max_weekly_hours) return false;
          if (sameDayDoubleReason(e.id, removableSlot, viewState, deps.settings) !== null) return false;
          return true;
        });

        if (!replacement) break;

        const assignIdx = shiftAssignmentIndices[removableIdx];
        swaps.push({
          assignment_index: assignIdx,
          new_employee_id: replacement.id,
          new_employee_name: replacement.name,
        });

        const prev = weekState.assignments[assignIdx];
        weekState.weeklyHoursMap.set(removable.employee_id, (weekState.weeklyHoursMap.get(removable.employee_id) ?? 0) - removableSlot.hours);
        weekState.weeklyHoursMap.set(replacement.id, (weekState.weeklyHoursMap.get(replacement.id) ?? 0) + removableSlot.hours);
        weekState.assignments[assignIdx] = {
          ...prev,
          employee_id: replacement.id,
          employee_name: replacement.name,
        };
        shiftAssignments[removableIdx] = weekState.assignments[assignIdx];

        counts = countByAttr(shiftAssignments, deps.employeeById, c.attribute);
        placed++;
      }

      if (placed < need) {
        flagged = {
          type: 'unsatisfied_attribute_mix',
          date: shift.date,
          shift_name: shift.shift_name,
          description: `Attribute mix unsatisfied on ${shift.date} ${shift.shift_name}: need ${c.minimums[wantValue]} of ${c.attribute}=${wantValue}`,
          metadata: {
            attribute: c.attribute,
            value: wantValue,
            required: c.minimums[wantValue],
            actual: counts.get(wantValue) ?? 0,
          },
        };
      }
    }
  }

  return {
    satisfied: flagged === null,
    swaps,
    flagged,
  };
}
