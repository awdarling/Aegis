import type { Availability, Employee } from '../../db/types';
import { isBlockedByTO, type TOWindow } from '../to-window';
import type { CanvasSlot, CandidatePool } from './types';

export interface VeteranOnlyRange {
  start_date: string;
  end_date: string;
}

export function isQualifiedForRole(emp: Employee, role: string): boolean {
  return emp.qualified_roles.includes(role);
}

// Slot's time window must be fully contained inside one of the employee's
// availability rows for the matching day-of-week.
export function isAvailableForShift(
  emp: Employee,
  slot: CanvasSlot,
  availByEmp: Map<string, Availability[]>
): boolean {
  const dow = new Date(`${slot.date}T12:00:00Z`).getUTCDay();
  const ns = slot.start_time.slice(0, 5);
  const ne = slot.end_time.slice(0, 5);
  const rows = availByEmp.get(emp.id) ?? [];
  return rows.some(
    a => a.day_of_week === dow && a.start_time.slice(0, 5) <= ns && a.end_time.slice(0, 5) >= ne
  );
}

export function isBlockedByTOForSlot(
  emp: Employee,
  slot: CanvasSlot,
  toMap: Map<string, TOWindow>
): boolean {
  return isBlockedByTO(emp.id, slot.date, slot.start_time, slot.end_time, slot.shift_type_id, toMap);
}

export function isVeteranOnlyDate(date: string, ranges: VeteranOnlyRange[]): boolean {
  return ranges.some(r => date >= r.start_date && date <= r.end_date);
}

// Applies all date-level hard filters and returns the eligible pool plus a
// map of removal reasons keyed by employee_id. Slot-level filters (already
// assigned today, hours cap, conflicts with co-assigned staff) are applied by
// the caller — they depend on weekState which this module does not see.
export function buildEligibility(
  slot: CanvasSlot,
  employees: Employee[],
  availByEmp: Map<string, Availability[]>,
  toMap: Map<string, TOWindow>,
  veteranOnlyDates: VeteranOnlyRange[]
): CandidatePool {
  const removed = new Map<string, string>();
  const veteranOnly = isVeteranOnlyDate(slot.date, veteranOnlyDates);

  const out: Employee[] = [];
  for (const e of employees) {
    if (!e.active) {
      removed.set(e.id, 'inactive');
      continue;
    }
    if (veteranOnly && !e.is_veteran) {
      removed.set(e.id, 'veteran-only date');
      continue;
    }
    if (!isQualifiedForRole(e, slot.role)) {
      removed.set(e.id, `not qualified for ${slot.role}`);
      continue;
    }
    if (!isAvailableForShift(e, slot, availByEmp)) {
      removed.set(e.id, 'unavailable on this day/time');
      continue;
    }
    if (isBlockedByTOForSlot(e, slot, toMap)) {
      removed.set(e.id, 'approved time off');
      continue;
    }
    out.push(e);
  }

  return { employees: out, removed_reasons: removed };
}
