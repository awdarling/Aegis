import { describe, it, expect, vi } from 'vitest';

// employee-onboarding constructs the Anthropic client + reads env at load; mock
// those so importing the module to reach the pure detector is side-effect-free.
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({
  env: { ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k', SENDGRID_FROM_EMAIL: 'a@b.test', SENDGRID_FROM_NAME: 'Aegis', BASE_URL: 'http://localhost:3000', HOMEBASE_URL: 'http://localhost:3000', NODE_ENV: 'test' },
}));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../ai/claude', () => ({ generateReply: vi.fn(), withAnthropicRetry: vi.fn(), weekdayAnchors: () => ({ todayName: 'Monday', thisWeek: [], nextWeek: [] }) }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));

import { isClearNoTimeOff } from '../employee-onboarding';

describe('isClearNoTimeOff', () => {
  it('accepts unambiguous negatives (no re-gate)', () => {
    for (const s of ['No', 'nope', 'Nope.', 'nah', 'none', 'nothing', 'no thanks', "I'm good", 'all good', 'No, all good', 'not right now', 'not at the moment']) {
      expect(isClearNoTimeOff(s)).toBe(true);
    }
  });
  it('does NOT fire on anything that names dates or is ambiguous (falls through to confirm)', () => {
    for (const s of ['Aug 5', 'I need August 5th off', 'the 20th', 'maybe next week', 'let me check', 'not sure', 'yes actually there is one']) {
      expect(isClearNoTimeOff(s)).toBe(false);
    }
  });
});
