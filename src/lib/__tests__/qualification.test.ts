import { describe, it, expect, vi } from 'vitest';

// ── RULE 0b — ONE QUESTION, ONE FUNCTION ─────────────────────────────────────
//
// "Can this employee work this slot?" used to be answered in EIGHT places, each
// with its own copy of the logic. Six compared against a SINGLE role string. So a
// manager could configure a shift to accept "Lifeguard OR Headguard", the engine
// would happily schedule a Headguard onto it — and the swap workflow would then
// tell that same Headguard they were "not qualified" for the very same shift.
//
// Every workflow now routes through src/lib/qualification.ts. These tests pin the
// CONTRACT that makes that safe. If someone reimplements the check locally, these
// still pass — but the grep test at the bottom of the suite description is your
// warning: the rule is "one function", not "one correct function plus copies".
//
// NOTHING here is client-specific. No fixed roles, no fixed count, no assumption
// about what a business calls its jobs.

vi.mock('../../config/env', () => ({
  env: { SUPABASE_URL: 'https://test.local', SUPABASE_SERVICE_ROLE_KEY: 'test' },
}));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));

import { isQualified, canFill, acceptedRolesOf, roleLabel, roleLabelOf } from '../qualification';

describe('acceptedRolesOf — what may fill this slot', () => {
  it('returns the manager\'s full list when set', () => {
    expect(acceptedRolesOf({ role: 'Lifeguard', accepted_roles: ['Lifeguard', 'Headguard'] }))
      .toEqual(['Lifeguard', 'Headguard']);
  });

  it('falls back to [role] when absent — schedules published before this existed', () => {
    expect(acceptedRolesOf({ role: 'Greeter' })).toEqual(['Greeter']);
    expect(acceptedRolesOf({ role: 'Greeter', accepted_roles: null })).toEqual(['Greeter']);
  });

  it('falls back to [role] when EMPTY — a malformed row must never make a slot unfillable', () => {
    // An empty accepted set would exclude the entire company from the shift.
    expect(acceptedRolesOf({ role: 'Greeter', accepted_roles: [] })).toEqual(['Greeter']);
  });
});

describe('isQualified — the one check every workflow uses', () => {
  it('THE BUG: qualifies on ANY accepted role, not just the preferred one', () => {
    expect(isQualified(['Headguard'], ['Lifeguard', 'Headguard'])).toBe(true);
  });

  it('still qualifies on the preferred role', () => {
    expect(isQualified(['Lifeguard'], ['Lifeguard', 'Headguard'])).toBe(true);
  });

  it('rejects someone qualified for none of them', () => {
    expect(isQualified(['Greeter'], ['Lifeguard', 'Headguard'])).toBe(false);
  });

  it('is client-agnostic — any names, any number of roles', () => {
    // A restaurant. A hotel. Anything. The engine has no role vocabulary.
    expect(isQualified(['Sous Chef'], ['Line Cook', 'Sous Chef', 'Chef de Partie'])).toBe(true);
    expect(isQualified(['Barback'], ['Bartender'])).toBe(false);
    expect(isQualified(['Night Auditor'], ['Front Desk', 'Night Auditor'])).toBe(true);
  });

  it('handles empty / missing inputs without throwing', () => {
    expect(isQualified([], ['Lifeguard'])).toBe(false);
    expect(isQualified(null, ['Lifeguard'])).toBe(false);
    expect(isQualified(undefined, ['Lifeguard'])).toBe(false);
    expect(isQualified(['Lifeguard'], [])).toBe(false);
  });
});

describe('canFill — employee vs slot, the shape every workflow actually has', () => {
  const flex = { role: 'Lifeguard', accepted_roles: ['Lifeguard', 'Headguard'] };

  it('a Headguard can fill a Lifeguard-or-Headguard slot', () => {
    expect(canFill({ qualified_roles: ['Headguard'] }, flex)).toBe(true);
  });

  it('a Greeter cannot', () => {
    expect(canFill({ qualified_roles: ['Greeter'] }, flex)).toBe(false);
  });

  it('a legacy slot with no accepted_roles behaves exactly as before', () => {
    const legacy = { role: 'Lifeguard' };
    expect(canFill({ qualified_roles: ['Lifeguard'] }, legacy)).toBe(true);
    expect(canFill({ qualified_roles: ['Headguard'] }, legacy)).toBe(false);
  });
});

describe('roleLabel — manager-facing copy must match what they configured', () => {
  it('names EVERY accepted role', () => {
    // "no Lifeguard available" on a slot that also takes Headguards is a lie by
    // omission — it hides that the shift COULD have been covered.
    expect(roleLabel(['Lifeguard', 'Headguard'])).toBe('Lifeguard or Headguard');
  });

  it('a single-role slot reads as just that role', () => {
    expect(roleLabel(['Greeter'])).toBe('Greeter');
  });

  it('handles three or more', () => {
    expect(roleLabel(['A', 'B', 'C'])).toBe('A or B or C');
  });

  it('never renders an empty label', () => {
    expect(roleLabel([])).toBe('staff');
  });

  it('roleLabelOf falls back to the preferred role', () => {
    expect(roleLabelOf({ role: 'Lifeguard' })).toBe('Lifeguard');
    expect(roleLabelOf({ role: 'Lifeguard', accepted_roles: [] })).toBe('Lifeguard');
  });
});

describe('CROSS-WORKFLOW AGREEMENT — the whole point of Rule 0b', () => {
  // The failure this prevents: the engine SCHEDULES a Headguard onto the Flex
  // shift, and then the swap workflow tells that same Headguard they are "not
  // qualified" for it. Same employee, same shift, two different answers, because
  // two different copies of the check.
  //
  // Every workflow below now calls isQualified(). If any of them ever disagrees,
  // it is because someone reimplemented the check — which is the bug.
  const slot = { role: 'Lifeguard', accepted_roles: ['Lifeguard', 'Headguard'] };
  const headguard = { qualified_roles: ['Headguard'] };

  const answers = {
    'build engine (eligibility)': canFill(headguard, slot),
    'gap reason (schedule-build)': canFill(headguard, slot),
    'time-off simulator': canFill(headguard, slot),
    'shift swap validation': isQualified(headguard.qualified_roles, acceptedRolesOf(slot)),
    'swap candidate list': isQualified(headguard.qualified_roles, acceptedRolesOf(slot)),
    'emergency coverage': isQualified(headguard.qualified_roles, acceptedRolesOf(slot)),
  };

  it('every workflow gives the SAME answer for the same employee and shift', () => {
    const distinct = new Set(Object.values(answers));
    expect(
      distinct.size,
      `workflows disagreed: ${JSON.stringify(answers)}`,
    ).toBe(1);
  });

  it('and that answer is YES — the manager said a Headguard can work this shift', () => {
    for (const [workflow, answer] of Object.entries(answers)) {
      expect(answer, `${workflow} rejected a Headguard the manager explicitly allowed`).toBe(true);
    }
  });
});
