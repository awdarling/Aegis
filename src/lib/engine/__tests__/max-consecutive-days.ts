/// <reference types="node" />
// Runtime tests for the max_consecutive_days_worked engine constraint.
//
// Same shape as smoke.ts — a runtime block guarded by require.main === module
// so importing the file is side-effect-free.
//
// Run: npx ts-node src/lib/engine/__tests__/max-consecutive-days.ts

import {
  DEFAULT_ENGINE_SETTINGS,
  type EngineSettings,
} from '../../constraints/types';
import type {
  Availability,
  Employee,
  EmployeeConflict,
  Policy,
  ShiftRequirement,
  ShiftType,
} from '../../../db/types';
import {
  runScheduleBuild,
  type BuildData,
  type ScheduleAssignment,
} from '../../../workflows/schedule-build';
import { resolveBannedPairConflict } from '../cascade';
import { enforceAttributeMixForShift } from '../attribute-mix';
import type { AttributeMixConstraint } from '../../constraints/types';
import type { CanvasSlot, WeekState } from '../types';

function expect(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

// Build a tiny 1-employee / 7-day-demand fixture. The week runs Mon
// 2026-06-01 through Sun 2026-06-07 — getUTCDay() values 1..0 (Mon..Sun).
function buildSingleEmployeeWeekFixture(): BuildData {
  const COMPANY_ID = 'company-maxconsec';
  const ST_ID = 'st-daily';

  const shiftType: ShiftType = {
    id: ST_ID,
    company_id: COMPANY_ID,
    name: 'Daily',
    start_time: '09:00',
    end_time: '13:00',
    days_active: [0, 1, 2, 3, 4, 5, 6],
    active: true,
    created_at: '2026-01-01T00:00:00Z',
  };
  const req: ShiftRequirement = {
    id: 'req-daily',
    company_id: COMPANY_ID,
    shift_name: 'Daily',
    role: 'Lifeguard',
    required_count: 1,
    start_time: '09:00',
    end_time: '13:00',
    days_active: [0, 1, 2, 3, 4, 5, 6],
    shift_type_id: ST_ID,
  };

  const emp: Employee = {
    id: 'emp-solo',
    company_id: COMPANY_ID,
    name: 'Solo Lifeguard',
    primary_role: 'Lifeguard',
    qualified_roles: ['Lifeguard'],
    max_weekly_hours: 40,  // 7 × 4h = 28h < 40h — weekly cap never binds
    contact_phone: null,
    contact_email: null,
    active: true,
    created_at: '2026-01-01T00:00:00Z',
    individual_wage: null,
    is_veteran: false,
  };

  const availability: Availability[] = [0, 1, 2, 3, 4, 5, 6].map(dow => ({
    id: `av-${emp.id}-${dow}`,
    employee_id: emp.id,
    company_id: COMPANY_ID,
    day_of_week: dow,
    start_time: '00:00',
    end_time: '23:59',
  }));

  return {
    employees: [emp],
    availByEmp: new Map([[emp.id, availability]]),
    toMap: new Map(),
    shiftTypes: [shiftType],
    shiftRequirements: [req],
    conflicts: [],
    policies: [],
    events: [],
    companyName: 'Test Co',
    companyTimezone: 'America/New_York',
  };
}

const WEEK_START = '2026-06-01';
const WEEK_END = '2026-06-07';
const SOLO_ID = 'emp-solo';

// (a) Regression — with maxConsecutiveDaysWorked unset (default null), the
// engine behaves identically to the pre-feature path. The 1-employee, 7-day,
// 40h-cap fixture must produce 7 assignments, 0 gaps, and zero
// 'max_consecutive_days_reached' dispositions.
function runRegressionNoCapSmoke(): void {
  const data = buildSingleEmployeeWeekFixture();
  const result = runScheduleBuild(
    data,
    DEFAULT_ENGINE_SETTINGS,  // maxConsecutiveDaysWorked: null
    null,
    [],
    WEEK_START,
    WEEK_END,
  );

  expect(
    result.totalRequired === 7,
    `Regression: totalRequired === 7 (got ${result.totalRequired})`,
  );
  expect(
    result.totalFilled === 7,
    `Regression: all 7 demanded slots filled with the lone employee (totalFilled === 7, got ${result.totalFilled})`,
  );
  expect(
    result.gaps.length === 0,
    `Regression: no gaps under default settings (got ${result.gaps.length})`,
  );
  expect(
    result.assignments.every(a => a.employee_id === SOLO_ID),
    `Regression: every assignment goes to the solo employee`,
  );

  const allMaxConsec = result.gaps.flatMap(g =>
    g.per_employee_dispositions.filter(d => d.reason === 'max_consecutive_days_reached'),
  );
  expect(
    allMaxConsec.length === 0,
    `Regression: zero 'max_consecutive_days_reached' dispositions anywhere (got ${allMaxConsec.length})`,
  );
}

// (b) Enforcement — same fixture, but max=5. Expected per the step-3 spec
// ("consecutive worked-day run WITHIN the build week, computed strictly from
// assignments already made"):
//   - Days 1–5 (Mon–Fri) are filled.
//   - Day 6 (Sat) is rejected because the candidate's run including Sat would
//     be 6 (Mon..Sat), exceeding max=5 → gap with reason
//     'max_consecutive_days_reached'.
//   - Day 7 (Sun) is FILLED — Saturday wasn't worked, so the run resets and
//     placing on Sun is a fresh run of length 1, within the cap.
//
// NOTE: the step-4 brief's expected outcome ("days 6–7 become GAPS") would
// require a different semantic — e.g. a permanent post-cap lockout for the
// rest of the week — that the step-3 spec does not describe. The
// implementation follows the spec; this test asserts the spec-consistent
// outcome and documents the deviation explicitly in BUILD_NOTES.
function runEnforcementMaxFiveSmoke(): void {
  const data = buildSingleEmployeeWeekFixture();
  const settings: EngineSettings = {
    ...DEFAULT_ENGINE_SETTINGS,
    maxConsecutiveDaysWorked: 5,
  };
  const result = runScheduleBuild(
    data,
    settings,
    null,
    [],
    WEEK_START,
    WEEK_END,
  );

  expect(
    result.totalRequired === 7,
    `Enforcement: totalRequired === 7 (got ${result.totalRequired})`,
  );

  const assignedDates = result.assignments
    .filter(a => a.employee_id === SOLO_ID)
    .map(a => a.date)
    .sort();
  const expectedAssigned = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-07'];
  expect(
    JSON.stringify(assignedDates) === JSON.stringify(expectedAssigned),
    `Enforcement: solo employee placed Mon–Fri + Sun, NOT Sat (got [${assignedDates.join(', ')}])`,
  );
  expect(
    result.totalFilled === 6,
    `Enforcement: 6 of 7 slots filled — 1 gap on Sat (totalFilled === 6, got ${result.totalFilled})`,
  );

  const satGaps = result.gaps.filter(g => g.date === '2026-06-06');
  expect(
    satGaps.length === 1,
    `Enforcement: exactly 1 gap on Sat 2026-06-06 (got ${satGaps.length})`,
  );
  const satGap = satGaps[0];
  expect(
    !!satGap && satGap.per_employee_dispositions.length === 1,
    `Enforcement: Sat gap classifies the 1 qualified employee (got ${satGap?.per_employee_dispositions.length})`,
  );
  const satDisp = satGap?.per_employee_dispositions[0];
  expect(
    satDisp?.employee_id === SOLO_ID && satDisp?.reason === 'max_consecutive_days_reached',
    `Enforcement: Sat gap disposition is (${SOLO_ID}, 'max_consecutive_days_reached') (got ${satDisp?.employee_id}/${satDisp?.reason})`,
  );

  const sunGaps = result.gaps.filter(g => g.date === '2026-06-07');
  expect(
    sunGaps.length === 0,
    `Enforcement: Sun has no gap — run reset after Sat (got ${sunGaps.length})`,
  );

  const sunAssignments = result.assignments.filter(a => a.date === '2026-06-07');
  expect(
    sunAssignments.length === 1 && sunAssignments[0]?.employee_id === SOLO_ID,
    `Enforcement: Sun is filled by the solo employee (got ${sunAssignments.length} assignments, employee ${sunAssignments[0]?.employee_id})`,
  );

  // Other gaps (Mon–Fri) must not exist.
  const offDayGaps = result.gaps.filter(g => g.date !== '2026-06-06');
  expect(
    offDayGaps.length === 0,
    `Enforcement: no other gaps besides Sat (got ${offDayGaps.length})`,
  );
}

// ── helpers shared by (c) and (d) ─────────────────────────────────────────

function longestRunForEmp(assignments: ScheduleAssignment[], empId: string): number {
  const dates = Array.from(new Set(assignments.filter(a => a.employee_id === empId).map(a => a.date))).sort();
  if (dates.length === 0) return 0;
  let best = 1;
  let cur = 1;
  const DAY_MS = 24 * 60 * 60 * 1000;
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(`${dates[i - 1]}T12:00:00Z`).getTime();
    const here = new Date(`${dates[i]}T12:00:00Z`).getTime();
    if (here - prev === DAY_MS) {
      cur++;
      if (cur > best) best = cur;
    } else {
      cur = 1;
    }
  }
  return best;
}

// (c) Cascade resolver — direct unit test of resolveBannedPairConflict.
//
// The cascade resolver is reachable in production only when the slot-eligible
// pool is empty AND blockedByConflictOnly has a candidate AND there's a swap
// chain. Constructing a runScheduleBuild fixture that drives that exact path
// is brittle and depends on ranker tie-breaks. So we unit-test the resolver
// directly with a hand-built weekState — full control, deterministic.
//
// Scenario: target slot has a placed `partner` (emp-X) who is banned-paired
// with the candidate emp-Y. The resolver must move emp-X out via a swap.
// We construct three "elsewhere" rows the cascade can swap with. With cap
// disabled, the cheapest viable swap puts emp-A onto Sat — emp-A already
// works Wed/Thu/Fri, so Sat would extend the run to 4 days (4-day run is
// fine; we set the cap to make this binding).
//
// With cap=3, the cap check inside `legalToPlace` MUST reject the move that
// would push emp-A to a 4-day run, and the resolver should either return a
// different swap that respects the cap, or return null.
//
// Path-fired evidence: with cap=null the resolver returns a non-null
// SwapOperation (proving the cascade chain was entered AND found a swap);
// with cap=3, if it returns an op we INSPECT each move and confirm the
// resulting state has no employee exceeding 3 consecutive days.

function buildCascadeFixture(): {
  targetSlot: CanvasSlot;
  candidate: Employee;
  partnerAssignmentIndex: number;
  weekState: WeekState;
  employees: Employee[];
  conflicts: EmployeeConflict[];
} {
  const COMPANY_ID = 'company-cascade-cap';

  const baseEmp = (id: string, name: string): Employee => ({
    id,
    company_id: COMPANY_ID,
    name,
    primary_role: 'Lifeguard',
    qualified_roles: ['Lifeguard'],
    max_weekly_hours: 40,
    contact_phone: null,
    contact_email: null,
    active: true,
    created_at: '2026-01-01T00:00:00Z',
    individual_wage: null,
    is_veteran: false,
  });

  // Setup tuned so cap=null and cap=2 pick DIFFERENT swaps:
  //   emp-X (partner) on Sat AND already on Tue + Wed (2-day run).
  //   emp-M on Mon (cascade swap candidate at i=0 — moving X to Mon would
  //     extend X's run to Mon-Wed = 3, blocked by cap=2).
  //   emp-N on Fri (swap candidate at i=1 — moving X to Fri yields run
  //     length=2 inside the conservative viewState — Sat NOT hidden — so
  //     adding Fri walks Sat:yes/Sun:no/Thu:no → length=2, ALLOWED by cap=2).
  //   emp-Y is the cascade-entry candidate, banned with X.
  const empM = baseEmp('emp-M', 'Mover M');
  const empN = baseEmp('emp-N', 'Mover N');
  const empX = baseEmp('emp-X', 'Partner X');
  const empY = baseEmp('emp-Y', 'Candidate Y');

  const SHIFT_NAME = 'Day';
  const ST_ID = 'st-cascade';
  const slot = (date: string, slotIndex: number, reqId: string): CanvasSlot => ({
    date,
    shift_type_id: ST_ID,
    shift_name: SHIFT_NAME,
    shift_requirement_id: reqId,
    role: 'Lifeguard',
    start_time: '09:00',
    end_time: '13:00',
    hours: 4,
    required_count: 1,
    slot_index: slotIndex,
    is_priority: false,
  });
  const assignmentRow = (date: string, emp: Employee): ScheduleAssignment => ({
    date,
    employee_id: emp.id,
    employee_name: emp.name,
    shift_name: SHIFT_NAME,
    role: 'Lifeguard',
    start_time: '09:00',
    end_time: '13:00',
    hours: 4,
  });

  // ORDER MATTERS: i=0 must be the Mon swap (cap=2 will REJECT it; cap=null
  // picks it as first-viable). i=1 must be the Fri swap (cap-respecting
  // fallback under cap=2).
  const assignments: ScheduleAssignment[] = [
    assignmentRow('2026-06-01', empM),   // i=0: Mon → M
    assignmentRow('2026-06-05', empN),   // i=1: Fri → N
    assignmentRow('2026-06-02', empX),   // i=2: Tue → X
    assignmentRow('2026-06-03', empX),   // i=3: Wed → X
    assignmentRow('2026-06-06', empX),   // i=4: Sat → X (partner)
  ];
  const partnerAssignmentIndex = 4;

  const weeklyHoursMap = new Map<string, number>();
  for (const a of assignments) {
    weeklyHoursMap.set(a.employee_id, (weeklyHoursMap.get(a.employee_id) ?? 0) + a.hours);
  }
  const weekState: WeekState = {
    weeklyHoursMap,
    assignments,
    gaps: [],
    flagged_issues: [],
  };

  const conflicts: EmployeeConflict[] = [
    {
      id: 'conflict-Y-X',
      company_id: COMPANY_ID,
      employee_id_1: empY.id,
      employee_id_2: empX.id,
      severity: 'never',
      reason: null,
      created_at: '2026-01-01T00:00:00Z',
    },
  ];

  const targetSlot = slot('2026-06-06', 1, 'req-sat-2');

  return {
    targetSlot,
    candidate: empY,
    partnerAssignmentIndex,
    weekState,
    employees: [empM, empN, empX, empY],
    conflicts,
  };
}

function runCascadeCapCoverageSmoke(): void {
  console.log('── (c) cascade — direct resolveBannedPairConflict unit test ──');

  const COMPANY_ID = 'company-cascade-cap';
  const f = buildCascadeFixture();

  // Build day-of-week availability for every employee, every day.
  const availByEmp = new Map<string, Availability[]>();
  for (const e of f.employees) {
    availByEmp.set(
      e.id,
      [0, 1, 2, 3, 4, 5, 6].map(dow => ({
        id: `av-${e.id}-${dow}`,
        employee_id: e.id,
        company_id: COMPANY_ID,
        day_of_week: dow,
        start_time: '00:00',
        end_time: '23:59',
      })),
    );
  }
  const employeeById = new Map(f.employees.map(e => [e.id, e]));
  // Canvas — one slot per pre-existing assignment date plus the target.
  const baseSlot = (date: string, reqId: string): CanvasSlot => ({
    date, shift_type_id: 'st-cascade', shift_name: 'Day',
    shift_requirement_id: reqId, role: 'Lifeguard',
    start_time: '09:00', end_time: '13:00', hours: 4,
    required_count: 1, slot_index: 0, is_priority: false,
  });
  const canvasSlots: CanvasSlot[] = [
    { ...f.targetSlot },                            // Sat-slot2 — the target
    baseSlot('2026-06-01', 'req-mon'),              // Mon (emp-M)
    baseSlot('2026-06-05', 'req-fri'),              // Fri (emp-N)
    baseSlot('2026-06-02', 'req-tue'),              // Tue (emp-X)
    baseSlot('2026-06-03', 'req-wed'),              // Wed (emp-X)
    baseSlot('2026-06-06', 'req-sat-1'),            // Sat-slot1 (emp-X, partner)
  ];

  const deps = {
    employees: f.employees,
    employeeById,
    availByEmp,
    toMap: new Map(),
    conflicts: f.conflicts,
    veteranOnlyDates: [],
    canvasSlots,
    settings: DEFAULT_ENGINE_SETTINGS,
  };

  // ── cap=null ──────────────────────────────────────────────────────────
  // Resolver should pick i=0 (Mon-M swap) as the first-viable. legalToPlace
  // for emp-X moving onto Mon: viewState hides Mon-M only; X's worked still
  // includes Sat (partner row NOT hidden). Mon's run from {Tue,Wed,Sat}+Mon
  // = walk forward Tue/Wed (length 3), back Sun (no, stop). Length=3.
  // cap=null accepts.
  const opA = resolveBannedPairConflict(
    f.targetSlot,
    f.candidate,
    f.partnerAssignmentIndex,
    f.weekState,
    deps,
  );
  expect(
    opA !== null && opA.moves.length >= 1,
    `(c) cap=null: resolver finds a viable swap (path entered + resolved). got moves=${opA?.moves.length ?? 0}`,
  );

  // ── cap=2 ─────────────────────────────────────────────────────────────
  // i=0 Mon-M swap: legalToPlace(X, Mon) would give length=3 (>2), REJECTED.
  // i=1 Fri-N swap: legalToPlace(X, Fri) gives length=2 (Sat adj, Thu not),
  // ACCEPTED. So cap=2 picks i=1.
  const opB = resolveBannedPairConflict(
    f.targetSlot,
    f.candidate,
    f.partnerAssignmentIndex,
    f.weekState,
    { ...deps, settings: { ...DEFAULT_ENGINE_SETTINGS, maxConsecutiveDaysWorked: 2 } },
  );
  expect(
    opB !== null,
    `(c) cap=2: resolver still finds a cap-respecting swap (not forced to null). got moves=${opB?.moves.length ?? 0}`,
  );

  // (c.diff) THE binding assertion: cap=null and cap=2 produce DIFFERENT
  // moves — direct evidence the cap-check changed the resolver's choice.
  const moveSetA = JSON.stringify(opA?.moves.map(m => `${m.assignment_index}->${m.new_employee_id}`).sort());
  const moveSetB = JSON.stringify(opB?.moves.map(m => `${m.assignment_index}->${m.new_employee_id}`).sort());
  console.log(`    cap=null moves: ${moveSetA}`);
  console.log(`    cap=2   moves: ${moveSetB}`);
  expect(
    moveSetA !== moveSetB,
    `(c) cap-fix DIFFERENTIATING: cap=null vs cap=2 produce DIFFERENT swap moves (proves the cap check inside legalToPlace actually rejected the natural pick).`,
  );

  // Apply cap=2 op and check MUST-PASS invariant.
  if (opB) {
    const stateCopy: WeekState = {
      ...f.weekState,
      assignments: f.weekState.assignments.map(a => ({ ...a })),
      weeklyHoursMap: new Map(f.weekState.weeklyHoursMap),
    };
    for (const m of opB.moves) {
      const prev = stateCopy.assignments[m.assignment_index];
      stateCopy.assignments[m.assignment_index] = {
        ...prev,
        employee_id: m.new_employee_id,
        employee_name: m.new_employee_name,
      };
    }
    stateCopy.assignments.push({
      date: f.targetSlot.date,
      employee_id: f.candidate.id,
      employee_name: f.candidate.name,
      shift_name: f.targetSlot.shift_name,
      role: f.targetSlot.role,
      start_time: f.targetSlot.start_time,
      end_time: f.targetSlot.end_time,
      hours: f.targetSlot.hours,
    });
    const runs: Record<string, number> = {};
    for (const e of f.employees) {
      runs[e.id] = longestRunForEmp(stateCopy.assignments, e.id);
    }
    const overCap = Object.entries(runs).filter(([, r]) => r > 2);
    expect(
      overCap.length === 0,
      `(c) cap=2 invariant: no employee exceeds 2 consecutive days after applying the resolver's swap. runs=${JSON.stringify(runs)}; over=${JSON.stringify(overCap)}`,
    );
  }

  // ── cap=null deterministic re-run (off-by-default) ─────────────────────
  const opA2 = resolveBannedPairConflict(
    f.targetSlot,
    f.candidate,
    f.partnerAssignmentIndex,
    f.weekState,
    { ...deps, settings: { ...DEFAULT_ENGINE_SETTINGS, maxConsecutiveDaysWorked: null } },
  );
  const opAJSON = JSON.stringify(opA?.moves ?? null);
  const opA2JSON = JSON.stringify(opA2?.moves ?? null);
  expect(
    opAJSON === opA2JSON,
    `(c) cap=null re-run is deterministic and unchanged (off-by-default holds). identical: ${opAJSON === opA2JSON}`,
  );
}

// (d) Attribute-mix swap — direct unit test of enforceAttributeMixForShift.
//
// The attribute-mix swap pass replaces over-represented employees with
// under-represented ones. The replacement candidate is picked from an
// eligibility-filtered list via `find` (first match wins). With pre-existing
// adjacent days, a candidate's consecutive run extends when placed.
//
// Setup: Mon shift with required_count=2, pre-filled with two females. Rule
// requires 1 male + 1 female. Two male candidates:
//   - maleAdjacent: already on Tue + Wed in the same build. Placing him on
//     Mon would extend his run to Mon-Wed = 3 consec.
//   - maleFresh: no prior days. Placing him on Mon is run = 1.
// Both are equally eligible; `find` order is by deps.employees order.
//
// With cap=null: swap picks maleAdjacent (first in list) → maleAdjacent run = 3.
// With cap=2:    swap MUST reject maleAdjacent (run would be 3 > 2) and pick
//                maleFresh instead → no employee exceeds cap=2.
//
// Path-fired evidence: assert that AFTER the swap, the shift has a male
// employee on it (proving enforce ran and produced a swap). The chosen
// male's identity DIFFERS between cap=null and cap=2 → proves the cap-check
// actually changed the swap target.

function buildAttributeMixFixture(): {
  COMPANY_ID: string;
  shiftType: ShiftType;
  req: ShiftRequirement;
  males: Employee[];
  females: Employee[];
  attribMixPolicy: Policy;
} {
  const COMPANY_ID = 'company-attribmix-cap';
  const ST_ID = 'st-mixcap';
  const shiftType: ShiftType = {
    id: ST_ID,
    company_id: COMPANY_ID,
    name: 'MixDay',
    start_time: '09:00',
    end_time: '13:00',
    days_active: [0, 1, 2, 3, 4, 5, 6],
    active: true,
    created_at: '2026-01-01T00:00:00Z',
  };
  const req: ShiftRequirement = {
    id: 'req-mixcap',
    company_id: COMPANY_ID,
    shift_name: 'MixDay',
    role: 'Lifeguard',
    required_count: 2,
    start_time: '09:00',
    end_time: '13:00',
    days_active: [0, 1, 2, 3, 4, 5, 6],
    shift_type_id: ST_ID,
  };

  const baseEmp = (id: string, name: string): Employee => ({
    id,
    company_id: COMPANY_ID,
    name,
    primary_role: 'Lifeguard',
    qualified_roles: ['Lifeguard'],
    max_weekly_hours: 40,
    contact_phone: null,
    contact_email: null,
    active: true,
    created_at: '2026-01-01T00:00:00Z',
    individual_wage: null,
    is_veteran: false,
  });

  const maleAdjacent = baseEmp('emp-m-adj', 'Male Adjacent');
  const maleFresh = baseEmp('emp-m-fresh', 'Male Fresh');
  (maleAdjacent as unknown as Record<string, unknown>).sex = 'male';
  (maleFresh as unknown as Record<string, unknown>).sex = 'male';

  const femA = baseEmp('emp-f-a', 'Female A');
  const femB = baseEmp('emp-f-b', 'Female B');
  (femA as unknown as Record<string, unknown>).sex = 'female';
  (femB as unknown as Record<string, unknown>).sex = 'female';

  const attribMixPolicy: Policy = {
    id: 'pol-mixcap',
    company_id: COMPANY_ID,
    policy_key: 'gender_requirement',
    policy_value: '1m+1f',
    policy_value_json: { attribute: 'sex', minimums: { male: 1, female: 1 }, scope: 'all_shifts' },
    policy_type: 'coverage',
    description: null,
    version: 1,
    created_at: '2026-01-01T00:00:00Z',
  };

  return {
    COMPANY_ID,
    shiftType,
    req,
    males: [maleAdjacent, maleFresh],   // order matters — adjacent first
    females: [femA, femB],
    attribMixPolicy,
  };
}

function runAttributeMixCapCoverageSmoke(): void {
  console.log('── (d) attribute-mix — direct enforceAttributeMixForShift unit test ──');

  const f = buildAttributeMixFixture();
  const allEmps = [...f.males, ...f.females];   // maleAdjacent first → `find` picks him first under cap=null
  const employeeById = new Map(allEmps.map(e => [e.id, e]));

  // Availability: every employee available every day.
  const availByEmp = new Map<string, Availability[]>();
  for (const e of allEmps) {
    availByEmp.set(
      e.id,
      [0, 1, 2, 3, 4, 5, 6].map(dow => ({
        id: `av-${e.id}-${dow}`,
        employee_id: e.id,
        company_id: f.COMPANY_ID,
        day_of_week: dow,
        start_time: '00:00',
        end_time: '23:59',
      })),
    );
  }

  // Canvas — one slot per (date, slot_index) for the Mon shift. Two slots.
  const canvasSlots: CanvasSlot[] = [
    {
      date: '2026-06-01', shift_type_id: f.shiftType.id, shift_name: 'MixDay',
      shift_requirement_id: f.req.id, role: 'Lifeguard',
      start_time: '09:00', end_time: '13:00', hours: 4,
      required_count: 2, slot_index: 0, is_priority: false,
    },
    {
      date: '2026-06-01', shift_type_id: f.shiftType.id, shift_name: 'MixDay',
      shift_requirement_id: f.req.id, role: 'Lifeguard',
      start_time: '09:00', end_time: '13:00', hours: 4,
      required_count: 2, slot_index: 1, is_priority: false,
    },
  ];

  // Pre-existing weekState: maleAdjacent already on Tue + Wed. Mon's
  // two slots are filled with femA + femB. Sets up the rule violation
  // (rule wants ≥1 male, current = 0 males on Mon).
  function buildState(): { state: WeekState; monShiftAssignments: ScheduleAssignment[]; monIndices: number[] } {
    const monRow = (femEmp: Employee): ScheduleAssignment => ({
      date: '2026-06-01', employee_id: femEmp.id, employee_name: femEmp.name,
      shift_name: 'MixDay', role: 'Lifeguard',
      start_time: '09:00', end_time: '13:00', hours: 4,
    });
    const adjRow = (date: string): ScheduleAssignment => ({
      date, employee_id: 'emp-m-adj', employee_name: 'Male Adjacent',
      shift_name: 'MixDay', role: 'Lifeguard',
      start_time: '09:00', end_time: '13:00', hours: 4,
    });
    const assignments: ScheduleAssignment[] = [
      monRow(f.females[0]),   // Mon-slot1 → femA
      monRow(f.females[1]),   // Mon-slot2 → femB
      adjRow('2026-06-02'),   // Tue → maleAdjacent
      adjRow('2026-06-03'),   // Wed → maleAdjacent
    ];
    const weeklyHoursMap = new Map<string, number>();
    for (const a of assignments) {
      weeklyHoursMap.set(a.employee_id, (weeklyHoursMap.get(a.employee_id) ?? 0) + a.hours);
    }
    return {
      state: { weeklyHoursMap, assignments, gaps: [], flagged_issues: [] },
      monShiftAssignments: [assignments[0], assignments[1]],
      monIndices: [0, 1],
    };
  }

  const constraint: AttributeMixConstraint = {
    type: 'attribute_mix',
    attribute: 'sex',
    minimums: { male: 1, female: 1 },
    scope: 'all_shifts',
  };

  const baseDeps = {
    employees: allEmps,                  // maleAdjacent first in iteration order
    employeeById,
    availByEmp,
    toMap: new Map(),
    conflicts: [],
    veteranOnlyDates: [],
    canvasSlots,
  };

  // ── cap=null run ─────────────────────────────────────────
  const { state: stateA, monShiftAssignments: monA, monIndices: monIA } = buildState();
  const resultA = enforceAttributeMixForShift(
    monA,
    monIA,
    [constraint],
    { date: '2026-06-01', shift_type_id: f.shiftType.id, shift_name: 'MixDay' },
    f.req.id,
    stateA,
    { ...baseDeps, settings: DEFAULT_ENGINE_SETTINGS },
  );
  expect(
    resultA.satisfied && resultA.swaps.length >= 1,
    `(d) cap=null: swap pass fires + resolves (path entered + 1+ swap applied). satisfied=${resultA.satisfied}, swaps=${resultA.swaps.length}`,
  );

  // Identify which male landed on Mon and compute his consecutive run.
  const monMalesA = stateA.assignments
    .filter(a => a.date === '2026-06-01')
    .map(a => a.employee_id)
    .filter(id => f.males.some(m => m.id === id));
  expect(
    monMalesA.length === 1,
    `(d) cap=null: exactly 1 male now on Mon (got ${monMalesA.length}: ${monMalesA.join(',')})`,
  );
  const chosenMaleA = monMalesA[0];
  expect(
    chosenMaleA === 'emp-m-adj',
    `(d) cap=null: 'find' iteration order picks maleAdjacent first (the natural-cap-null pick that the cap=2 run must DIFFER from). got '${chosenMaleA}'`,
  );
  const runAdjA = longestRunForEmp(stateA.assignments, 'emp-m-adj');
  expect(
    runAdjA === 3,
    `(d) cap=null: maleAdjacent run becomes 3 (Mon-Wed) without the cap. got ${runAdjA}`,
  );

  // ── cap=2 run ────────────────────────────────────────────
  const { state: stateB, monShiftAssignments: monB, monIndices: monIB } = buildState();
  const resultB = enforceAttributeMixForShift(
    monB,
    monIB,
    [constraint],
    { date: '2026-06-01', shift_type_id: f.shiftType.id, shift_name: 'MixDay' },
    f.req.id,
    stateB,
    { ...baseDeps, settings: { ...DEFAULT_ENGINE_SETTINGS, maxConsecutiveDaysWorked: 2 } },
  );
  expect(
    resultB.satisfied && resultB.swaps.length >= 1,
    `(d) cap=2: swap pass still resolves with maleFresh instead (path entered, cap-respecting swap found). satisfied=${resultB.satisfied}, swaps=${resultB.swaps.length}`,
  );

  const monMalesB = stateB.assignments
    .filter(a => a.date === '2026-06-01')
    .map(a => a.employee_id)
    .filter(id => f.males.some(m => m.id === id));
  expect(
    monMalesB.length === 1,
    `(d) cap=2: exactly 1 male now on Mon (got ${monMalesB.length}: ${monMalesB.join(',')})`,
  );
  const chosenMaleB = monMalesB[0];
  expect(
    chosenMaleB === 'emp-m-fresh',
    `(d) cap=2: cap-check rejects maleAdjacent (would be run=3), swap picks maleFresh. got '${chosenMaleB}'`,
  );

  // MUST-PASS invariant: no employee exceeds cap=2 in the final state.
  const runsB: Record<string, number> = {};
  for (const e of allEmps) {
    runsB[e.id] = longestRunForEmp(stateB.assignments, e.id);
  }
  const overCapB = Object.entries(runsB).filter(([, r]) => r > 2);
  expect(
    overCapB.length === 0,
    `(d) cap=2 invariant: no employee exceeds 2 consecutive days. runs=${JSON.stringify(runsB)}; over=${JSON.stringify(overCapB)}`,
  );

  // off-by-default proof: cap=null and cap=2 produce DIFFERENT swap outcomes.
  expect(
    chosenMaleA !== chosenMaleB,
    `(d) cap=null vs cap=2 produce DIFFERENT swap targets (proves cap-check actually changed behavior). null='${chosenMaleA}', cap=2='${chosenMaleB}'`,
  );
}

if (require.main === module) {
  runRegressionNoCapSmoke();
  console.log('');
  runEnforcementMaxFiveSmoke();
  console.log('');
  runCascadeCapCoverageSmoke();
  console.log('');
  runAttributeMixCapCoverageSmoke();
  if (!process.exitCode) console.log('\nAll max-consecutive-days checks passed.');
}
