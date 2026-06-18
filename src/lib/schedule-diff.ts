// Pure schedule-diff helpers — the core of the republish "changed-only" notify
// rule (DEV_ROADMAP item 12). Kept in its own module with NO db/network/env
// deps (the same pattern as distribute-guard.ts) so it can be unit-tested in
// isolation without importing the schedule-build module (which pulls in the DB
// client and validates env at import time).

// Minimal structural shape these helpers need from a schedule assignment.
// schedule-build.ts's ScheduleAssignment is a structural superset.
export interface ShiftLike {
  employee_id: string;
  date: string;
  shift_name: string;
  role: string;
  start_time: string;
  end_time: string;
  hours: number;
}

// Stable signature of one employee's week — the set of their assigned shifts,
// order-independent. Two schedules are "the same" for an employee iff their
// signatures match. Any add / drop / time or role change flips it.
export function employeeShiftSignature(assignments: ShiftLike[]): string {
  return assignments
    .map(s => `${s.date}|${s.shift_name}|${s.role}|${s.start_time}|${s.end_time}|${s.hours}`)
    .sort()
    .join('~~');
}

// Pure diff: which employees' shifts actually CHANGED between an old and a new
// schedule's assignment lists. Returns the set of affected employee_ids (those
// added, dropped, or whose shifts moved). This drives the changed-only notify.
export function computeChangedEmployeeIds(
  oldAssignments: ShiftLike[],
  newAssignments: ShiftLike[],
): Set<string> {
  const byEmp = (rows: ShiftLike[]) => {
    const m = new Map<string, ShiftLike[]>();
    for (const a of rows) {
      const list = m.get(a.employee_id) ?? [];
      list.push(a);
      m.set(a.employee_id, list);
    }
    return m;
  };
  const oldByEmp = byEmp(oldAssignments);
  const newByEmp = byEmp(newAssignments);
  const allIds = new Set<string>([...oldByEmp.keys(), ...newByEmp.keys()]);
  const changed = new Set<string>();
  for (const id of allIds) {
    const sigOld = employeeShiftSignature(oldByEmp.get(id) ?? []);
    const sigNew = employeeShiftSignature(newByEmp.get(id) ?? []);
    if (sigOld !== sigNew) changed.add(id);
  }
  return changed;
}
