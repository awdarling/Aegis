import { describe, it, expect } from 'vitest';

// policy-write is deliberately PURE — it imports only the parser's exported key
// sets. No env, no Supabase, no mocks. That is what makes the canonical write
// path cheap to test exhaustively, which is the whole reason it exists.
import { coercePolicyWrite, isWritablePolicyKey, TIME_OFF_POLICY_KEYS } from '../policy-write';
import { parseConstraints } from '../constraints/parser';
import type { Policy } from '../../db/types';

// Build the row the way coercePolicyWrite says to, then hand it to the REAL
// engine parser. This is the regression guard for D1: it proves the writer and
// the reader agree. A test that only asserted the patch shape would pass even
// if the engine ignored the column.
function enginePolicyRow(policy_key: string, patch: Record<string, unknown>): Policy {
  return {
    id: `id-${policy_key}`,
    company_id: 'c1',
    policy_key,
    policy_value: String(patch.policy_value ?? ''),
    policy_type: 'custom',
    policy_value_json: patch.policy_value_json,
  } as unknown as Policy;
}

describe('coercePolicyWrite — engine family (canonical column = policy_value_json)', () => {
  it('doubles_policy: writes the JSON column and the engine reads it back', () => {
    const r = coercePolicyWrite('doubles_policy', 'never');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.family).toBe('engine');
    expect(r.patch.policy_value_json).toBe('never');

    const parsed = parseConstraints([enginePolicyRow('doubles_policy', r.patch)]);
    expect(parsed.settings.doublesPolicy).toBe('never');
    expect(parsed.unrecognized).toHaveLength(0);
  });

  it('accepts the manager\'s natural phrasing, not just the enum literal', () => {
    for (const [said, want] of [
      ['Never', 'never'],
      ['no doubles'.replace('no doubles', 'no'), 'never'],
      ['only in emergencies', 'emergency_only'],
      ['emergencies only', 'emergency_only'],
      ['Allowed', 'allow'],
    ] as const) {
      const r = coercePolicyWrite('doubles_policy', said);
      expect(r.ok, `"${said}" should coerce`).toBe(true);
      if (r.ok) expect(r.patch.policy_value_json).toBe(want);
    }
  });

  it('REFUSES partial_shifts and conflict_resolution — removed from the user surface (D11)', () => {
    // These were settable but read by nothing. Aegis must decline rather than
    // confirm a rule it can't honour. The parser still RECOGNISES the keys
    // (scaffolding), so this is purely about the write surface.
    for (const key of ['partial_shifts_allowed', 'allow_partial_shifts', 'conflict_resolution_preference', 'conflict_resolution']) {
      const r = coercePolicyWrite(key, 'yes');
      expect(r.ok, `${key} should be refused`).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/roadmap|doesn't act on it|shouldn't work together/i);
    }
  });

  it('week_start_day / veteran_preference / fairness / max-consecutive all round-trip through the parser', () => {
    const cases: Array<[string, unknown, (p: ReturnType<typeof parseConstraints>) => unknown, unknown]> = [
      ['week_start_day', 'Sunday', p => p.settings.weekStartDay, 'sunday'],
      ['veteran_preference_default', 'prioritize', p => p.settings.veteranPreferenceDefault, 'prioritize'],
      ['hours_fairness_weight', '0.8', p => p.settings.hoursFairnessWeight, 0.8],
      ['max_consecutive_days_worked', '5', p => p.settings.maxConsecutiveDaysWorked, 5],
    ];
    for (const [key, said, pick, want] of cases) {
      const r = coercePolicyWrite(key, said);
      expect(r.ok, `${key} should coerce`).toBe(true);
      if (!r.ok) continue;
      const parsed = parseConstraints([enginePolicyRow(key, r.patch)]);
      expect(pick(parsed), `${key} should reach the engine`).toEqual(want);
      expect(parsed.unrecognized, `${key} should not be dropped`).toHaveLength(0);
    }
  });

  it('"80" for a 0..1 weight is read as 80%, not rejected and not stored as 80', () => {
    const r = coercePolicyWrite('hours_fairness_weight', '80');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch.policy_value_json).toBe(0.8);
  });

  it('rejects values the engine parser would silently DROP (out of range)', () => {
    // 9 > the parser's 1..7 bound. If we wrote it, parseConstraints would push
    // it to `unrecognized` and quietly fall back to the default — the manager
    // would think the rule changed. Bounce it instead.
    const r = coercePolicyWrite('max_consecutive_days_worked', '9');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/1 to 7/);
  });

  it('refuses attribute_mix / gender_requirement rather than guessing a structured object', () => {
    for (const key of ['attribute_mix', 'gender_requirement', 'sex_requirement']) {
      const r = coercePolicyWrite(key, '1 male and 1 female');
      expect(r.ok, `${key} must not be set from free text`).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/Homebase/);
    }
  });

  it('refuses a policy_key no reader consults (would be configured-but-inert)', () => {
    const r = coercePolicyWrite('vibes_policy', 'chill');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/isn't a rule the scheduling engine reads/);
  });
});

describe('coercePolicyWrite — time-off family (canonical column = TEXT policy_value)', () => {
  // The bug this class of test exists to prevent: writing the time-off family
  // the way the engine family is written. loadTimeOffPolicies() does
  //   .eq('policy_type','time_off')  →  parseInt10(policy_value)
  // so a human display string, or a lost policy_type, silently DISABLES the rule.

  it('writes a BARE NUMBER into policy_value, not prose', () => {
    const r = coercePolicyWrite('min_notice_period_days', '14 days');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.family).toBe('time_off');
    expect(r.patch.policy_value).toBe('14');
    // parseInt10, the actual reader, must get 14 back.
    expect(parseInt(String(r.patch.policy_value), 10)).toBe(14);
  });

  it('always pins policy_type=\'time_off\' — the loader FILTERS on it', () => {
    for (const key of TIME_OFF_POLICY_KEYS) {
      const r = coercePolicyWrite(key, '7');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.patch.policy_type, `${key} must keep policy_type`).toBe('time_off');
    }
  });

  it('does NOT write policy_value_json for the time-off family', () => {
    const r = coercePolicyWrite('max_consecutive_days_off', '10');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch).not.toHaveProperty('policy_value_json');
  });

  it('refuses English numerals instead of guessing (a wrong number would be silently enforced)', () => {
    const r = coercePolicyWrite('min_notice_period_days', 'two weeks');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/plain number/);
  });

  it('refuses prose that would parse to NaN and switch the rule OFF', () => {
    // The exact regression: a display string like "Two weeks" → parseInt10 →
    // NaN → null → loadTimeOffPolicies reports "no limit configured".
    for (const bad of ['Two weeks', 'a fortnight', 'ASAP', '']) {
      expect(coercePolicyWrite('min_notice_period_days', bad).ok, `"${bad}"`).toBe(false);
    }
  });
});

describe('isWritablePolicyKey', () => {
  it('covers both families and nothing else', () => {
    expect(isWritablePolicyKey('doubles_policy')).toBe(true);
    expect(isWritablePolicyKey('min_notice_period_days')).toBe(true);
    expect(isWritablePolicyKey('made_up_key')).toBe(false);
  });
});
