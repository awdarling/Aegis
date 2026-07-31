import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same import-time isolation as avail-change-confirm-copy.test.ts, plus a
// controllable Anthropic mock so we can drive reviewAvailabilityConfirmation's
// parse branch (the new "different_intent" action) deterministically.
const h = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: h.createMock }; } }));
vi.mock('../../config/env', () => ({
  env: { ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k', SENDGRID_FROM_EMAIL: 'a@b.test', SENDGRID_FROM_NAME: 'Aegis', BASE_URL: 'http://localhost:3000', NODE_ENV: 'test', EMAIL_ONLY: false },
}));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn(), getTenantSmsNumber: vi.fn() }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn() }));
vi.mock('../../ai/claude', () => ({ withAnthropicRetry: (fn: () => unknown) => fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));

import { reviewAvailabilityConfirmation, switchIntentPhrase } from '../employee-onboarding';

const bounds: any = { earliest_start: '09:00', latest_end: '21:00' };
const proposed: any = [{ day_of_week: 1, start_time: '15:00', end_time: '17:00' }];
const llm = (json: object) => h.createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(json) }] });

describe('reviewAvailabilityConfirmation — different_intent plumbing (Bug 1)', () => {
  beforeEach(() => h.createMock.mockReset());

  it('surfaces a different_intent with a known label', async () => {
    llm({ action: 'different_intent', intent: 'shift_swap' });
    expect(await reviewAvailabilityConfirmation(proposed, 'Riley is taking my Saturday shift', bounds))
      .toEqual({ action: 'different_intent', intent: 'shift_swap' });
  });

  it('clamps an unknown intent label to "other"', async () => {
    llm({ action: 'different_intent', intent: 'make_me_a_sandwich' });
    expect(await reviewAvailabilityConfirmation(proposed, 'blah', bounds))
      .toEqual({ action: 'different_intent', intent: 'other' });
  });

  it('still returns revise/confirm/restart/unclear correctly', async () => {
    llm({ action: 'revise', slots: [{ day_of_week: 1, start_time: '09:00', end_time: '15:00' }] });
    expect(await reviewAvailabilityConfirmation(proposed, 'until 3 not from 3', bounds))
      .toEqual({ action: 'revise', slots: [{ day_of_week: 1, start_time: '09:00', end_time: '15:00' }] });
    llm({ action: 'confirm' });
    expect(await reviewAvailabilityConfirmation(proposed, 'looks good', bounds)).toEqual({ action: 'confirm' });
    llm({ action: 'restart' });
    expect(await reviewAvailabilityConfirmation(proposed, 'no scrap it', bounds)).toEqual({ action: 'restart' });
    llm({ action: 'nonsense' });
    expect(await reviewAvailabilityConfirmation(proposed, '???', bounds)).toEqual({ action: 'unclear' });
  });
});

describe('switchIntentPhrase — friendly wording for the switch offer', () => {
  it('names each intent naturally', () => {
    expect(switchIntentPhrase('time_off')).toMatch(/time-off/i);
    expect(switchIntentPhrase('shift_swap')).toMatch(/swap/i);
    expect(switchIntentPhrase('coverage')).toMatch(/coverage/i);
    expect(switchIntentPhrase('schedule_query')).toMatch(/schedule/i);
    expect(switchIntentPhrase('other' as any)).toMatch(/take care/i);
  });
});
