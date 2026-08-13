import { describe, it, expect, vi } from 'vitest';

// H5 — a phone-only hire is now asked for an (optional) email during onboarding.
// These are unit-level guards on the two pure pieces of the fix: the needs
// resolver routing a phone-only hire to the email step, and the SKIP token
// detector that lets an SMS-reachable hire decline the step gracefully.

vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({ env: { ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k', SENDGRID_FROM_EMAIL: 'a@b.test', SENDGRID_FROM_NAME: 'Aegis', BASE_URL: 'http://localhost:3000', NODE_ENV: 'test', EMAIL_ONLY: false } }));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn(), getTenantSmsNumber: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn() }));
vi.mock('../../ai/claude', () => ({ withAnthropicRetry: vi.fn() }));

import { resolveOnboardingNeeds, isEmailSkip } from '../employee-onboarding';

describe('H5 — phone-only hire reaches the email step', () => {
  it('a phone-only hire with role + availability is NOT complete: they still need an email', () => {
    const needs = resolveOnboardingNeeds(
      { contact_phone: '+16165551234', contact_email: null, primary_role: 'Guard', qualified_roles: ['Guard'] },
      true, // availability on file
    );
    expect(needs).toEqual({ needsEmail: true, needsRole: false, needsAvailability: false });
  });

  it('a phone+email hire with role + availability is complete', () => {
    const needs = resolveOnboardingNeeds(
      { contact_phone: '+16165551234', contact_email: 'e@x.com', primary_role: 'Guard', qualified_roles: ['Guard'] },
      true,
    );
    expect(needs).toEqual({ needsEmail: false, needsRole: false, needsAvailability: false });
  });
});

describe('H5 — isEmailSkip (optional email decline)', () => {
  it('recognises plain skip words (case / punctuation insensitive)', () => {
    for (const w of ['skip', 'SKIP', 'Skip.', ' none ', 'no', 'nope', 'N/A', 'no email', 'no thanks', 'pass', "don't have one"]) {
      expect(isEmailSkip(w)).toBe(true);
    }
  });

  it('never treats a real email address as a skip', () => {
    for (const e of ['sam@example.com', 'a.b+tag@mail.co', 'x@y.io']) {
      expect(isEmailSkip(e)).toBe(false);
    }
  });

  it('does not skip on unrelated text', () => {
    for (const w of ['maybe later', 'skippy@peanut.com', 'my email is bob@x.com']) {
      expect(isEmailSkip(w)).toBe(false);
    }
  });
});
