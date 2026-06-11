import type { Availability, Employee, EmployeeConflict } from '../../db/types';
import type { TOWindow } from '../to-window';
import type { ScheduleAssignment } from '../../workflows/schedule-build';
import type { AttributeMixConstraint, EngineSettings } from '../constraints/types';
import {
  buildEligibility,
  consecutiveDaysRunIncluding,
  sameDayDoubleReason,
  type VeteranOnlyRange,
} from './eligibility';
import {
  classifyEmployeeForSlot,
  formatDispositionList,
  type EmployeeDisposition,
} from './dispositions';
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

export interface AttributeShortageReason {
  description: string;
  per_employee: EmployeeDisposition[];
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

// Produces a manager-readable explanation of why no employee with the missing
// attribute value could be placed. Classifies every candidate carrying that
// attribute value (excluding those already on this shift) into a single
// reason bucket, then groups by reason for the description.
//
// The classification order matters: the first matching condition wins, so
// e.g. an unqualified employee with TO is reported as 'not_qualified'.
export function buildAttributeShortageReason(args: {
  shift: ShiftContext;
  missingAttribute: string;
  missingValue: string;
  needed: number;
  weekState: WeekState;
  deps: AttrMixDeps;
}): AttributeShortageReason {
  const { shift, missingAttribute, missingValue, needed, weekState, deps } = args;

  // All slots for this (date, shift_name). Roles across slots define the set
  // of accepted roles; any slot supplies time/hours since the shift_type
  // dictates a single time window for the group.
  const shiftSlots = deps.canvasSlots.filter(
    s => s.date === shift.date && s.shift_name === shift.shift_name
  );
  const acceptedRoles = new Set(shiftSlots.map(s => s.role));
  const exemplar = shiftSlots[0];

  const assignedIds = new Set(
    weekState.assignments
      .filter(a => a.date === shift.date && a.shift_name === shift.shift_name)
      .map(a => a.employee_id)
  );

  const candidates = deps.employees.filter(
    e => readAttr(e, missingAttribute) === missingValue && !assignedIds.has(e.id)
  );

  const head = `Need ${needed} ${missingAttribute}=${missingValue} on ${shift.date} ${shift.shift_name}.`;

  if (!exemplar) {
    return { description: `${head} No slot found for this shift.`, per_employee: [] };
  }

  const dispositions: EmployeeDisposition[] = candidates.map(emp => ({
    employee_id: emp.id,
    name: emp.name,
    reason: classifyEmployeeForSlot(emp, {
      slot: exemplar,
      acceptedRoles,
      assignedIds,
      weekState,
      deps: {
        employees: deps.employees,
        availByEmp: deps.availByEmp,
        toMap: deps.toMap,
        conflicts: deps.conflicts,
        settings: deps.settings,
      },
    }),
  }));

  if (dispositions.length === 0) {
    return {
      description: `${head} No employees with ${missingAttribute}=${missingValue} exist in the company.`,
      per_employee: [],
    };
  }

  const total = dispositions.length;
  const summary = `${total} employee${total === 1 ? '' : 's'} with ${missingAttribute}=${missingValue} exist: ${formatDispositionList(dispositions)}.`;
  return {
    description: `${head} ${summary}`,
    per_employee: dispositions,
  };
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

        // All removable assignees on this shift whose attribute is in `over`.
        // Iterating across the full set (rather than just the first match)
        // lets the swap succeed when the candidate composes with SOME role
        // on the shift even if it doesn't compose with the first removable's
        // role. Example: candidate is LG-only, first removable is HG, but a
        // later removable is also LG — that pair composes.
        const removableIndices = shiftAssignments
          .map((a, i) => {
            const emp = deps.employeeById.get(a.employee_id);
            if (!emp) return -1;
            const v = readAttr(emp, c.attribute);
            return over.includes(v) ? i : -1;
          })
          .filter(i => i >= 0);
        if (removableIndices.length === 0) break;

        let swapped = false;
        for (const removableIdx of removableIndices) {
          const removable = shiftAssignments[removableIdx];
          const removableSlot = deps.canvasSlots.find(
            s => s.date === removable.date && s.shift_name === removable.shift_name && s.role === removable.role
          );
          if (!removableSlot) continue;

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
            // Consecutive-days cap. Use viewState (displaced row hidden) so a
            // candidate already on this date in another row isn't blocked by
            // their own about-to-be-vacated assignment when the swap happens
            // in-place. Mirrors the slot-eligible filter in schedule-build.
            if (
              deps.settings.maxConsecutiveDaysWorked != null &&
              consecutiveDaysRunIncluding(e.id, removableSlot.date, viewState)
                > deps.settings.maxConsecutiveDaysWorked
            ) {
              return false;
            }
            if (sameDayDoubleReason(e.id, removableSlot, viewState, deps.settings) !== null) return false;
            return true;
          });

          if (!replacement) continue;

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
          swapped = true;
          break;
        }

        if (!swapped) break;
      }

      if (placed < need) {
        const reason = buildAttributeShortageReason({
          shift,
          missingAttribute: c.attribute,
          missingValue: wantValue,
          needed: c.minimums[wantValue],
          weekState,
          deps,
        });
        flagged = {
          type: 'unsatisfied_attribute_mix',
          date: shift.date,
          shift_name: shift.shift_name,
          description: reason.description,
          metadata: {
            attribute: c.attribute,
            value: wantValue,
            required: c.minimums[wantValue],
            actual: counts.get(wantValue) ?? 0,
            per_employee_dispositions: reason.per_employee,
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
