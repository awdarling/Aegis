import type { Policy } from '../../db/types';
import {
  DEFAULT_ENGINE_SETTINGS,
  type AttributeMixConstraint,
  type ConcurrentCoverageConstraint,
  type EngineSettings,
  type ParsedConstraints,
} from './types';

// Recognized policy_keys. A key not in this set is dropped without log noise.
//
// These sets are EXPORTED and are the SINGLE vocabulary for the engine policy
// family. Any writer that sets an engine policy (Aegis manager email-edit via
// src/lib/policy-write.ts, Soteria, the Homebase UI) must validate against
// THESE sets — never against a hand-copied list. A second copy of this
// vocabulary is how a policy ends up written to a key the engine drops.
export const ATTRIBUTE_MIX_KEYS = new Set([
  'attribute_mix',
  'minimum_attribute_mix',
  'gender_requirement',
  'minimum_gender_requirement',
  'sex_requirement',
]);

export const HOURS_FAIRNESS_KEYS = new Set([
  'hours_fairness_weight',
  'fairness_weight',
]);

// SCAFFOLDING (drift D11, 2026-07-13). partial_shifts and conflict_resolution
// were removed from every USER surface (Homebase Rules UI, Soteria vocabulary,
// Aegis email) because the engine never acted on them. The keys are KEPT here so
// the parser still recognises any legacy DB rows without noise, and so
// re-enabling the feature is "wire the reader", not "rebuild the plumbing".
// NOTHING in the engine currently consults settings.partialShiftsAllowed or
// settings.conflictResolution — see EngineSettings in ./types.
export const PARTIAL_SHIFTS_KEYS = new Set([
  'partial_shifts_allowed',
  'allow_partial_shifts',
]);

export const VETERAN_DEFAULT_KEYS = new Set([
  'veteran_preference_default',
  'veteran_default',
]);

export const DOUBLES_POLICY_KEYS = new Set([
  'doubles_policy',
  'double_shifts',
]);

export const CONFLICT_RES_KEYS = new Set([
  'conflict_resolution_preference',
  'conflict_resolution',
]);

export const WEEK_START_KEYS = new Set([
  'week_start_day',
  'first_day_of_week',
]);

export const MAX_CONSECUTIVE_DAYS_KEYS = new Set([
  'max_consecutive_days_worked',
  'max_consecutive_days',
  'max_consecutive_work_days',
]);

export const ALL_RECOGNIZED = new Set<string>([
  ...ATTRIBUTE_MIX_KEYS,
  ...HOURS_FAIRNESS_KEYS,
  ...PARTIAL_SHIFTS_KEYS,
  ...VETERAN_DEFAULT_KEYS,
  ...DOUBLES_POLICY_KEYS,
  ...CONFLICT_RES_KEYS,
  ...WEEK_START_KEYS,
  ...MAX_CONSECUTIVE_DAYS_KEYS,
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

type AttributeMixOrCoverage = AttributeMixConstraint | ConcurrentCoverageConstraint;

function parseAttributeMix(value: unknown): AttributeMixOrCoverage | string {
  if (!isPlainObject(value)) return 'value is not an object';
  const attribute = value['attribute'];
  if (typeof attribute !== 'string' || attribute.length === 0) {
    return 'missing or invalid `attribute` field';
  }
  const minsRaw = value['minimums'];
  if (!isPlainObject(minsRaw)) return 'missing or invalid `minimums` field';
  const minimums: Record<string, number> = {};
  for (const [k, v] of Object.entries(minsRaw)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      return `minimums.${k} is not a non-negative number`;
    }
    minimums[k] = Math.floor(v);
  }
  const scopeRaw = value['scope'];

  // concurrent_coverage routes to a separate constraint family — no
  // scope_target, requires population_roles, evaluated as a temporal flag.
  if (scopeRaw === 'concurrent_coverage') {
    const popRaw = value['population_roles'];
    if (!Array.isArray(popRaw) || popRaw.some(r => typeof r !== 'string' || r.length === 0)) {
      return 'concurrent_coverage requires `population_roles` as a non-empty array of strings';
    }
    const population_roles = (popRaw as string[]).slice();
    if (population_roles.length === 0) {
      return 'concurrent_coverage requires at least one role in `population_roles`';
    }
    const onInfRaw = value['on_infeasible'];
    let on_infeasible: ConcurrentCoverageConstraint['on_infeasible'] = 'flag';
    if (onInfRaw !== undefined && onInfRaw !== null) {
      if (onInfRaw !== 'flag') {
        return `concurrent_coverage on_infeasible: only 'flag' is supported (got ${String(onInfRaw)})`;
      }
      on_infeasible = onInfRaw;
    }
    return {
      type: 'concurrent_coverage',
      attribute,
      minimums,
      population_roles,
      on_infeasible,
    };
  }

  let scope: AttributeMixConstraint['scope'] = 'all_shifts';
  if (typeof scopeRaw === 'string') {
    if (scopeRaw === 'all_shifts' || scopeRaw === 'shift_type' || scopeRaw === 'specific_shift') {
      scope = scopeRaw;
    } else {
      return `invalid scope: ${scopeRaw}`;
    }
  }
  const scopeTarget = value['scope_target'];
  if (scope !== 'all_shifts' && typeof scopeTarget !== 'string') {
    return `scope ${scope} requires string scope_target`;
  }
  return {
    type: 'attribute_mix',
    attribute,
    minimums,
    scope,
    scope_target: typeof scopeTarget === 'string' ? scopeTarget : undefined,
  };
}

function parseNumberInRange(value: unknown, min: number, max: number): number | string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < min || value > max) return `out of range [${min}, ${max}]`;
    return value;
  }
  if (isPlainObject(value) && typeof value['value'] === 'number') {
    return parseNumberInRange(value['value'], min, max);
  }
  return 'not a number';
}

// Same shape as parseNumberInRange but rejects non-integers. Used by the
// max_consecutive_days_worked parser — a fractional cap is meaningless on a
// per-day counter.
function parseIntegerInRange(value: unknown, min: number, max: number): number | string {
  const n = parseNumberInRange(value, min, max);
  if (typeof n === 'string') return n;
  if (!Number.isInteger(n)) return 'not an integer';
  return n;
}

function parseBool(value: unknown): boolean | string {
  if (typeof value === 'boolean') return value;
  if (isPlainObject(value) && typeof value['value'] === 'boolean') return value['value'] as boolean;
  return 'not a boolean';
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[]): T | string {
  let candidate: unknown = value;
  if (isPlainObject(value) && typeof value['value'] === 'string') candidate = value['value'];
  if (typeof candidate !== 'string') return 'not a string';
  if (!(allowed as readonly string[]).includes(candidate)) {
    return `not one of: ${allowed.join(', ')}`;
  }
  return candidate as T;
}

// Permissive on unknown policy_keys, strict on known ones. Defaults are
// applied for any EngineSettings field not provided. Returns ParsedConstraints
// with a list of rows that were recognized but malformed.
export function parseConstraints(policies: Policy[]): ParsedConstraints {
  const attributeMix: AttributeMixConstraint[] = [];
  const concurrentCoverage: ConcurrentCoverageConstraint[] = [];
  const settings: EngineSettings = { ...DEFAULT_ENGINE_SETTINGS };
  const unrecognized: Array<{ policy_id: string; policy_key: string; reason: string }> = [];

  for (const row of policies) {
    const key = row.policy_key;
    if (!ALL_RECOGNIZED.has(key)) {
      const reason = 'unknown_key';
      unrecognized.push({ policy_id: row.id, policy_key: key, reason });
      console.log(`[constraints] unknown policy_key dropped: ${key} (id=${row.id})`);
      continue;
    }

    const valJson = (row as Policy & { policy_value_json?: unknown }).policy_value_json;
    if (valJson === undefined || valJson === null) {
      const reason = 'null_json';
      unrecognized.push({ policy_id: row.id, policy_key: key, reason });
      console.log('[constraints] dropped policy', row.id, key, '— policy_value_json is null; text policy_value is not consulted by the engine parser');
      continue;
    }

    if (ATTRIBUTE_MIX_KEYS.has(key)) {
      const parsed = parseAttributeMix(valJson);
      if (typeof parsed === 'string') {
        unrecognized.push({ policy_id: row.id, policy_key: key, reason: parsed });
        console.log('[constraints] invalid attribute_mix policy', row.id, key, '—', parsed);
      } else if (parsed.type === 'concurrent_coverage') {
        concurrentCoverage.push(parsed);
      } else {
        attributeMix.push(parsed);
      }
      continue;
    }

    if (HOURS_FAIRNESS_KEYS.has(key)) {
      const parsed = parseNumberInRange(valJson, 0, 1);
      if (typeof parsed === 'string') {
        unrecognized.push({ policy_id: row.id, policy_key: key, reason: parsed });
        console.log('[constraints] invalid hours_fairness_weight', row.id, '—', parsed);
      } else {
        settings.hoursFairnessWeight = parsed;
      }
      continue;
    }

    if (PARTIAL_SHIFTS_KEYS.has(key)) {
      const parsed = parseBool(valJson);
      if (typeof parsed === 'string') {
        unrecognized.push({ policy_id: row.id, policy_key: key, reason: parsed });
        console.log('[constraints] invalid partial_shifts_allowed', row.id, '—', parsed);
      } else {
        settings.partialShiftsAllowed = parsed;
      }
      continue;
    }

    if (VETERAN_DEFAULT_KEYS.has(key)) {
      const parsed = parseEnum(valJson, ['none', 'prioritize', 'at_least_one', 'only'] as const);
      if (typeof parsed === 'string' && !['none', 'prioritize', 'at_least_one', 'only'].includes(parsed)) {
        unrecognized.push({ policy_id: row.id, policy_key: key, reason: parsed });
        console.log('[constraints] invalid veteran_preference_default', row.id, '—', parsed);
      } else {
        settings.veteranPreferenceDefault = parsed as EngineSettings['veteranPreferenceDefault'];
      }
      continue;
    }

    if (DOUBLES_POLICY_KEYS.has(key)) {
      const parsed = parseEnum(valJson, ['never', 'emergency_only', 'allow'] as const);
      if (typeof parsed === 'string' && !['never', 'emergency_only', 'allow'].includes(parsed)) {
        unrecognized.push({ policy_id: row.id, policy_key: key, reason: parsed });
        console.log('[constraints] invalid doubles_policy', row.id, '—', parsed);
      } else {
        settings.doublesPolicy = parsed as EngineSettings['doublesPolicy'];
      }
      continue;
    }

    if (CONFLICT_RES_KEYS.has(key)) {
      const parsed = parseEnum(valJson, ['fairness_first', 'minimize_disruption'] as const);
      if (typeof parsed === 'string' && !['fairness_first', 'minimize_disruption'].includes(parsed)) {
        unrecognized.push({ policy_id: row.id, policy_key: key, reason: parsed });
        console.log('[constraints] invalid conflict_resolution_preference', row.id, '—', parsed);
      } else {
        settings.conflictResolution = parsed as EngineSettings['conflictResolution'];
      }
      continue;
    }

    if (MAX_CONSECUTIVE_DAYS_KEYS.has(key)) {
      // Bound: 1..7 — a build week is 7 days, and a value of 0 would mean
      // "nobody can work any day," which is a configuration error not a
      // policy. Fractional values are rejected.
      const parsed = parseIntegerInRange(valJson, 1, 7);
      if (typeof parsed === 'string') {
        unrecognized.push({ policy_id: row.id, policy_key: key, reason: parsed });
        console.log('[constraints] invalid max_consecutive_days_worked', row.id, '—', parsed);
      } else {
        settings.maxConsecutiveDaysWorked = parsed;
      }
      continue;
    }

    if (WEEK_START_KEYS.has(key)) {
      const parsed = parseEnum(valJson, ['sunday', 'monday'] as const);
      if (typeof parsed === 'string' && !['sunday', 'monday'].includes(parsed)) {
        unrecognized.push({ policy_id: row.id, policy_key: key, reason: parsed });
        console.log('[constraints] invalid week_start_day', row.id, '—', parsed);
      } else {
        settings.weekStartDay = parsed as EngineSettings['weekStartDay'];
      }
      continue;
    }
  }

  return {
    hard: { attributeMix, concurrentCoverage },
    settings,
    unrecognized,
  };
}
