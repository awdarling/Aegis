import { describe, it, expect } from 'vitest';
import {
  selectOnboardingCandidates,
  isUnfinishedOnboarding,
  humanJoin,
} from '../employee-onboarding';
import type { Employee } from '../../db/types';

// L5 — these fixtures and expectations were REWRITTEN. The old ones encoded the
// bug: they treated `sms_consent_state === 'confirmed'` as "finished", which is
// exactly why "onboard everyone who hasn't finished" skipped Bennet Nieukoop and
// Rosa Thornburg — both consented, neither finished. Note that every one of the
// old assertions passed on the broken code, because none of them modelled an
// opted-in-but-incomplete employee. That was the coverage hole.
//
// `isUnfinishedOnboarding(e, hasAvailability, hasLiveSession)` now delegates to
// the ONE definition in lib/onboarding-status.ts.
function emp(
  id: string,
  name: string,
  consent: string | null,
  contact: 'phone' | 'email' | 'none' = 'phone',
  role: string | null = 'Lifeguard'
): Employee {
  return {
    id,
    name,
    sms_consent_state: consent,
    primary_role: role,
    qualified_roles: role ? [role] : [],
    contact_phone: contact === 'phone' ? '+1555' + id : null,
    contact_email: contact === 'email' ? `${id}@club.com` : null,
  } as unknown as Employee;
}

const HAS_AVAIL = true;
const NO_AVAIL = false;

const jack = emp('jack', 'Jack McCorkle', null);          // never opted in → unfinished
const dana = emp('dana', 'Dana Lee', 'confirmed');        // consented + complete → done
const sam = emp('sam', 'Sam Rivera', 'declined');         // opted out → NOT a straggler
const remy = emp('remy', 'Remy Cho', 'resubscribed');     // consented + complete → done
const opal = emp('opal', 'Opal Kim', 'none');             // unfinished
const active = [jack, dana, sam, remy, opal];

// Everyone who is "done" needs availability on file for that to be true.
const availability = new Map<string, boolean>([['dana', true], ['remy', true], ['sam', true]]);

describe('isUnfinishedOnboarding', () => {
  it('consented AND schedulable (role + availability) = finished', () => {
    expect(isUnfinishedOnboarding(dana, HAS_AVAIL)).toBe(false);
    expect(isUnfinishedOnboarding(remy, HAS_AVAIL)).toBe(false);
  });

  it('THE LIVE BUG: consented but NOT schedulable = still UNFINISHED', () => {
    // Bennet/Rosa's real shape at the point N4 skipped them — the old code
    // returned false here because consent was all it looked at.
    const bennet = emp('bennet', 'Bennet Nieukoop', 'confirmed');
    expect(isUnfinishedOnboarding(bennet, NO_AVAIL)).toBe(true);

    const noRole = emp('norole', 'No Role', 'confirmed', 'phone', null);
    expect(isUnfinishedOnboarding(noRole, HAS_AVAIL)).toBe(true);
  });

  it('declined / opted_out = deliberately out, and stays out even when incomplete', () => {
    // Terminal on purpose: never sweep someone who said no back into an
    // automatic re-onboard, however empty their record looks.
    expect(isUnfinishedOnboarding(sam, HAS_AVAIL)).toBe(false);
    expect(isUnfinishedOnboarding(emp('x', 'X', 'opted_out'), NO_AVAIL)).toBe(false);
  });

  it('none / null = unfinished', () => {
    expect(isUnfinishedOnboarding(jack, NO_AVAIL)).toBe(true);
    expect(isUnfinishedOnboarding(opal, NO_AVAIL)).toBe(true);
  });

  it('an EMAIL-ONLY hire is not held back by the absence of an SMS opt-in', () => {
    // The old comment apologised for this false positive ("a completed employee
    // can still read as unfinished ... caught at the fan-out gate"). Consent
    // gates the SMS channel only, so email reachability satisfies that leg.
    const emailHire = emp('mail', 'Mail Only', null, 'email');
    expect(isUnfinishedOnboarding(emailHire, HAS_AVAIL)).toBe(false);
    expect(isUnfinishedOnboarding(emp('mail2', 'Mail Two', null, 'email'), NO_AVAIL)).toBe(true);
  });

  it('someone with NO phone and NO email is not a candidate — Aegis cannot start', () => {
    // 'unreachable' needs manager data entry first; silently failing to contact
    // them would look like the feature is broken.
    expect(isUnfinishedOnboarding(emp('ghost', 'Ghost', null, 'none'), NO_AVAIL)).toBe(false);
  });
});

describe('selectOnboardingCandidates', () => {
  it('default (no names, no subset) = whole active team', () => {
    const r = selectOnboardingCandidates({ active });
    expect(r.mode).toBe('all');
    expect(r.candidates).toHaveLength(5);
  });

  it("subset 'unfinished' = only the stragglers (excludes done + declined)", () => {
    const r = selectOnboardingCandidates({ active, subset: 'unfinished', availabilityByEmployee: availability });
    expect(r.mode).toBe('subset');
    expect(r.candidates.map((e) => e.id).sort()).toEqual(['jack', 'opal']);
  });

  it("THE LIVE BUG: an opted-in-but-incomplete employee IS now surfaced", () => {
    // Alexander asked "onboard everyone who hasn't finished" and got back only
    // Ally Becker, while the scheduler was simultaneously texting him that
    // Bennet and Rosa hadn't finished. This is that case.
    const bennet = emp('bennet', 'Bennet Nieukoop', 'confirmed');
    const rosa = emp('rosa', 'Rosa Thornburg', 'confirmed');
    const r = selectOnboardingCandidates({
      active: [...active, bennet, rosa],
      subset: 'unfinished',
      availabilityByEmployee: availability,   // neither has availability on file
    });
    expect(r.candidates.map((e) => e.id).sort()).toEqual(['bennet', 'jack', 'opal', 'rosa']);
  });

  it('with NO availability map, errs toward INCLUDING people (the fan-out gate catches it)', () => {
    // An over-inclusion is reviewed by the manager at the confirmation gate; an
    // omission is invisible, which is how Bennet and Rosa went unnoticed.
    const r = selectOnboardingCandidates({ active, subset: 'unfinished' });
    expect(r.candidates.map((e) => e.id).sort()).toEqual(['dana', 'jack', 'opal', 'remy']);
    expect(r.candidates.map((e) => e.id)).not.toContain('sam'); // declined still excluded
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
