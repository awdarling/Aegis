import { describe, it, expect, vi } from 'vitest';

// claude.ts constructs the Anthropic client + reads env at module load. Mock both
// so we can import its PURE helpers without side effects.
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({
  env: { ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k', BASE_URL: 'http://localhost:3000', NODE_ENV: 'test' },
}));

import { looksLikePositiveAvailability, applyAvailabilityBackstop, type ClassifyResult } from '../claude';

// Quin M's real message that was mis-handled (classified as time-off).
const QUIN = 'For the week of June 29 to July 5 I can work Monday 11am to 3:30pm, Wednesday 11am to 3:30pm, and Thursday.';

describe('looksLikePositiveAvailability', () => {
  it("fires on Quin's 'I can work …' message", () => {
    expect(looksLikePositiveAvailability(QUIN)).toBe(true);
  });

  it('fires on other clear positive statements', () => {
    expect(looksLikePositiveAvailability('next week i can work tuesday and thursday')).toBe(true);
    expect(looksLikePositiveAvailability("I'm available mornings")).toBe(true);
    expect(looksLikePositiveAvailability('put me down for Saturdays')).toBe(true);
  });

  it('does NOT fire when there is off/can\'t language (leave mixed messages to the model)', () => {
    expect(looksLikePositiveAvailability('I can work Monday but I need Friday off')).toBe(false);
    expect(looksLikePositiveAvailability("can't work tuesday")).toBe(false);
    expect(looksLikePositiveAvailability('Time off I: June 18-21. Availability: 6/22 morning')).toBe(false);
    expect(looksLikePositiveAvailability('Time off June 29 after 4pm')).toBe(false);
  });

  it('does NOT fire on unrelated messages', () => {
    expect(looksLikePositiveAvailability('what are my shifts this week?')).toBe(false);
    expect(looksLikePositiveAvailability('can someone cover my saturday?')).toBe(false);
  });
});

describe('applyAvailabilityBackstop', () => {
  const to = (extracted: Record<string, unknown>): ClassifyResult => ({ intent: 'submit_time_off', confidence: 'high', extracted });

  it("reclassifies Quin's misfired time-off → update_availability, carrying the week-end as end_date", () => {
    const misfired = to({ dates: [{ start_date: '2026-06-29', end_date: '2026-07-05' }] });
    const out = applyAvailabilityBackstop(misfired, QUIN);
    expect(out.intent).toBe('update_availability');
    expect(out.extracted).toEqual({ end_date: '2026-07-05' });
  });

  it('reclassifies with no end_date when the model captured no range', () => {
    const out = applyAvailabilityBackstop(to({}), 'i can work mornings');
    expect(out.intent).toBe('update_availability');
    expect(out.extracted).toEqual({});
  });

  it('leaves a genuine time-off request untouched', () => {
    const realTO = to({ dates: [{ start_date: '2026-06-20', end_date: '2026-06-20' }] });
    expect(applyAvailabilityBackstop(realTO, 'gimme june 20 off').intent).toBe('submit_time_off');
  });

  it('leaves non-time-off intents untouched', () => {
    const swap: ClassifyResult = { intent: 'initiate_swap', confidence: 'high', extracted: {} };
    expect(applyAvailabilityBackstop(swap, 'i can work and cover shifts').intent).toBe('initiate_swap');
  });
});
