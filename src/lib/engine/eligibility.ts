import type { Availability, Employee } from '../../db/types';
import type { EngineSettings } from '../constraints/types';
import { isBlockedByTO, type TOWindow } from '../to-window';
import type { CanvasSlot, CandidatePool, WeekState } from './types';

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

// Pure time-window overlap. Inputs may be HH:MM or HH:MM:SS; both are sliced
// to HH:MM, which compares lexicographically because the format is
// zero-padded. Touching intervals (a.end === b.start) do NOT overlap.
export function shiftsOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  const a1 = aStart.slice(0, 5);
  const a2 = aEnd.slice(0, 5);
  const b1 = bStart.slice(0, 5);
  const b2 = bEnd.slice(0, 5);
  return a1 < b2 && b1 < a2;
}

// Same-day-shift block reason for an employee considering `slot`, given the
// assignments already made this week. Hard physical overlap is rejected
// regardless of policy. Non-overlapping doubles are governed by
// settings.doublesPolicy. Returns null when accepted.
//
// Reasons returned here are surfaced through computeGapReason so the manager
// sees the actual binding constraint, not a generic "no candidate" string.
export function sameDayDoubleReason(
  empId: string,
  slot: CanvasSlot,
  weekState: WeekState,
  settings: EngineSettings,
): string | null {
  const sameDay = weekState.assignments.filter(
    a => a.employee_id === empId && a.date === slot.date,
  );
  if (sameDay.length === 0) return null;

  for (const a of sameDay) {
    if (shiftsOverlap(a.start_time, a.end_time, slot.start_time, slot.end_time)) {
      return 'already scheduled for an overlapping shift this day';
    }
  }

  // Non-overlapping same-day assignment exists; policy decides.
  if (settings.doublesPolicy === 'never') {
    return 'doubles not allowed by company policy';
  }
  // Standard build has no emergency context; treat emergency_only as 'never'
  // for now. When emergency-mode coverage is wired in, this branch will
  // consult the emergency flag from the request.
  if (settings.doublesPolicy === 'emergency_only') {
    return 'doubles not allowed by company policy';
  }
  // 'allow' — overlap was already screened above.
  return null;
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
