import { describe, it, expect, vi } from 'vitest';

// claude.ts constructs the Anthropic client + reads env at module load. Mock both
// so we can import its PURE helpers without side effects.
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({
  env: { ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k', BASE_URL: 'http://localhost:3000', NODE_ENV: 'test' },
}));

import { looksLikeManagerCoverageCallout, applyManagerCoverageBackstop, type ClassifyResult } from '../claude';

// Batch-1.5 finding #11: a manager reporting a THIRD PARTY who can't work must
// route to request_emergency_coverage — not initiate_swap / submit_time_off.

describe('looksLikeManagerCoverageCallout', () => {
  it('fires on a named third party who cannot work', () => {
    expect(looksLikeManagerCoverageCallout('Marcus can\'t work Saturday')).toBe(true);
    expect(looksLikeManagerCoverageCallout('Sarah called in sick')).toBe(true);
    expect(looksLikeManagerCoverageCallout('Jordan is out today')).toBe(true);
    expect(looksLikeManagerCoverageCallout('Casey won\'t make it in tomorrow')).toBe(true);
    expect(looksLikeManagerCoverageCallout('Avery phoned in sick')).toBe(true);
  });

  it('fires on a direct ask to fill a hole', () => {
    expect(looksLikeManagerCoverageCallout('I need someone to cover the morning shift')).toBe(true);
    expect(looksLikeManagerCoverageCallout('need coverage for Saturday')).toBe(true);
    expect(looksLikeManagerCoverageCallout('find a sub for the 9am')).toBe(true);
    expect(looksLikeManagerCoverageCallout('emergency coverage needed')).toBe(true);
  });

  it('does NOT fire on the sender\'s OWN absence (first person)', () => {
    expect(looksLikeManagerCoverageCallout("I can't work Saturday")).toBe(false);
    expect(looksLikeManagerCoverageCallout('I need Friday off')).toBe(false);
    expect(looksLikeManagerCoverageCallout("I'm out sick today")).toBe(false);
  });

  it('does NOT fire on an employee arranging their OWN shift swap', () => {
    expect(looksLikeManagerCoverageCallout('can someone take my Saturday shift')).toBe(false);
    expect(looksLikeManagerCoverageCallout('Marcus is taking my Saturday shift')).toBe(false);
  });

  it('does NOT fire on plain availability / off phrasing with no third party', () => {
    expect(looksLikeManagerCoverageCallout('off tuesday')).toBe(false);
    expect(looksLikeManagerCoverageCallout('take me off Thursdays')).toBe(false);
  });
});

describe('applyManagerCoverageBackstop', () => {
  const swap: ClassifyResult = { intent: 'initiate_swap', confidence: 'medium', extracted: { target_employee_name: 'X' } };
  const timeoff: ClassifyResult = { intent: 'submit_time_off', confidence: 'high', extracted: {} };

  it('upgrades a manager third-party call-out from initiate_swap to coverage', () => {
    const out = applyManagerCoverageBackstop(swap, 'Marcus can\'t work Saturday', 'manager');
    expect(out.intent).toBe('request_emergency_coverage');
    expect(out.extracted).toEqual({});
  });

  it('upgrades a manager third-party call-out from submit_time_off to coverage', () => {
    const out = applyManagerCoverageBackstop(timeoff, 'Sarah called in sick, need someone for the morning', 'manager');
    expect(out.intent).toBe('request_emergency_coverage');
  });

  it('leaves an EMPLOYEE sender untouched (their own swap/time-off stands)', () => {
    expect(applyManagerCoverageBackstop(swap, 'Marcus can\'t work Saturday', 'employee').intent).toBe('initiate_swap');
  });

  it('leaves the manager\'s OWN time off untouched', () => {
    const own: ClassifyResult = { intent: 'submit_time_off', confidence: 'high', extracted: {} };
    expect(applyManagerCoverageBackstop(own, "I can't work Saturday", 'manager').intent).toBe('submit_time_off');
  });

  it('does not touch unrelated intents', () => {
    const q: ClassifyResult = { intent: 'operational_query', confidence: 'high', extracted: {} };
    expect(applyManagerCoverageBackstop(q, 'Marcus can\'t work Saturday', 'manager').intent).toBe('operational_query');
  });
});
