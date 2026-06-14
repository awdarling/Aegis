import { describe, it, expect } from 'vitest';
import {
  ruleAppliesOnDate,
  veteranTargetsForGroup,
  type EngineExperienceRule,
} from '../experience-rules';

const baseRule = (over: Partial<EngineExperienceRule> = {}): EngineExperienceRule => ({
  shift_type_id: 'st-pm',
  days_of_week: null,
  role: null,
  mode: 'all_veterans',
  min_count: null,
  season_start: null,
  season_end: null,
  active: true,
  ...over,
});

describe('ruleAppliesOnDate', () => {
  it('matches when shift + date are in scope', () => {
    expect(ruleAppliesOnDate(baseRule(), '2026-06-13', 'st-pm')).toBe(true);
  });

  it('ignores inactive rules', () => {
    expect(ruleAppliesOnDate(baseRule({ active: false }), '2026-06-13', 'st-pm')).toBe(false);
  });

  it('respects shift_type scope (null = any shift)', () => {
    expect(ruleAppliesOnDate(baseRule({ shift_type_id: 'st-am' }), '2026-06-13', 'st-pm')).toBe(false);
    expect(ruleAppliesOnDate(baseRule({ shift_type_id: null }), '2026-06-13', 'st-pm')).toBe(true);
  });

  it('respects the season window', () => {
    const summer = baseRule({ season_start: '2026-06-01', season_end: '2026-08-31' });
    expect(ruleAppliesOnDate(summer, '2026-05-31', 'st-pm')).toBe(false); // before
    expect(ruleAppliesOnDate(summer, '2026-06-13', 'st-pm')).toBe(true);  // within
    expect(ruleAppliesOnDate(summer, '2026-09-01', 'st-pm')).toBe(false); // after
  });

  it('respects days_of_week (Saturday only)', () => {
    const satOnly = baseRule({ days_of_week: [6] });
    expect(ruleAppliesOnDate(satOnly, '2026-06-13', 'st-pm')).toBe(true);  // Saturday
    expect(ruleAppliesOnDate(satOnly, '2026-06-14', 'st-pm')).toBe(false); // Sunday
  });
});

describe('veteranTargetsForGroup', () => {
  const group = [
    { index: 0, role: 'Lifeguard' },
    { index: 1, role: 'Lifeguard' },
    { index: 2, role: 'Headguard' },
  ];

  it('all_veterans needs every covered position', () => {
    const t = veteranTargetsForGroup([baseRule({ mode: 'all_veterans' })], '2026-06-13', 'st-pm', group);
    expect(t).toEqual([{ indices: [0, 1, 2], need: 3, mode: 'all_veterans' }]);
  });

  it('min_veterans needs min_count, capped at positions', () => {
    const t = veteranTargetsForGroup([baseRule({ mode: 'min_veterans', min_count: 2 })], '2026-06-13', 'st-pm', group);
    expect(t).toEqual([{ indices: [0, 1, 2], need: 2, mode: 'min_veterans' }]);
    // min_count larger than positions is capped
    const t2 = veteranTargetsForGroup([baseRule({ mode: 'min_veterans', min_count: 9 })], '2026-06-13', 'st-pm', group);
    expect(t2[0].need).toBe(3);
  });

  it('role-scoped rule only covers that role', () => {
    const t = veteranTargetsForGroup([baseRule({ role: 'Lifeguard', mode: 'all_veterans' })], '2026-06-13', 'st-pm', group);
    expect(t).toEqual([{ indices: [0, 1], need: 2, mode: 'all_veterans' }]);
  });

  it('produces no target when nothing applies', () => {
    expect(veteranTargetsForGroup([baseRule({ days_of_week: [0] })], '2026-06-13', 'st-pm', group)).toEqual([]);
    expect(veteranTargetsForGroup([], '2026-06-13', 'st-pm', group)).toEqual([]);
  });
});
