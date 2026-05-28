/**
 * Unit test for resolveBannedPairConflict.
 *
 * Synthetic in-memory fixtures. No database, no env, no network.
 *
 * Run: TS_NODE_COMPILER_OPTIONS='{"module":"commonjs"}' npx ts-node --skip-project scripts/test-cascade.ts
 */

import { resolveBannedPairConflict, type SwapOperation } from '../src/lib/engine/cascade';
import type { Employee, Availability, EmployeeConflict } from '../src/db/types';
import type { TOWindow } from '../src/lib/to-window';
import type { ScheduleAssignment } from '../src/workflows/schedule-build';
import type { CanvasSlot, WeekState } from '../src/lib/engine/types';
import type { VeteranOnlyRange } from '../src/lib/engine/eligibility';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeEmployee(opts: {
  id: string;
  name: string;
  qualified_roles: string[];
  max_weekly_hours?: number;
  is_veteran?: boolean;
}): Employee {
  return {
    id: opts.id,
    company_id: 'co-1',
    name: opts.name,
    primary_role: opts.qualified_roles[0] ?? 'server',
    qualified_roles: opts.qualified_roles,
    max_weekly_hours: opts.max_weekly_hours ?? 40,
    contact_phone: null,
    contact_email: null,
    active: true,
    created_at: '2025-01-01T00:00:00Z',
    individual_wage: null,
    is_veteran: opts.is_veteran ?? false,
  };
}

function makeAvail(empId: string, day_of_week: number, start: string, end: string): Availability {
  return {
    id: `av-${empId}-${day_of_week}-${start}`,
    employee_id: empId,
    company_id: 'co-1',
    day_of_week,
    start_time: start,
    end_time: end,
  };
}

function makeSlot(opts: {
  date: string;
  shift_name: string;
  role: string;
  start_time: string;
  end_time: string;
  hours: number;
  slot_index?: number;
  shift_type_id?: string;
  shift_requirement_id?: string;
}): CanvasSlot {
  return {
    date: opts.date,
    shift_type_id: opts.shift_type_id ?? `st-${opts.shift_name}`,
    shift_name: opts.shift_name,
    shift_requirement_id: opts.shift_requirement_id ?? `sr-${opts.shift_name}-${opts.role}`,
    role: opts.role,
    start_time: opts.start_time,
    end_time: opts.end_time,
    hours: opts.hours,
    required_count: 1,
    slot_index: opts.slot_index ?? 0,
    is_priority: false,
  };
}

function makeAssignment(emp: Employee, slot: CanvasSlot): ScheduleAssignment {
  return {
    date: slot.date,
    employee_id: emp.id,
    employee_name: emp.name,
    shift_name: slot.shift_name,
    role: slot.role,
    start_time: slot.start_time,
    end_time: slot.end_time,
    hours: slot.hours,
  };
}

function makeConflict(e1: string, e2: string, severity: 'never' | 'avoid' = 'never'): EmployeeConflict {
  return {
    id: `conf-${e1}-${e2}`,
    company_id: 'co-1',
    employee_id_1: e1,
    employee_id_2: e2,
    reason: null,
    severity,
    created_at: '2025-01-01T00:00:00Z',
  };
}

// ─── applyAndValidate ─────────────────────────────────────────────────────────
// Mirrors the production caller in schedule-build.ts:444-492 — applies each move
// in order, then appends a new assignment for proposedEmp at targetSlot. Returns
// invariant violations, if any.

interface ValidationResult {
  ok: boolean;
  failedInvariant?: string;
  details?: string;
}

function applyAndValidate(
  op: SwapOperation,
  proposedEmp: Employee,
  targetSlot: CanvasSlot,
  weekState: WeekState,
  conflicts: EmployeeConflict[],
  canvasSlots: CanvasSlot[],
  employeeById: Map<string, Employee>
): ValidationResult {
  const ws: WeekState = {
    weeklyHoursMap: new Map(weekState.weeklyHoursMap),
    assignmentsByDate: new Map(Array.from(weekState.assignmentsByDate, ([k, v]) => [k, [...v]])),
    assignments: weekState.assignments.map(a => ({ ...a })),
    gaps: [...weekState.gaps],
    flagged_issues: [...weekState.flagged_issues],
  };

  // Pre-state slot-shape counts for invariant (d).
  const slotKey = (a: ScheduleAssignment) =>
    `${a.date}|${a.shift_name}|${a.role}|${a.start_time}|${a.end_time}`;
  const preCounts = new Map<string, number>();
  for (const a of ws.assignments) preCounts.set(slotKey(a), (preCounts.get(slotKey(a)) ?? 0) + 1);

  // Apply each move (production order, production logic).
  for (const m of op.moves) {
    const prev = ws.assignments[m.assignment_index];
    const prevSlot = canvasSlots.find(
      s => s.date === prev.date && s.shift_name === prev.shift_name && s.role === prev.role
    );
    if (!prevSlot) continue;
    const movedInEmp = employeeById.get(m.new_employee_id);
    if (!movedInEmp) continue;
    ws.weeklyHoursMap.set(prev.employee_id, (ws.weeklyHoursMap.get(prev.employee_id) ?? 0) - prevSlot.hours);
    ws.weeklyHoursMap.set(movedInEmp.id, (ws.weeklyHoursMap.get(movedInEmp.id) ?? 0) + prevSlot.hours);
    const dayIds = ws.assignmentsByDate.get(prev.date) ?? [];
    ws.assignmentsByDate.set(
      prev.date,
      dayIds.filter(id => id !== prev.employee_id).concat(movedInEmp.id)
    );
    ws.assignments[m.assignment_index] = {
      ...prev,
      employee_id: movedInEmp.id,
      employee_name: movedInEmp.name,
    };
  }

  // Append proposedEmp at targetSlot.
  ws.weeklyHoursMap.set(proposedEmp.id, (ws.weeklyHoursMap.get(proposedEmp.id) ?? 0) + targetSlot.hours);
  const targetDayIds = ws.assignmentsByDate.get(targetSlot.date) ?? [];
  targetDayIds.push(proposedEmp.id);
  ws.assignmentsByDate.set(targetSlot.date, targetDayIds);
  ws.assignments.push(makeAssignment(proposedEmp, targetSlot));

  // Invariant (a): no banned pair (severity 'never') co-assigned on same (date, shift_name).
  for (let i = 0; i < ws.assignments.length; i++) {
    for (let j = i + 1; j < ws.assignments.length; j++) {
      const ai = ws.assignments[i];
      const aj = ws.assignments[j];
      if (ai.date !== aj.date || ai.shift_name !== aj.shift_name) continue;
      for (const c of conflicts) {
        if (c.severity !== 'never') continue;
        const pairMatch =
          (c.employee_id_1 === ai.employee_id && c.employee_id_2 === aj.employee_id) ||
          (c.employee_id_2 === ai.employee_id && c.employee_id_1 === aj.employee_id);
        if (pairMatch) {
          return {
            ok: false,
            failedInvariant: '(a) banned pair co-assigned',
            details: `${ai.employee_name} & ${aj.employee_name} both on ${ai.date} ${ai.shift_name}`,
          };
        }
      }
    }
  }

  // Invariant (b): no employee assigned twice on same date.
  const perDate = new Map<string, Map<string, number>>();
  for (const a of ws.assignments) {
    if (!perDate.has(a.date)) perDate.set(a.date, new Map());
    const m = perDate.get(a.date)!;
    m.set(a.employee_id, (m.get(a.employee_id) ?? 0) + 1);
  }
  for (const [date, m] of perDate) {
    for (const [empId, count] of m) {
      if (count > 1) {
        const emp = employeeById.get(empId);
        return {
          ok: false,
          failedInvariant: '(b) no-doubles',
          details: `${emp?.name ?? empId} has ${count} assignments on ${date}`,
        };
      }
    }
  }

  // Invariant (c): no employee exceeds max_weekly_hours.
  const hoursByEmp = new Map<string, number>();
  for (const a of ws.assignments) {
    hoursByEmp.set(a.employee_id, (hoursByEmp.get(a.employee_id) ?? 0) + a.hours);
  }
  for (const [empId, hours] of hoursByEmp) {
    const emp = employeeById.get(empId);
    if (!emp) continue;
    if (hours > emp.max_weekly_hours) {
      return {
        ok: false,
        failedInvariant: '(c) max_weekly_hours exceeded',
        details: `${emp.name}: ${hours}h > ${emp.max_weekly_hours}h max`,
      };
    }
  }

  // Invariant (d): coverage preserved — every pre-filled slot shape still has at least that many.
  const postCounts = new Map<string, number>();
  for (const a of ws.assignments) postCounts.set(slotKey(a), (postCounts.get(slotKey(a)) ?? 0) + 1);
  for (const [key, pre] of preCounts) {
    const post = postCounts.get(key) ?? 0;
    if (post < pre) {
      return {
        ok: false,
        failedInvariant: '(d) coverage dropped',
        details: `slot ${key}: pre=${pre}, post=${post}`,
      };
    }
  }

  return { ok: true };
}

// ─── Scenario runner ──────────────────────────────────────────────────────────

interface ScenarioResult {
  name: string;
  passed: boolean;
  resolverKind: 'swap' | 'cascade' | null;
  expectedKind: 'swap' | 'cascade' | 'null';
  failedInvariant?: string;
  details?: string;
  finalAssignments?: string;
}

function fmtAssignments(ws: WeekState): string {
  return ws.assignments
    .map(a => `${a.date} ${a.shift_name}/${a.role} ← ${a.employee_name}`)
    .join('; ');
}

// ─── SCENARIO 1: Direct swap resolvable ───────────────────────────────────────
// Inter-day swap: partner P at Mon Lunch slot A, Q at Tue Lunch slot C.
// Direct swap: P moves to slot C, Q moves to slot A, X takes slot B (Mon Lunch).

function runScenario1(): ScenarioResult {
  const name = 'Scenario 1 — direct swap resolvable';

  const P = makeEmployee({ id: 'P', name: 'P-partner', qualified_roles: ['server'] });
  const X = makeEmployee({ id: 'X', name: 'X-proposed', qualified_roles: ['server'] });
  const Q = makeEmployee({ id: 'Q', name: 'Q-swap', qualified_roles: ['server'] });
  const employees = [P, X, Q];
  const employeeById = new Map(employees.map(e => [e.id, e]));

  // All available Mon (dow=1) and Tue (dow=2), 08:00–23:00.
  const availByEmp = new Map<string, Availability[]>([
    ['P', [makeAvail('P', 1, '08:00', '23:00'), makeAvail('P', 2, '08:00', '23:00')]],
    ['X', [makeAvail('X', 1, '08:00', '23:00'), makeAvail('X', 2, '08:00', '23:00')]],
    ['Q', [makeAvail('Q', 1, '08:00', '23:00'), makeAvail('Q', 2, '08:00', '23:00')]],
  ]);

  const slotA = makeSlot({ date: '2025-12-01', shift_name: 'Lunch', role: 'server', start_time: '11:00:00', end_time: '15:00:00', hours: 4, slot_index: 0 });
  const slotB = makeSlot({ date: '2025-12-01', shift_name: 'Lunch', role: 'server', start_time: '11:00:00', end_time: '15:00:00', hours: 4, slot_index: 1 });
  const slotC = makeSlot({ date: '2025-12-02', shift_name: 'Lunch', role: 'server', start_time: '11:00:00', end_time: '15:00:00', hours: 4, slot_index: 0 });
  const canvasSlots = [slotA, slotB, slotC];

  const conflicts = [makeConflict('P', 'X')];

  const weekState: WeekState = {
    weeklyHoursMap: new Map([['P', 4], ['Q', 4]]),
    assignmentsByDate: new Map([
      ['2025-12-01', ['P']],
      ['2025-12-02', ['Q']],
    ]),
    assignments: [makeAssignment(P, slotA), makeAssignment(Q, slotC)],
    gaps: [],
    flagged_issues: [],
  };

  const op = resolveBannedPairConflict(slotB, X, 0, weekState, {
    employees,
    employeeById,
    availByEmp,
    toMap: new Map<string, TOWindow>(),
    conflicts,
    veteranOnlyDates: [] as VeteranOnlyRange[],
    canvasSlots,
  });

  if (!op) {
    return { name, passed: false, resolverKind: null, expectedKind: 'swap', details: 'expected non-null op (kind=swap), got null' };
  }
  if (op.kind !== 'swap') {
    return { name, passed: false, resolverKind: op.kind, expectedKind: 'swap', details: `expected kind=swap, got ${op.kind}` };
  }
  const v = applyAndValidate(op, X, slotB, weekState, conflicts, canvasSlots, employeeById);
  return {
    name,
    passed: v.ok,
    resolverKind: op.kind,
    expectedKind: 'swap',
    failedInvariant: v.failedInvariant,
    details: v.details,
    finalAssignments: v.ok ? undefined : fmtAssignments(weekState),
  };
}

// ─── SCENARIO 2: Cascade resolvable (multi-hop) ───────────────────────────────
// No direct swap legal: P only available Mon, so cannot swap to Tue/Wed slots.
// Cascade chain (3 hops): P→Q@slotA, Q→R@slotE(Tue), R→Y@slotF(Wed). X takes slotB.

function runScenario2(): ScenarioResult {
  const name = 'Scenario 2 — cascade resolvable (multi-hop)';

  const P = makeEmployee({ id: 'P', name: 'P-partner', qualified_roles: ['server'] });
  const X = makeEmployee({ id: 'X', name: 'X-proposed', qualified_roles: ['server'] });
  const Q = makeEmployee({ id: 'Q', name: 'Q', qualified_roles: ['server'] });
  const R = makeEmployee({ id: 'R', name: 'R', qualified_roles: ['server'] });
  const Y = makeEmployee({ id: 'Y', name: 'Y', qualified_roles: ['server'] });
  const employees = [P, X, Q, R, Y];
  const employeeById = new Map(employees.map(e => [e.id, e]));

  // Availability tightly constrained — P/X only Mon, Q Mon+Tue, R Tue+Wed, Y Wed only.
  const availByEmp = new Map<string, Availability[]>([
    ['P', [makeAvail('P', 1, '08:00', '23:00')]],
    ['X', [makeAvail('X', 1, '08:00', '23:00')]],
    ['Q', [makeAvail('Q', 1, '08:00', '23:00'), makeAvail('Q', 2, '08:00', '23:00')]],
    ['R', [makeAvail('R', 2, '08:00', '23:00'), makeAvail('R', 3, '08:00', '23:00')]],
    ['Y', [makeAvail('Y', 3, '08:00', '23:00')]],
  ]);

  const slotA = makeSlot({ date: '2025-12-01', shift_name: 'Lunch', role: 'server', start_time: '11:00:00', end_time: '15:00:00', hours: 4, slot_index: 0 });
  const slotB = makeSlot({ date: '2025-12-01', shift_name: 'Lunch', role: 'server', start_time: '11:00:00', end_time: '15:00:00', hours: 4, slot_index: 1 });
  const slotE = makeSlot({ date: '2025-12-02', shift_name: 'Lunch', role: 'server', start_time: '11:00:00', end_time: '15:00:00', hours: 4, slot_index: 0 });
  const slotF = makeSlot({ date: '2025-12-03', shift_name: 'Lunch', role: 'server', start_time: '11:00:00', end_time: '15:00:00', hours: 4, slot_index: 0 });
  const canvasSlots = [slotA, slotB, slotE, slotF];

  const conflicts = [makeConflict('P', 'X')];

  const weekState: WeekState = {
    weeklyHoursMap: new Map([['P', 4], ['Q', 4], ['R', 4]]),
    assignmentsByDate: new Map([
      ['2025-12-01', ['P']],
      ['2025-12-02', ['Q']],
      ['2025-12-03', ['R']],
    ]),
    assignments: [makeAssignment(P, slotA), makeAssignment(Q, slotE), makeAssignment(R, slotF)],
    gaps: [],
    flagged_issues: [],
  };

  const op = resolveBannedPairConflict(slotB, X, 0, weekState, {
    employees,
    employeeById,
    availByEmp,
    toMap: new Map<string, TOWindow>(),
    conflicts,
    veteranOnlyDates: [] as VeteranOnlyRange[],
    canvasSlots,
  });

  if (!op) {
    return { name, passed: false, resolverKind: null, expectedKind: 'cascade', details: 'expected non-null op (kind=cascade), got null — cascade branch did not fire' };
  }
  if (op.kind !== 'cascade') {
    return { name, passed: false, resolverKind: op.kind, expectedKind: 'cascade', details: `expected kind=cascade (multi-hop), got ${op.kind} with ${op.moves.length} move(s) — fixture failed to force cascade` };
  }
  const v = applyAndValidate(op, X, slotB, weekState, conflicts, canvasSlots, employeeById);
  return {
    name,
    passed: v.ok,
    resolverKind: op.kind,
    expectedKind: 'cascade',
    failedInvariant: v.failedInvariant,
    details: v.ok ? `cascade hops=${op.moves.length}` : v.details,
  };
}

// ─── SCENARIO 3: Unresolvable ────────────────────────────────────────────────
// Only P and X exist. No other employees can take partner's slot. Null expected.

function runScenario3(): ScenarioResult {
  const name = 'Scenario 3 — unresolvable (no chain possible)';

  const P = makeEmployee({ id: 'P', name: 'P-partner', qualified_roles: ['server'] });
  const X = makeEmployee({ id: 'X', name: 'X-proposed', qualified_roles: ['server'] });
  const employees = [P, X];
  const employeeById = new Map(employees.map(e => [e.id, e]));

  const availByEmp = new Map<string, Availability[]>([
    ['P', [makeAvail('P', 1, '08:00', '23:00')]],
    ['X', [makeAvail('X', 1, '08:00', '23:00')]],
  ]);

  const slotA = makeSlot({ date: '2025-12-01', shift_name: 'Lunch', role: 'server', start_time: '11:00:00', end_time: '15:00:00', hours: 4, slot_index: 0 });
  const slotB = makeSlot({ date: '2025-12-01', shift_name: 'Lunch', role: 'server', start_time: '11:00:00', end_time: '15:00:00', hours: 4, slot_index: 1 });
  const canvasSlots = [slotA, slotB];

  const conflicts = [makeConflict('P', 'X')];

  const weekState: WeekState = {
    weeklyHoursMap: new Map([['P', 4]]),
    assignmentsByDate: new Map([['2025-12-01', ['P']]]),
    assignments: [makeAssignment(P, slotA)],
    gaps: [],
    flagged_issues: [],
  };

  const op = resolveBannedPairConflict(slotB, X, 0, weekState, {
    employees,
    employeeById,
    availByEmp,
    toMap: new Map<string, TOWindow>(),
    conflicts,
    veteranOnlyDates: [] as VeteranOnlyRange[],
    canvasSlots,
  });

  if (op === null) {
    return { name, passed: true, resolverKind: null, expectedKind: 'null' };
  }
  return {
    name,
    passed: false,
    resolverKind: op.kind,
    expectedKind: 'null',
    details: `expected null, got kind=${op.kind} moves=${JSON.stringify(op.moves)}`,
  };
}

// ─── SCENARIO 4: Regression guard for removed 'proposed' branch ───────────────
// Construct a scenario where the only correct resolution moves the partner (P).
// X is qualified ONLY for the Lunch role/time — has nowhere else to go. A
// buggy resolver that tried to move the proposed candidate instead would have
// either failed to find a placement or left P+X co-assigned. Assert: when
// non-null, the banned pair is NEVER co-assigned post-apply.

function runScenario4(): ScenarioResult {
  const name = 'Scenario 4 — regression guard: banned pair must be separated';

  const P = makeEmployee({ id: 'P', name: 'P-partner', qualified_roles: ['server'] });
  // X qualified narrowly — can only do Mon Lunch. The buggy "move proposed"
  // path would have had no valid alternate slot for X.
  const X = makeEmployee({ id: 'X', name: 'X-proposed', qualified_roles: ['server'] });
  const Q = makeEmployee({ id: 'Q', name: 'Q-swap', qualified_roles: ['server'] });
  const employees = [P, X, Q];
  const employeeById = new Map(employees.map(e => [e.id, e]));

  // X only Mon. P+Q available Mon+Tue.
  const availByEmp = new Map<string, Availability[]>([
    ['P', [makeAvail('P', 1, '08:00', '23:00'), makeAvail('P', 2, '08:00', '23:00')]],
    ['X', [makeAvail('X', 1, '08:00', '23:00')]],
    ['Q', [makeAvail('Q', 1, '08:00', '23:00'), makeAvail('Q', 2, '08:00', '23:00')]],
  ]);

  const slotA = makeSlot({ date: '2025-12-01', shift_name: 'Lunch', role: 'server', start_time: '11:00:00', end_time: '15:00:00', hours: 4, slot_index: 0 });
  const slotB = makeSlot({ date: '2025-12-01', shift_name: 'Lunch', role: 'server', start_time: '11:00:00', end_time: '15:00:00', hours: 4, slot_index: 1 });
  const slotC = makeSlot({ date: '2025-12-02', shift_name: 'Lunch', role: 'server', start_time: '11:00:00', end_time: '15:00:00', hours: 4, slot_index: 0 });
  const canvasSlots = [slotA, slotB, slotC];

  const conflicts = [makeConflict('P', 'X')];

  const weekState: WeekState = {
    weeklyHoursMap: new Map([['P', 4], ['Q', 4]]),
    assignmentsByDate: new Map([
      ['2025-12-01', ['P']],
      ['2025-12-02', ['Q']],
    ]),
    assignments: [makeAssignment(P, slotA), makeAssignment(Q, slotC)],
    gaps: [],
    flagged_issues: [],
  };

  const op = resolveBannedPairConflict(slotB, X, 0, weekState, {
    employees,
    employeeById,
    availByEmp,
    toMap: new Map<string, TOWindow>(),
    conflicts,
    veteranOnlyDates: [] as VeteranOnlyRange[],
    canvasSlots,
  });

  if (op === null) {
    // Acceptable null-return — no banned pair created. Still passes the regression check.
    return { name, passed: true, resolverKind: null, expectedKind: 'swap', details: 'resolver returned null (no resolution); banned pair not created — regression check satisfied vacuously' };
  }

  // Non-null op — invariant (a) MUST hold. This is the assertion that would
  // have caught the original bug.
  const v = applyAndValidate(op, X, slotB, weekState, conflicts, canvasSlots, employeeById);
  return {
    name,
    passed: v.ok,
    resolverKind: op.kind,
    expectedKind: 'swap',
    failedInvariant: v.failedInvariant,
    details: v.ok
      ? `non-null op with kind=${op.kind}; banned pair separated as required`
      : v.details,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const scenarios = [runScenario1, runScenario2, runScenario3, runScenario4];
  const results: ScenarioResult[] = [];

  console.log('═'.repeat(78));
  console.log('Cascade resolver unit test');
  console.log('═'.repeat(78));

  for (const fn of scenarios) {
    const r = fn();
    results.push(r);
    const tag = r.passed ? 'PASS' : 'FAIL';
    const kindStr = r.resolverKind === null ? 'null' : r.resolverKind;
    console.log('');
    console.log(`[${tag}] ${r.name}`);
    console.log(`       resolver returned: ${kindStr}  (expected: ${r.expectedKind})`);
    if (r.failedInvariant) console.log(`       invariant broken: ${r.failedInvariant}`);
    if (r.details) console.log(`       ${r.details}`);
  }

  console.log('');
  console.log('═'.repeat(78));
  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  console.log(`Summary: ${passed}/${results.length} passed, ${failed} failed`);

  const kindsExercised = new Set(results.map(r => r.resolverKind === null ? 'null-return' : r.resolverKind === 'swap' ? 'direct-swap' : 'cascade'));
  console.log(`Branches exercised: ${Array.from(kindsExercised).sort().join(', ')}`);
  console.log('═'.repeat(78));

  if (failed > 0) process.exit(1);
}

main();
