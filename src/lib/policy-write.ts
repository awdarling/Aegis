// ── Canonical policy writer ───────────────────────────────────────────────────
//
// THE PROBLEM THIS SOLVES (drift D1).
// `policies` looks like one table but has TWO reader families with OPPOSITE
// conventions. Get the family wrong and the write lands in a column nobody
// reads — the manager is told "done", and the system keeps enforcing the old
// rule. That is the single worst failure mode in the product.
//
//   FAMILY 1 — ENGINE (scheduling constraints)
//     Reader:    src/lib/constraints/parser.ts  (parseConstraints)
//     Canonical: policies.policy_value_json      ← the ONLY column it reads
//     Ignored:   policy_value (text), policy_type
//     Keys:      the exported *_KEYS sets in constraints/parser.ts
//
//   FAMILY 2 — TIME OFF
//     Reader:    src/lib/time-off-policies.ts   (loadTimeOffPolicies)
//     Canonical: policies.policy_value  ← TEXT, parsed with parseInt10
//     REQUIRED:  policy_type = 'time_off'  — the loader FILTERS on it; get this
//                wrong and the row is not even SELECTed.
//     Ignored:   policy_value_json
//     Keys:      max_consecutive_days_off, min_notice_period_days
//
// Consequence: you can NOT write "a policy" generically. `policy_value` is
// display-only for family 1 and LOAD-BEARING for family 2. A human display
// string like "Two weeks" in family 2 parses to NaN → null → the rule silently
// switches OFF.
//
// Any policy key in NEITHER family is INERT — nothing reads it. We refuse to
// write one rather than let a manager configure a rule that does nothing.
//
// The engine-family key sets are IMPORTED from the parser, never re-declared,
// so the writer and the reader cannot drift apart.

import {
  ALL_RECOGNIZED,
  ATTRIBUTE_MIX_KEYS,
  CONFLICT_RES_KEYS,
  DOUBLES_POLICY_KEYS,
  HOURS_FAIRNESS_KEYS,
  MAX_CONSECUTIVE_DAYS_KEYS,
  PARTIAL_SHIFTS_KEYS,
  VETERAN_DEFAULT_KEYS,
  WEEK_START_KEYS,
} from './constraints/parser';

// Family-2 keys. Mirrors POLICY_KEYS in src/lib/time-off-policies.ts.
export const TIME_OFF_POLICY_KEYS = new Set<string>([
  'max_consecutive_days_off',
  'min_notice_period_days',
]);

export type PolicyPatch = Record<string, unknown>;

export type PolicyWriteResult =
  | { ok: true; family: 'engine' | 'time_off'; patch: PolicyPatch; display: string }
  | { ok: false; reason: string };

function fail(reason: string): PolicyWriteResult {
  return { ok: false, reason };
}

/** Normalize whatever the LLM handed us into a lowercase string for matching. */
function asText(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  return String(raw).trim();
}

function parseBoolish(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  const t = asText(raw).toLowerCase();
  if (['true', 'yes', 'y', 'on', 'enabled', 'enable', 'allow', 'allowed'].includes(t)) return true;
  if (['false', 'no', 'n', 'off', 'disabled', 'disable', 'never', 'not allowed'].includes(t)) return false;
  return null;
}

/**
 * Pull an integer out of a manager's phrasing. Deliberately strict: we take the
 * FIRST run of digits and require the rest to be plausible filler ("14",
 * "14 days"). We do NOT try to read English numerals ("two weeks") — guessing
 * there is how a wrong number gets silently enforced. Better to bounce it.
 */
function parseIntStrict(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null;
  const t = asText(raw);
  const m = /^(\d+)\s*(day|days|d|hours?|shifts?)?$/i.exec(t);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function parseFloatStrict(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const t = asText(raw).replace('%', '');
  if (!/^\d*\.?\d+$/.test(t)) return null;
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return null;
  // "80" for a 0..1 weight is a percentage in disguise.
  return n > 1 && n <= 100 ? n / 100 : n;
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Turn a manager's requested policy value into the exact column patch that the
 * reader for that key will actually consult.
 *
 * @param policyKey  the row's policies.policy_key (NOT the LLM's guess at a column)
 * @param raw        the manager's new value, as parsed from their message
 */
export function coercePolicyWrite(policyKey: string, raw: unknown): PolicyWriteResult {
  const key = (policyKey ?? '').trim().toLowerCase();
  if (!key) return fail('I could not tell which rule you meant.');

  // ── FAMILY 2 — time off. Canonical column is the TEXT one. ────────────────
  if (TIME_OFF_POLICY_KEYS.has(key)) {
    const n = parseIntStrict(raw);
    if (n === null) {
      return fail(
        `"${asText(raw)}" isn't a number of days. Try a plain number — for example "set the ${key.replace(/_/g, ' ')} to 14".`,
      );
    }
    if (n < 0 || n > 365) return fail(`${n} days is out of range — give me a number between 0 and 365.`);
    // policy_value is what loadTimeOffPolicies() reads (parseInt10). It MUST be
    // the bare number, not prose. policy_type MUST stay 'time_off' or the
    // loader's .eq('policy_type','time_off') filter drops the row entirely.
    return {
      ok: true,
      family: 'time_off',
      patch: { policy_value: String(n), policy_type: 'time_off' },
      display: `${n} day${n === 1 ? '' : 's'}`,
    };
  }

  // ── FAMILY 1 — engine constraints. Canonical column is the JSON one. ──────
  if (!ALL_RECOGNIZED.has(key)) {
    return fail(
      `"${policyKey}" isn't a rule the scheduling engine reads, so setting it wouldn't change anything. ` +
        `I can change: doubles policy, week start day, max consecutive days worked, veteran preference, ` +
        `hours fairness weight, time-off notice period, and max consecutive days off.`,
    );
  }

  // attribute_mix / gender_requirement is a STRUCTURED OBJECT (attribute,
  // minimums, scope, population_roles). It cannot be derived from a single
  // free-text value without guessing, and guessing here silently changes who is
  // required on every shift. Bounce it to a surface built for it.
  if (ATTRIBUTE_MIX_KEYS.has(key)) {
    return fail(
      `Coverage-mix rules like "${policyKey}" have too many moving parts to set over email safely ` +
        `(which attribute, which minimums, which roles it applies to). Set that one in Homebase under Rules — ` +
        `I don't want to guess and quietly change who's required on every shift.`,
    );
  }

  if (HOURS_FAIRNESS_KEYS.has(key)) {
    const n = parseFloatStrict(raw);
    if (n === null || n < 0 || n > 1) {
      return fail(`Hours fairness weight has to be between 0 and 1 (e.g. 0.8). I got "${asText(raw)}".`);
    }
    return { ok: true, family: 'engine', patch: { policy_value_json: n, policy_value: n.toFixed(2) }, display: n.toFixed(2) };
  }

  // REMOVED FROM THE USER SURFACE 2026-07-13 (drift D11). partial_shifts and
  // conflict_resolution were settable but read by NOTHING in the engine — a
  // manager could set them and the schedule came out identical. Rather than
  // accept a rule Aegis can't honour, we decline. The parser still RECOGNISES
  // these keys (scaffolding) so re-enabling is wiring the reader, not rebuilding
  // the plumbing. parseBoolish is kept for that day.
  if (PARTIAL_SHIFTS_KEYS.has(key)) {
    return fail(
      `Partial shifts aren't a setting I can change right now — the scheduler doesn't act on it yet, ` +
        `so I'd rather not pretend it's on. It's on the roadmap; for now every shift is filled as a whole.`,
    );
  }

  if (VETERAN_DEFAULT_KEYS.has(key)) {
    const t = asText(raw).toLowerCase().replace(/[\s-]+/g, '_');
    const map: Record<string, string> = {
      none: 'none', off: 'none', no: 'none',
      prioritize: 'prioritize', prefer: 'prioritize', preferred: 'prioritize',
      at_least_one: 'at_least_one', one: 'at_least_one', at_least_1: 'at_least_one',
      only: 'only', all: 'only', all_veterans: 'only', only_veterans: 'only',
    };
    const v = map[t];
    if (!v) return fail(`Veteran preference has to be one of: none, prioritize, at least one, or only. I got "${asText(raw)}".`);
    return { ok: true, family: 'engine', patch: { policy_value_json: v, policy_value: titleCase(v) }, display: titleCase(v) };
  }

  if (DOUBLES_POLICY_KEYS.has(key)) {
    const t = asText(raw).toLowerCase().replace(/[\s-]+/g, '_');
    const map: Record<string, string> = {
      never: 'never', no: 'never', off: 'never', not_allowed: 'never', disallow: 'never', disabled: 'never',
      emergency_only: 'emergency_only', emergencies_only: 'emergency_only', emergency: 'emergency_only',
      only_in_emergencies: 'emergency_only', emergencies: 'emergency_only',
      allow: 'allow', allowed: 'allow', yes: 'allow', on: 'allow', enabled: 'allow',
    };
    const v = map[t];
    if (!v) return fail(`Doubles policy has to be one of: never, emergency only, or allow. I got "${asText(raw)}".`);
    const label: Record<string, string> = { never: 'Never', emergency_only: 'Only in emergencies', allow: 'Allowed' };
    return { ok: true, family: 'engine', patch: { policy_value_json: v, policy_value: label[v] }, display: label[v] };
  }

  // REMOVED FROM THE USER SURFACE 2026-07-13 (drift D11) — see partial_shifts above.
  // The banned-pair CASCADE still runs; what's gone is the unread "fallback mode"
  // knob. Setting banned pairs themselves (D8) is unaffected.
  if (CONFLICT_RES_KEYS.has(key)) {
    return fail(
      `That fallback setting isn't something I can change right now — the scheduler doesn't act on it yet. ` +
        `You can still tell me which people shouldn't work together, and I'll enforce that.`,
    );
  }

  if (WEEK_START_KEYS.has(key)) {
    const t = asText(raw).toLowerCase().replace(/[^a-z]/g, '');
    const v = t.startsWith('sun') ? 'sunday' : t.startsWith('mon') ? 'monday' : null;
    if (!v) return fail(`Week start day has to be Sunday or Monday. I got "${asText(raw)}".`);
    return { ok: true, family: 'engine', patch: { policy_value_json: v, policy_value: titleCase(v) }, display: titleCase(v) };
  }

  if (MAX_CONSECUTIVE_DAYS_KEYS.has(key)) {
    const n = parseIntStrict(raw);
    // Same 1..7 bound the parser enforces. Out of bounds here would be silently
    // dropped there — so we reject it in the manager's face instead.
    if (n === null || n < 1 || n > 7) {
      return fail(`Max consecutive days worked has to be a whole number from 1 to 7. I got "${asText(raw)}".`);
    }
    return {
      ok: true,
      family: 'engine',
      patch: { policy_value_json: n, policy_value: String(n) },
      display: `${n} day${n === 1 ? '' : 's'}`,
    };
  }

  // ALL_RECOGNIZED said yes but no branch claimed it — a key was added to the
  // parser's vocabulary without a writer. Refuse rather than write a stale row.
  return fail(`I don't know how to set "${policyKey}" safely yet — set it in Homebase under Rules.`);
}

/** True if any writer is allowed to touch this key at all. */
export function isWritablePolicyKey(policyKey: string): boolean {
  const key = (policyKey ?? '').trim().toLowerCase();
  return ALL_RECOGNIZED.has(key) || TIME_OFF_POLICY_KEYS.has(key);
}
