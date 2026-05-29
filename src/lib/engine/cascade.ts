import type { Availability, Employee, EmployeeConflict } from '../../db/types';
import type { EngineSettings } from '../constraints/types';
import type { TOWindow } from '../to-window';
import type { ScheduleAssignment } from '../../workflows/schedule-build';
import { buildEligibility, sameDayDoubleReason, type VeteranOnlyRange } from './eligibility';
import type { CanvasSlot, WeekState } from './types';

export interface SwapOperation {
  kind: 'swap' | 'cascade';
  moves: Array<{
    assignment_index: number;
    new_employee_id: string;
    new_employee_name: string;
  }>;
}

const MAX_CASCADE_HOPS = 5;

interface ResolverDeps {
  employees: Employee[];
  employeeById: Map<string, Employee>;
  availByEmp: Map<string, Availability[]>;
  toMap: Map<string, TOWindow>;
  conflicts: EmployeeConflict[];
  veteranOnlyDates: VeteranOnlyRange[];
  canvasSlots: CanvasSlot[];
  settings: EngineSettings;
}

function hardConflictExists(
  empId: string,
  cohabIds: string[],
  conflicts: EmployeeConflict[]
): boolean {
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

function slotForAssignment(a: ScheduleAssignment, canvasSlots: CanvasSlot[]): CanvasSlot | null {
  return (
    canvasSlots.find(
      s => s.date === a.date && s.shift_name === a.shift_name && s.role === a.role
    ) ?? null
  );
}

function legalToPlace(
  emp: Employee,
  slot: CanvasSlot,
  weekState: WeekState,
  deps: ResolverDeps,
  ignoreAssignmentIndex?: number,
  ignoreEmployeeIdOnShift?: string
): boolean {
  const pool = buildEligibility(slot, [emp], deps.availByEmp, deps.toMap, deps.veteranOnlyDates);
  if (pool.employees.length === 0) return false;

  // Same-day double / overlap check. We compute over a view of weekState
  // that hides the assignment(s) being displaced by this resolver step —
  // otherwise the employee we're trying to move BACK in would always look
  // like they're already on the day.
  const viewState: WeekState = {
    ...weekState,
    assignments: weekState.assignments.filter((a, i) =>
      i !== ignoreAssignmentIndex &&
      !(a.date === slot.date && a.shift_name === slot.shift_name && a.employee_id === ignoreEmployeeIdOnShift)
    ),
  };
  if (sameDayDoubleReason(emp.id, slot, viewState, deps.settings) !== null) return false;

  const cohabIds = weekState.assignments
    .filter((a, i) =>
      i !== ignoreAssignmentIndex &&
      a.date === slot.date &&
      a.shift_name === slot.shift_name &&
      a.employee_id !== ignoreEmployeeIdOnShift
    )
    .map(a => a.employee_id);
  if (cohabIds.includes(emp.id)) return false;
  if (hardConflictExists(emp.id, cohabIds, deps.conflicts)) return false;

  const currentHours = weekState.weeklyHoursMap.get(emp.id) ?? 0;
  if (currentHours + slot.hours > emp.max_weekly_hours) return false;

  return true;
}

function hoursVarianceAfter(
  weekState: WeekState,
  changes: Array<{ employee_id: string; delta: number }>
): number {
  const hours = new Map(weekState.weeklyHoursMap);
  for (const c of changes) {
    hours.set(c.employee_id, (hours.get(c.employee_id) ?? 0) + c.delta);
  }
  const vals = Array.from(hours.values());
  if (vals.length === 0) return 0;
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  return vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / vals.length;
}

// Attempt to resolve a hard banned-pair conflict that would be created by
// placing `proposedEmp` into `targetSlot` alongside `partnerAssignmentIndex`.
// Strategy: swap-first, cascade-fallback (depth limited to 5 hops).
// Returns null if no resolution found — caller falls back to fill-and-flag.
export function resolveBannedPairConflict(
  targetSlot: CanvasSlot,
  proposedEmp: Employee,
  partnerAssignmentIndex: number,
  weekState: WeekState,
  deps: ResolverDeps
): SwapOperation | null {
  const partner = weekState.assignments[partnerAssignmentIndex];
  if (!partner) return null;
  const partnerSlot = slotForAssignment(partner, deps.canvasSlots);
  if (!partnerSlot) return null;

  // Step B/C: direct swap candidates, picking the one with lowest hours variance.
  let bestSwap: { op: SwapOperation; variance: number } | null = null;

  // We always attempt to move the partner first via a single-hop swap. The cascade
  // path (tryCascadeFrom) handles cases where no direct swap is viable.
  const moverEmp = deps.employeeById.get(partner.employee_id);
  if (!moverEmp) return null;

  for (let i = 0; i < weekState.assignments.length; i++) {
    const otherAssign = weekState.assignments[i];
    if (i === partnerAssignmentIndex) continue;
    // Don't swap to a slot on the same shift instance (defeats the purpose).
    const otherSlot = slotForAssignment(otherAssign, deps.canvasSlots);
    if (!otherSlot) continue;
    if (otherSlot.date === targetSlot.date && otherSlot.shift_name === targetSlot.shift_name) continue;

    const otherEmp = deps.employeeById.get(otherAssign.employee_id);
    if (!otherEmp) continue;

    // partner ↔ otherAssign: partner takes otherSlot, otherEmp takes partnerSlot.
    if (!legalToPlace(moverEmp, otherSlot, weekState, deps, i, otherEmp.id)) continue;
    if (!legalToPlace(otherEmp, partnerSlot, weekState, deps, partnerAssignmentIndex, moverEmp.id)) continue;
    // After this swap, proposedEmp can take targetSlot (partner is gone).
    if (!legalToPlace(proposedEmp, targetSlot, weekState, deps, partnerAssignmentIndex, partner.employee_id)) continue;
    const op: SwapOperation = {
      kind: 'swap',
      moves: [
        { assignment_index: partnerAssignmentIndex, new_employee_id: otherEmp.id, new_employee_name: otherEmp.name },
        { assignment_index: i, new_employee_id: moverEmp.id, new_employee_name: moverEmp.name },
      ],
    };
    const variance = hoursVarianceAfter(weekState, [
      { employee_id: partner.employee_id, delta: -partnerSlot.hours },
      { employee_id: otherEmp.id, delta: partnerSlot.hours - otherSlot.hours },
      { employee_id: moverEmp.id, delta: otherSlot.hours },
      { employee_id: proposedEmp.id, delta: targetSlot.hours },
    ]);
    if (!bestSwap || variance < bestSwap.variance) bestSwap = { op, variance };
  }

  if (bestSwap) return bestSwap.op;

  // Step D: cascade. Try moving partner through a chain of legal moves, up to
  // MAX_CASCADE_HOPS hops. Each hop changes one existing assignment.
  interface CascadeNode {
    moves: SwapOperation['moves'];
    blockedIndices: Set<number>;
    state: WeekState;
  }

  function cloneState(s: WeekState): WeekState {
    return {
      weeklyHoursMap: new Map(s.weeklyHoursMap),
      assignments: s.assignments.map(a => ({ ...a })),
      gaps: s.gaps,
      flagged_issues: s.flagged_issues,
    };
  }

  function applyMove(state: WeekState, assignmentIndex: number, newEmp: Employee): WeekState {
    const next = cloneState(state);
    const prev = next.assignments[assignmentIndex];
    const slot = slotForAssignment(prev, deps.canvasSlots);
    if (!slot) return next;
    next.weeklyHoursMap.set(prev.employee_id, (next.weeklyHoursMap.get(prev.employee_id) ?? 0) - slot.hours);
    next.weeklyHoursMap.set(newEmp.id, (next.weeklyHoursMap.get(newEmp.id) ?? 0) + slot.hours);
    next.assignments[assignmentIndex] = {
      ...prev,
      employee_id: newEmp.id,
      employee_name: newEmp.name,
    };
    return next;
  }

  // Cascade starts by removing partner from partnerAssignmentIndex; we
  // search for a chain that ends in a slot where a free employee can land.
  const startState = weekState;
  const startNode: CascadeNode = {
    moves: [],
    blockedIndices: new Set([partnerAssignmentIndex]),
    state: startState,
  };

  // BFS/DFS bounded by hop count. We seek a chain where the final move is
  // placing a brand-new employee (not previously assigned to anything in the
  // chain) into the displaced slot.
  function tryCascadeFrom(node: CascadeNode, displacedIndex: number, hop: number): SwapOperation | null {
    if (hop > MAX_CASCADE_HOPS) return null;
    const displaced = node.state.assignments[displacedIndex];
    const displacedSlot = slotForAssignment(displaced, deps.canvasSlots);
    if (!displacedSlot) return null;

    // Find any employee who can step into displacedSlot legally.
    const replacementCandidates = deps.employees.filter(
      e => e.id !== displaced.employee_id &&
        legalToPlace(e, displacedSlot, node.state, deps, displacedIndex, displaced.employee_id)
    );

    for (const cand of replacementCandidates) {
      // Is candidate currently assigned somewhere? If so, this is another hop.
      const candAssignIdx = node.state.assignments.findIndex(a => a.employee_id === cand.id);
      const isFree = candAssignIdx === -1 || node.blockedIndices.has(candAssignIdx);

      if (isFree) {
        // Terminal move — candidate takes displaced slot. Now also need to
        // place proposedEmp at targetSlot. Check legality in the resulting state.
        const finalState = applyMove(node.state, displacedIndex, cand);
        if (!legalToPlace(proposedEmp, targetSlot, finalState, deps, partnerAssignmentIndex, partner.employee_id)) {
          continue;
        }
        return {
          kind: 'cascade',
          moves: [
            ...node.moves,
            { assignment_index: displacedIndex, new_employee_id: cand.id, new_employee_name: cand.name },
          ],
        };
      }

      // Hop: candidate is currently assigned elsewhere. Try cascading further.
      const nextState = applyMove(node.state, displacedIndex, cand);
      const nextNode: CascadeNode = {
        moves: [
          ...node.moves,
          { assignment_index: displacedIndex, new_employee_id: cand.id, new_employee_name: cand.name },
        ],
        blockedIndices: new Set([...node.blockedIndices, candAssignIdx]),
        state: nextState,
      };
      const result = tryCascadeFrom(nextNode, candAssignIdx, hop + 1);
      if (result) return result;
    }
    return null;
  }

  // The starting hop displaces partner; partner's slot is the first to refill.
  const cascadeResult = tryCascadeFrom(startNode, partnerAssignmentIndex, 1);
  return cascadeResult;
}
