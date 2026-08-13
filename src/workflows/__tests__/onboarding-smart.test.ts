import { describe, it, expect, vi } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({ env: { ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k', SENDGRID_FROM_EMAIL: 'a@b.test', SENDGRID_FROM_NAME: 'Aegis', BASE_URL: 'http://localhost:3000', NODE_ENV: 'test', EMAIL_ONLY: false } }));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn(), getTenantSmsNumber: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn() }));
vi.mock('../../ai/claude', () => ({ withAnthropicRetry: vi.fn() }));

import { resolveOnboardingNeeds } from '../employee-onboarding';

describe('resolveOnboardingNeeds (B6 completeness — phone OR email + role + availability)', () => {
  it('a fully-complete record needs nothing', () => {
    expect(resolveOnboardingNeeds({ contact_phone: '+1', contact_email: 'e@x.com', primary_role: 'Guard', qualified_roles: ['Guard'] }, true))
      .toEqual({ needsEmail: false, needsRole: false, needsAvailability: false });
  });
  // H5 (2026-08-13): needsEmail gates on `!contact_email` specifically, not on
  // "has no contact at all". A phone-only hire is reachable but has no email, so
  // Aegis can't send them the full weekly team schedule — they should be ASKED
  // for one (the step is optional; they can SKIP). An email-only hire already has
  // an email, so needsEmail is false.
  it('needsEmail gates on the absence of an email, not the absence of any contact', () => {
    // phone-only hire: reachable, but no email -> ask for one (H5 fix)
    expect(resolveOnboardingNeeds({ contact_phone: '+1', contact_email: null, primary_role: 'Guard' }, true).needsEmail).toBe(true);
    // email-only hire: already has an email -> don't ask
    expect(resolveOnboardingNeeds({ contact_phone: null, contact_email: 'e@x.com', primary_role: 'Guard' }, true).needsEmail).toBe(false);
    // phone + email: don't ask
    expect(resolveOnboardingNeeds({ contact_phone: '+1', contact_email: 'e@x.com', primary_role: 'Guard' }, true).needsEmail).toBe(false);
    // neither (defensive; filtered upstream): still reads as needing an email
    expect(resolveOnboardingNeeds({ contact_phone: null, contact_email: null, primary_role: 'Guard' }, true).needsEmail).toBe(true);
  });
  it('role is satisfied by primary_role OR qualified_roles', () => {
    expect(resolveOnboardingNeeds({ contact_phone: '+1', primary_role: 'Guard', qualified_roles: [] }, true).needsRole).toBe(false);
    expect(resolveOnboardingNeeds({ contact_phone: '+1', primary_role: null, qualified_roles: ['Guard'] }, true).needsRole).toBe(false);
    expect(resolveOnboardingNeeds({ contact_phone: '+1', primary_role: null, qualified_roles: [] }, true).needsRole).toBe(true);
  });
  it('availability is driven by the hasAvailability flag', () => {
    expect(resolveOnboardingNeeds({ contact_phone: '+1', primary_role: 'Guard' }, false).needsAvailability).toBe(true);
    expect(resolveOnboardingNeeds({ contact_phone: '+1', primary_role: 'Guard' }, true).needsAvailability).toBe(false);
  });
});
