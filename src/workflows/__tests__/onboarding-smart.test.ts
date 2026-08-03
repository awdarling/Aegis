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
  it('contact is satisfied by phone OR email — a phone-only or email-only hire is NOT incomplete', () => {
    expect(resolveOnboardingNeeds({ contact_phone: '+1', contact_email: null, primary_role: 'Guard' }, true).needsEmail).toBe(false);
    expect(resolveOnboardingNeeds({ contact_phone: null, contact_email: 'e@x.com', primary_role: 'Guard' }, true).needsEmail).toBe(false);
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
