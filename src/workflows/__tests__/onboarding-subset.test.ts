import { describe, it, expect } from 'vitest';
import {
  selectOnboardingCandidates,
  isUnfinishedOnboarding,
  humanJoin,
} from '../employee-onboarding';
import type { Employee } from '../../db/types';

// Minimal Employee-ish fixtures (only the fields the selector reads), cast to
// Employee. `sms_consent_state` is the N3 completion signal read via cast.
function emp(
  id: string,
  name: string,
  consent: string | null,
  contact: 'phone' | 'email' | 'none' = 'phone'
): Employee {
  return {
    id,
    name,
    sms_consent_state: consent,
    contact_phone: contact === 'phone' ? '+1555' + id : null,
    contact_email: contact === 'email' ? `${id}@club.com` : null,
  } as unknown as Employee;
}

const jack = emp('jack', 'Jack McCorkle', null); // never opted in → unfinished
const dana = emp('dana', 'Dana Lee', 'confirmed'); // done
const sam = emp('sam', 'Sam Rivera', 'declined'); // opted out → NOT a straggler
const remy = emp('remy', 'Remy Cho', 'resubscribed'); // done
const opal = emp('opal', 'Opal Kim', 'none'); // unfinished
const active = [jack, dana, sam, remy, opal];

describe('isUnfinishedOnboarding', () => {
  it('confirmed / resubscribed = finished', () => {
    expect(isUnfinishedOnboarding(dana)).toBe(false);
    expect(isUnfinishedOnboarding(remy)).toBe(false);
  });
  it('declined / opted_out = deliberately out, not a straggler', () => {
    expect(isUnfinishedOnboarding(sam)).toBe(false);
    expect(isUnfinishedOnboarding(emp('x', 'X', 'opted_out'))).toBe(false);
  });
  it('none / null = unfinished', () => {
    expect(isUnfinishedOnboarding(jack)).toBe(true);
    expect(isUnfinishedOnboarding(opal)).toBe(true);
  });
});

describe('selectOnboardingCandidates', () => {
  it('default (no names, no subset) = whole active team', () => {
    const r = selectOnboardingCandidates({ active });
    expect(r.mode).toBe('all');
    expect(r.candidates).toHaveLength(5);
  });

  it("subset 'unfinished' = only the stragglers (excludes done + declined)", () => {
    const r = selectOnboardingCandidates({ active, subset: 'unfinished' });
    expect(r.mode).toBe('subset');
    expect(r.candidates.map((e) => e.id).sort()).toEqual(['jack', 'opal']);
  });

  it("subset 'all' = whole active team", () => {
    const r = selectOnboardingCandidates({ active, subset: 'all' });
    expect(r.candidates).toHaveLength(5);
  });

  it('explicit names (multi-select), case-insensitive substring, deduped', () => {
    const r = selectOnboardingCandidates({ active, requestedNames: ['jack', 'DANA'] });
    expect(r.mode).toBe('names');
    expect(r.candidates.map((e) => e.id)).toEqual(['jack', 'dana']);
    expect(r.unmatchedNames).toEqual([]);
  });

  it('reports names that matched nobody', () => {
    const r = selectOnboardingCandidates({ active, requestedNames: ['Jack', 'Ghost'] });
    expect(r.candidates.map((e) => e.id)).toEqual(['jack']);
    expect(r.unmatchedNames).toEqual(['Ghost']);
  });

  it('names win over subset when both are provided', () => {
    const r = selectOnboardingCandidates({ active, requestedNames: ['Dana'], subset: 'unfinished' });
    expect(r.mode).toBe('names');
    expect(r.candidates.map((e) => e.id)).toEqual(['dana']);
  });

  it('a name matching two people returns both (deduped by id)', () => {
    const jack2 = emp('jack2', 'Jack Ryan', null);
    const r = selectOnboardingCandidates({ active: [jack, jack2, dana], requestedNames: ['Jack'] });
    expect(r.candidates.map((e) => e.id).sort()).toEqual(['jack', 'jack2']);
  });
});

describe('humanJoin', () => {
  it('formats lists with an Oxford-style join', () => {
    expect(humanJoin(['a'])).toBe('a');
    expect(humanJoin(['a', 'b'])).toBe('a and b');
    expect(humanJoin(['a', 'b', 'c'])).toBe('a, b, and c');
    expect(humanJoin([])).toBe('');
  });
});
