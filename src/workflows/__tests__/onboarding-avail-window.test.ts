import { describe, it, expect, vi } from 'vitest';

// ── Batch-1 F6: onboarding availability-window vs day-off disambiguation ─────────
//
// At the onboarding "any dates you WON'T be available?" step, an availability
// WINDOW ("Friday I'm open 3–9pm") must NOT become a partial-day time-off. This
// pins the detector that gates the clarifier: it fires on availability-window
// phrasing but never on a genuine day-off.

vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: false, ANTHROPIC_API_KEY: 'x', SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', SENDGRID_FROM_EMAIL: 'a@b.c', BASE_URL: 'http://x' } }));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn(), normalizeReSubject: (s: string) => s }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/notify', () => ({ notifyEmployeeSmsFirst: vi.fn(), getAegisSmsChannel: vi.fn() }));
vi.mock('../../ai/claude', () => ({ withAnthropicRetry: vi.fn() }));

import { looksLikeAvailabilityWindow } from '../employee-onboarding';

describe('looksLikeAvailabilityWindow (Batch-1 F6)', () => {
  it('fires on the live-test scenario (availability window)', () => {
    expect(looksLikeAvailabilityWindow("Friday looks busy, I'm open 3-9pm")).toBe(true);
  });

  it('fires on other availability windows', () => {
    expect(looksLikeAvailabilityWindow("I'm available 3-9pm on Friday")).toBe(true);
    expect(looksLikeAvailabilityWindow("I'm free after 5 on Friday")).toBe(true);
    expect(looksLikeAvailabilityWindow("I can work mornings that Friday")).toBe(true);
  });

  it('does NOT fire on a genuine day off', () => {
    expect(looksLikeAvailabilityWindow("I'm off Friday")).toBe(false);
    expect(looksLikeAvailabilityWindow("I can't work the 5th")).toBe(false);
    expect(looksLikeAvailabilityWindow("I need Friday off")).toBe(false);
    expect(looksLikeAvailabilityWindow("I'm unavailable next week")).toBe(false);
    expect(looksLikeAvailabilityWindow("out of town Aug 5-7")).toBe(false);
  });

  it('does NOT fire when there is no availability-window language', () => {
    expect(looksLikeAvailabilityWindow("August 5 to 7")).toBe(false);
    expect(looksLikeAvailabilityWindow("the 20th")).toBe(false);
  });
});
