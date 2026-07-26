import { describe, it, expect, vi } from 'vitest';

// ── BUG-7: onboarding availability-confirm loop — pure-guard unit tests ───────
//
// Covers the three additive guards that close the intermittent
// availability -> availability_confirm race (duplicate SendGrid inbound +
// LLM yes/no flake). Only the module-load side-effect deps are mocked; the
// functions under test are pure.

vi.mock('@anthropic-ai/sdk', () => ({ default: class MockAnthropic { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'http://x',
    SUPABASE_SERVICE_ROLE_KEY: 'x',
    ANTHROPIC_API_KEY: 'x',
    ANTHROPIC_MODEL: 'claude-sonnet-4-6',
    EMAIL_ONLY: true,
  },
}));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn(async () => {}) }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(async () => {}), sendInThreadAck: vi.fn(async () => {}) }));
vi.mock('../../ai/claude', () => ({ withAnthropicRetry: vi.fn(async (fn: () => unknown) => fn()) }));

import {
  classifyAffirmation,
  isDuplicateOnboardingInbound,
  shouldRecoverAvailabilityConfirm,
} from '../employee-onboarding';

describe('classifyAffirmation — deterministic yes/no fast-path', () => {
  it('treats clear one-word affirmations as yes', () => {
    for (const m of ['yes', 'Yes', 'YES!', 'yep', 'yeah', 'yup', 'sure', 'correct', 'confirmed', 'ok', 'okay', '👍', '✅']) {
      expect(classifyAffirmation(m)).toBe('yes');
    }
  });

  it('treats clear affirmation phrases as yes', () => {
    for (const m of ['yes please', "that's right", 'looks good', 'sounds good', 'all good', "yes that's correct", 'yes thanks']) {
      expect(classifyAffirmation(m)).toBe('yes');
    }
  });

  it('treats clear negations as no', () => {
    for (const m of ['no', 'Nope', 'nah', "that's wrong", 'not right', 'change it', 'incorrect', 'not quite']) {
      expect(classifyAffirmation(m)).toBe('no');
    }
  });

  it('returns null for nuanced/ambiguous messages so the LLM still decides', () => {
    for (const m of ['yes but change Tuesday', 'actually I can only work mornings', 'yes except Friday', 'Mon-Fri 9 to 5', '']) {
      expect(classifyAffirmation(m)).toBeNull();
    }
  });

  it('the exact regression case — a bare "Yes" — never flakes to no', () => {
    // This is the message that dead-ended the first #19 onboarding run.
    expect(classifyAffirmation('Yes')).toBe('yes');
    expect(classifyAffirmation('Yes!')).toBe('yes');
    expect(classifyAffirmation('yes.')).toBe('yes');
  });
});

describe('isDuplicateOnboardingInbound — SendGrid retry dedup', () => {
  it('flags an exact Message-ID repeat', () => {
    expect(isDuplicateOnboardingInbound({ last_processed_message_id: '<abc@x>' }, '<abc@x>')).toBe(true);
  });

  it('does not flag a different Message-ID', () => {
    expect(isDuplicateOnboardingInbound({ last_processed_message_id: '<abc@x>' }, '<def@x>')).toBe(false);
  });

  it('does not flag when either id is missing (nothing to dedup on)', () => {
    expect(isDuplicateOnboardingInbound({ last_processed_message_id: null }, '<abc@x>')).toBe(false);
    expect(isDuplicateOnboardingInbound({ last_processed_message_id: '<abc@x>' }, undefined)).toBe(false);
    expect(isDuplicateOnboardingInbound({ last_processed_message_id: undefined }, undefined)).toBe(false);
  });
});

describe('shouldRecoverAvailabilityConfirm — race recovery', () => {
  const base = (over: Partial<{ step: string; parsed: unknown[] }> = {}) => ({
    step: (over.step ?? 'availability') as 'availability' | 'availability_confirm',
    collected: { availability_parsed: (over.parsed ?? [{ day_of_week: 1 }]) as never[] },
  });

  it('recovers a "Yes" that landed on the availability step with a parse on file', () => {
    expect(shouldRecoverAvailabilityConfirm(base(), 'Yes')).toBe(true);
  });

  it('does NOT recover when no parse is on file (genuine first availability answer)', () => {
    expect(shouldRecoverAvailabilityConfirm(base({ parsed: [] }), 'Yes')).toBe(false);
  });

  it('does NOT recover a real availability statement', () => {
    expect(shouldRecoverAvailabilityConfirm(base(), 'Mon-Fri 9 to 5')).toBe(false);
  });

  it('does NOT fire when already past the availability step', () => {
    expect(shouldRecoverAvailabilityConfirm(base({ step: 'availability_confirm' }), 'Yes')).toBe(false);
  });
});
