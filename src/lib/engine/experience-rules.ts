// Pure logic for shift experience (veteran) requirements.
//
// A rule says a shift must be staffed by veterans — ALL of them or a MINIMUM
// count — optionally scoped to a season window, specific days of the week, and
// a role within the shift. These helpers decide which rules apply to a given
// (date, shift) and how many veterans each requires among the filled positions.
// No I/O, no engine state — unit-tested.

export interface EngineExperienceRule {
  shift_type_id: string | null;
  days_of_week: number[] | null;
  role: string | null;
  mode: 'all_veterans' | 'min_veterans';
  min_count: number | null;
  season_start: string | null;
  season_end: string | null;
  active: boolean;
}

// Does this rule apply to a shift of `shift_type_id` on `date` (YYYY-MM-DD)?
export function ruleAppliesOnDate(
  rule: EngineExperienceRule,
  date: string,
  shiftTypeId: string
): boolean {
  if (!rule.active) return false;
  if (rule.shift_type_id && rule.shift_type_id !== shiftTypeId) return false;
  if (rule.season_start && date < rule.season_start) return false;
  if (rule.season_end && date > rule.season_end) return false;
  if (rule.days_of_week && rule.days_of_week.length > 0) {
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (!rule.days_of_week.includes(dow)) return false;
  }
  return true;
}

// One veteran requirement to enforce against a subset of a shift's filled
// positions: `need` veterans among the positions at `indices`.
export interface VeteranTarget {
  indices: number[];
  need: number;
  mode: 'all_veterans' | 'min_veterans';
}

// Given the rules and the positions filled on one (date, shift), produce the
// veteran targets to enforce. Role-scoped rules apply only to that role's
// positions; "all_veterans" needs every covered position to be a veteran;
// "min_veterans" needs min_count (capped at the number of covered positions).
export function veteranTargetsForGroup(
  rules: EngineExperienceRule[],
  date: string,
  shiftTypeId: string,
  groupAssignments: { index: number; role: string }[]
): VeteranTarget[] {
  const targets: VeteranTarget[] = [];
  for (const rule of rules) {
    if (!ruleAppliesOnDate(rule, date, shiftTypeId)) continue;
    const subset = rule.role
      ? groupAssignments.filter(a => a.role === rule.role)
      : groupAssignments;
    if (subset.length === 0) continue;
    const indices = subset.map(a => a.index);
    const need =
      rule.mode === 'all_veterans'
        ? indices.length
        : Math.max(1, Math.min(rule.min_count ?? 1, indices.length));
    targets.push({ indices, need, mode: rule.mode });
  }
  return targets;
}
