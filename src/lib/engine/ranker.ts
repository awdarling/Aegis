import type { Employee, EmployeeConflict } from '../../db/types';
import type { EngineSettings } from '../constraints/types';
import type { VeteranMode } from '../../workflows/schedule-build';
import type { CanvasSlot, WeekState } from './types';

// Returns a new array sorted in selection preference order, best candidate
// first. Sort keys (in order):
//   1. Primary-role match.
//   2. No soft avoid-conflict with already-assigned staff.
//   3. Fewest weekly hours within peer group (employees sharing this primary
//      role). The fairness weight from settings.hoursFairnessWeight scales
//      the impact of this key against the others — at 0 it becomes a pure
//      tiebreaker, at 1 it dominates everything below it.
//   4. Veteran preference (when veteranMode === 'prioritize').
//   5. Name alphabetical (deterministic final tiebreaker).
export function rankCandidates(
  pool: Employee[],
  slot: CanvasSlot,
  weekState: WeekState,
  conflicts: EmployeeConflict[],
  settings: EngineSettings,
  veteranMode: VeteranMode
): Employee[] {
  const assignedToShift = weekState.assignments
    .filter(a => a.date === slot.date && a.shift_name === slot.shift_name)
    .map(a => a.employee_id);

  const avoidIds = new Set<string>();
  for (const assignedId of assignedToShift) {
    for (const c of conflicts) {
      if (c.severity !== 'avoid') continue;
      if (c.employee_id_1 === assignedId) avoidIds.add(c.employee_id_2);
      else if (c.employee_id_2 === assignedId) avoidIds.add(c.employee_id_1);
    }
  }

  // Peer group min/max for fairness normalization. Peers are employees in
  // the candidate pool sharing the primary_role of each ranked employee.
  // We compute per-candidate during sort.
  const peerHoursCache = new Map<string, { min: number; max: number }>();
  function peerStats(role: string): { min: number; max: number } {
    const cached = peerHoursCache.get(role);
    if (cached) return cached;
    const peers = pool.filter(p => p.primary_role === role);
    let min = Infinity;
    let max = -Infinity;
    for (const p of peers) {
      const h = weekState.weeklyHoursMap.get(p.id) ?? 0;
      if (h < min) min = h;
      if (h > max) max = h;
    }
    if (peers.length === 0 || min === Infinity) { min = 0; max = 0; }
    peerHoursCache.set(role, { min, max });
    return { min, max };
  }

  function fairnessScore(e: Employee): number {
    const { min, max } = peerStats(e.primary_role);
    const range = max - min;
    if (range <= 0) return 0;
    const h = weekState.weeklyHoursMap.get(e.id) ?? 0;
    return (h - min) / range;
  }

  const ranked = [...pool];
  ranked.sort((a, b) => {
    const aPrimary = a.primary_role === slot.role ? 0 : 1;
    const bPrimary = b.primary_role === slot.role ? 0 : 1;
    if (aPrimary !== bPrimary) return aPrimary - bPrimary;

    const aAvoid = avoidIds.has(a.id) ? 1 : 0;
    const bAvoid = avoidIds.has(b.id) ? 1 : 0;
    if (aAvoid !== bAvoid) return aAvoid - bAvoid;

    const w = settings.hoursFairnessWeight;
    const fa = fairnessScore(a) * w;
    const fb = fairnessScore(b) * w;
    if (fa !== fb) return fa - fb;

    if (veteranMode === 'prioritize') {
      const aVet = a.is_veteran ? 0 : 1;
      const bVet = b.is_veteran ? 0 : 1;
      if (aVet !== bVet) return aVet - bVet;
    }

    return a.name.localeCompare(b.name);
  });

  return ranked;
}
