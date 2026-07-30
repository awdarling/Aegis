import { describe, it, expect, vi } from 'vitest';

// claude.ts constructs the Anthropic client + reads env at module load. Mock both
// so we can import its PURE helpers without side effects.
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({
  env: { ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k', BASE_URL: 'http://localhost:3000', NODE_ENV: 'test' },
}));

import { looksLikeBareTimeOffRequest, applyBareTimeOffBackstop, type ClassifyResult } from '../claude';

// The exact real message that regressed: an employee texted "I want to request
// time off", the classifier returned general_question, and the ungrounded
// operational handler answered "log into Homebase" — a process that doesn't exist.
const REGRESSED = 'I want to request time off';

describe('looksLikeBareTimeOffRequest', () => {
  it('fires on the regressed message and its close variants', () => {
    expect(looksLikeBareTimeOffRequest(REGRESSED)).toBe(true);
    expect(looksLikeBareTimeOffRequest('I need to put in for time off')).toBe(true);
    expect(looksLikeBareTimeOffRequest('can I request a day off')).toBe(true);
    expect(looksLikeBareTimeOffRequest("I'd like to take some vacation")).toBe(true);
    expect(looksLikeBareTimeOffRequest('i need some time off')).toBe(true);
  });

  it('does NOT fire on time-off QUERIES or how-to questions (those are query/capabilities)', () => {
    expect(looksLikeBareTimeOffRequest('what time off do I have approved?')).toBe(false);
    expect(looksLikeBareTimeOffRequest('do I have any time off coming up?')).toBe(false);
    expect(looksLikeBareTimeOffRequest('how do I request time off?')).toBe(false);
    expect(looksLikeBareTimeOffRequest('when is my next day off?')).toBe(false);
  });

  it('does NOT fire when a concrete/relative date is present (the model handles dated requests)', () => {
    expect(looksLikeBareTimeOffRequest('I want time off June 20')).toBe(false);
    expect(looksLikeBareTimeOffRequest('I need time off next week')).toBe(false);
    expect(looksLikeBareTimeOffRequest('can I take vacation on the 5th')).toBe(false);
    expect(looksLikeBareTimeOffRequest('I want time off tomorrow')).toBe(false);
  });

  it('does NOT fire on availability phrasing or off-topic messages', () => {
    expect(looksLikeBareTimeOffRequest('take me off Thursday nights')).toBe(false);
    expect(looksLikeBareTimeOffRequest('I want to leave early')).toBe(false);
    expect(looksLikeBareTimeOffRequest('I want to swap a shift')).toBe(false);
    expect(looksLikeBareTimeOffRequest("what's the capital of France?")).toBe(false);
  });
});

describe('applyBareTimeOffBackstop', () => {
  const gq: ClassifyResult = { intent: 'general_question', confidence: 'high', extracted: {} };

  it('upgrades general_question → submit_time_off for a bare time-off request', () => {
    const out = applyBareTimeOffBackstop(gq, REGRESSED);
    expect(out.intent).toBe('submit_time_off');
    expect(out.extracted).toEqual({}); // no dates — the workflow will ask
  });

  it('upgrades unknown → submit_time_off too, bumping low confidence to medium', () => {
    const out = applyBareTimeOffBackstop({ intent: 'unknown', confidence: 'low', extracted: {} }, REGRESSED);
    expect(out.intent).toBe('submit_time_off');
    expect(out.confidence).toBe('medium');
  });

  it('never overrides a confident, more specific action', () => {
    const swap: ClassifyResult = { intent: 'initiate_swap', confidence: 'high', extracted: {} };
    expect(applyBareTimeOffBackstop(swap, REGRESSED).intent).toBe('initiate_swap');
    // and leaves a genuine general question alone
    expect(applyBareTimeOffBackstop(gq, "what's the capital of France?").intent).toBe('general_question');
  });
});
