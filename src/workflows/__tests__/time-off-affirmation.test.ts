import { describe, it, expect, vi } from 'vitest';

// time-off.ts pulls in the DB/Anthropic/messaging layers at import. Mock them so
// we can reach the pure affirmation/denial helpers without side effects.
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({
  env: { ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k', SENDGRID_FROM_EMAIL: 'a@b.test', SENDGRID_FROM_NAME: 'Aegis', BASE_URL: 'http://localhost:3000', NODE_ENV: 'test' },
}));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn() }));
vi.mock('../../ai/claude', () => ({ withAnthropicRetry: vi.fn(), generateReply: vi.fn(), classifyIntent: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));

import { isTimeOffAffirmation, isTimeOffDenial, isTimeOffCancellation } from '../time-off';

// The confirmation is human now ("Want me to send that over to your manager?"),
// so it must accept natural replies — not only a literal "yes".
describe('isTimeOffAffirmation', () => {
  it('accepts natural ways of saying yes', () => {
    for (const s of ['yes', 'Yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'send it', 'send it over', 'go for it', 'go ahead', 'do it', 'please do', 'sounds good', 'looks good', 'that works', 'perfect', 'great', '👍']) {
      expect(isTimeOffAffirmation(s)).toBe(true);
    }
    expect(isTimeOffAffirmation('yeah send it to my manager please')).toBe(true);
  });

  it('does not treat a no / correction as yes', () => {
    for (const s of ['no', 'nope', 'not quite', 'hold on', 'change it', "don't"]) {
      expect(isTimeOffAffirmation(s)).toBe(false);
    }
  });
});

describe('isTimeOffDenial', () => {
  it('accepts natural ways of saying no', () => {
    for (const s of ['no', 'Nope', 'nah', 'wrong', 'not quite', 'not right', 'cancel', 'change it', 'hold on', 'wait', "don't send it"]) {
      expect(isTimeOffDenial(s)).toBe(true);
    }
  });

  it('does not treat a yes as no', () => {
    for (const s of ['yes', 'send it', 'go for it', 'sounds good']) {
      expect(isTimeOffDenial(s)).toBe(false);
    }
  });
});

describe('isTimeOffCancellation — mid-flow cancels (varied phrasings)', () => {
  it('catches a variety of natural cancellations', () => {
    for (const cancel of [
      "Actually I changed my mind I don't need it anymore",
      "No, don't send it. I don't need any time off.",
      "No, I don't want time off.",
      "never mind",
      "cancel",
      "forget it",
      "I'm all set",
    ]) {
      expect(isTimeOffCancellation(cancel)).toBe(true);
    }
  });
  it('does NOT treat a date correction as a cancellation', () => {
    for (const keep of [
      "no, I don't need Friday, just Thursday",
      "change it to the 8th",
      "not quite - make it the morning",
    ]) {
      expect(isTimeOffCancellation(keep)).toBe(false);
    }
  });
});
