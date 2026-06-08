// Constraint vocabulary recognized by the schedule engine.
//
// The set is intentionally finite. Unknown policy_keys are dropped silently
// by the parser; malformed values for known keys are logged. The engine
// itself only consults values produced through this module — it never reads
// raw policy rows.

export type ConstraintType =
  | 'attribute_mix'
  | 'hours_fairness_weight'
  | 'partial_shifts_allowed'
  | 'veteran_preference_default'
  | 'doubles_policy'
  | 'conflict_resolution_preference';

// Hard constraint: at least N employees with a given attribute value must be
// present on each shift in scope. `attribute` is the employee field (e.g.
// 'sex', 'is_veteran') and `minimums` maps attribute values to required
// counts. For booleans the keys are 'true' / 'false'.
export interface AttributeMixConstraint {
  type: 'attribute_mix';
  attribute: string;
  minimums: Record<string, number>;
  scope: 'all_shifts' | 'shift_type' | 'specific_shift';
  scope_target?: string;
}

// Facility-wide temporal coverage. Evaluated over the day's timeline segmented
// at shift start/end boundaries, restricted to assignments whose role is in
// `population_roles`. Validate-and-flag only — never swaps. on_infeasible is
// reserved for future modes; today only 'flag' is supported.
export interface ConcurrentCoverageConstraint {
  type: 'concurrent_coverage';
  attribute: string;
  minimums: Record<string, number>;
  population_roles: string[];
  on_infeasible: 'flag';
}

// Engine settings derived from policy rows. Defaults are applied by the
// parser; downstream code can rely on every field being set.
export interface EngineSettings {
  hoursFairnessWeight: number;
  partialShiftsAllowed: boolean;
  veteranPreferenceDefault: 'none' | 'prioritize' | 'at_least_one' | 'only';
  doublesPolicy: 'never' | 'emergency_only' | 'allow';
  conflictResolution: 'fairness_first' | 'minimize_disruption';
  weekStartDay: 'sunday' | 'monday';
}

export interface ParsedConstraints {
  hard: {
    attributeMix: AttributeMixConstraint[];
    concurrentCoverage: ConcurrentCoverageConstraint[];
  };
  settings: EngineSettings;
  unrecognized: Array<{ policy_id: string; policy_key: string; reason: string }>;
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  hoursFairnessWeight: 0.7,
  partialShiftsAllowed: false,
  veteranPreferenceDefault: 'none',
  doublesPolicy: 'never',
  conflictResolution: 'fairness_first',
  weekStartDay: 'sunday',
};
