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

  // FAIRNESS-1 — the hours that drive fairness are this week's hours PLUS the
  // employee's decayed hours from recent prior weeks (weekState.priorHoursMap).
  // Folding in recent history is what stops the same people topping the
  // schedule every week. priorHoursMap is empty for seedless/legacy callers, so
  // this reduces to the old within-week behavior when there's no memory.
  function combinedHours(id: string): number {
    return (weekState.weeklyHoursMap.get(id) ?? 0) + (weekState.priorHoursMap?.get(id) ?? 0);
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
      const h = combinedHours(p.id);
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
    const h = combinedHours(e.id);
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

    // FAIRNESS-1 — final tiebreaker. Everything above (qualification, avoid
    // conflicts, fairness, veteran preference) is UNCHANGED and still decides
    // first; this only orders candidates the engine considers equally good.
    // With a per-build seed, rotate them pseudo-randomly so rebuilding the same
    // week produces a different valid schedule and coworkers vary week to week.
    // Deterministic per (id, seed); falls back to alphabetical when no seed is
    // supplied so seedless callers and tests stay stable.
    const seed = weekState.tieBreakSeed;
    if (seed) {
      const ha = tieHash(a.id, seed);
      const hb = tieHash(b.id, seed);
      if (ha !== hb) return ha - hb;
    }

    return a.name.localeCompare(b.name);
  });

  return ranked;
}

// Deterministic 32-bit hash of `${id}:${seed}` (FNV-1a). Used ONLY to rotate
// otherwise-equal candidates in the ranker's final tiebreaker — never for
// anything security-sensitive. Same id+seed always yields the same value, so a
// build is reproducible given its seed; different seeds reshuffle ties.
function tieHash(id: string, seed: string): number {
  const s = `${id}:${seed}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
