import { describe, it, expect, vi } from 'vitest';

// time-off.ts pulls in the DB/Anthropic/messaging layers at import. Mock them so
// we can reach the pure pickDecisionRoute helper without side effects.
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({
  env: { ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k', SENDGRID_FROM_EMAIL: 'a@b.test', SENDGRID_FROM_NAME: 'Aegis', BASE_URL: 'http://localhost:3000', NODE_ENV: 'test' },
}));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn(), normalizeReSubject: (s: string) => s }));
vi.mock('../../ai/claude', () => ({ withAnthropicRetry: vi.fn(), generateReply: vi.fn(), classifyIntent: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));

import { pickDecisionRoute } from '../time-off';

// The bug: an employee who submitted a time-off request BY SMS got the
// approve/deny decision by EMAIL (because they happened to have an email on file).
// Batch-1 F1: SMS-FIRST for phone-holders. Previously a phone+email employee
// whose SMS origin wasn't captured (email origin, or unknown origin) got the
// approve/deny decision by EMAIL. Per the design principle + SMS spec §3.3 ("the
// employee gets the outcome in text"), any phone-holder is texted when
// EMAIL_ONLY=false; email is the fallback (on SMS send failure, or no phone).
describe('pickDecisionRoute — SMS-first for phone-holders (Batch-1 F1)', () => {
  it('SMS origin + phone available → SMS (even when an email exists)', () => {
    expect(pickDecisionRoute({ originChannel: 'sms', contactEmail: 'sam@x.com', contactPhone: '+16165550123', emailOnly: false })).toBe('sms');
  });

  it('email origin + phone available → SMS (the fix: no longer email-by-default)', () => {
    expect(pickDecisionRoute({ originChannel: 'email', contactEmail: 'sam@x.com', contactPhone: '+16165550123', emailOnly: false })).toBe('sms');
  });

  it('unknown origin (older request) + phone → SMS (the fix)', () => {
    expect(pickDecisionRoute({ originChannel: undefined, contactEmail: 'sam@x.com', contactPhone: '+16165550123', emailOnly: false })).toBe('sms');
  });

  it('no phone on file → email', () => {
    expect(pickDecisionRoute({ originChannel: 'email', contactEmail: 'sam@x.com', contactPhone: null, emailOnly: false })).toBe('email');
  });

  it('EMAIL_ONLY forces email even for a phone-holder', () => {
    expect(pickDecisionRoute({ originChannel: 'sms', contactEmail: 'sam@x.com', contactPhone: '+16165550123', emailOnly: true })).toBe('email');
  });

  it('EMAIL_ONLY + phone-only → skip (unreachable right now, do not throw)', () => {
    expect(pickDecisionRoute({ originChannel: 'sms', contactEmail: null, contactPhone: '+16165550123', emailOnly: true })).toBe('skip');
  });

  it('no contacts at all → unreachable', () => {
    expect(pickDecisionRoute({ originChannel: 'sms', contactEmail: null, contactPhone: null, emailOnly: false })).toBe('unreachable');
  });
});
