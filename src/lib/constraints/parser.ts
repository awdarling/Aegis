import type { Policy } from '../../db/types';
import {
  DEFAULT_ENGINE_SETTINGS,
  type AttributeMixConstraint,
  type EngineSettings,
  type ParsedConstraints,
} from './types';

// Recognized policy_keys. A key not in this set is dropped without log noise.
const ATTRIBUTE_MIX_KEYS = new Set([
  'attribute_mix',
  'minimum_attribute_mix',
  'gender_requirement',
  'minimum_gender_requirement',
  'sex_requirement',
]);

const HOURS_FAIRNESS_KEYS = new Set([
  'hours_fairness_weight',
  'fairness_weight',
]);

const PARTIAL_SHIFTS_KEYS = new Set([
  'partial_shifts_allowed',
  'allow_partial_shifts',
]);

const VETERAN_DEFAULT_KEYS = new Set([
  'veteran_preference_default',
  'veteran_default',
]);

const DOUBLES_POLICY_KEYS = new Set([
  'doubles_policy',
  'double_shifts',
]);

const CONFLICT_RES_KEYS = new Set([
  'conflict_resolution_preference',
  'conflict_resolution',
]);

const WEEK_START_KEYS = new Set([
  'week_start_day',
  'first_day_of_week',
]);

const ALL_RECOGNIZED = new Set<string>([
  ...ATTRIBUTE_MIX_KEYS,
  ...HOURS_FAIRNESS_KEYS,
  ...PARTIAL_SHIFTS_KEYS,
  ...VETERAN_DEFAULT_KEYS,
  ...DOUBLES_POLICY_KEYS,
  ...CONFLICT_RES_KEYS,
  ...WEEK_START_KEYS,
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseAttributeMix(value: unknown): AttributeMixConstraint | string {
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
    hard: { attributeMix },
    settings,
    unrecognized,
  };
}
