import { describe, it, expect, vi } from 'vitest';

// Pins the opt-in/consent message to the REGISTERED A2P 10DLC campaign + the
// public consent page (quriasolutions.com/sms-consent). This is the compliance
// call-to-action, so its wording is the legal source of truth — this test fails
// if the code drifts from what's registered.

vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: false, ANTHROPIC_API_KEY: 'x', SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', SENDGRID_FROM_EMAIL: 'a@b.c', BASE_URL: 'http://x' } }));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn(), normalizeReSubject: (s: string) => s }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/notify', () => ({ notifyEmployeeSmsFirst: vi.fn(), getAegisSmsChannel: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../ai/claude', () => ({ withAnthropicRetry: vi.fn() }));

import { buildOptInMessage } from '../employee-onboarding';

describe('opt-in message — registered A2P 10DLC campaign', () => {
  it('matches the registered opt-in message verbatim', () => {
    expect(buildOptInMessage('Sarah', 'Watermark Country Club')).toBe(
      "Hi Sarah! This is Aegis, scheduling assistant for Watermark Country Club. " +
      "We'll send shift notifications via SMS. Reply YES to confirm. " +
      "Msg & data rates may apply. Reply STOP to opt out. " +
      "Info: quriasolutions.com/sms-consent",
    );
  });
});
