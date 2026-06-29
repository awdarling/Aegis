import { describe, it, expect, vi } from 'vitest';

// time-off.ts pulls in the DB/Anthropic/messaging layers at import. Mock them so
// we can reach the pure resolvePartialWindow helper without side effects.
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

import { resolvePartialWindow } from '../time-off';

// Minimal entry shape for the resolver.
const entry = (over: Record<string, unknown>) => ({
  start_date: '2026-06-29', end_date: '2026-06-29', time_off_type: 'partial' as const,
  period_label: null, start_time: null, end_time: null, ...over,
}) as Parameters<typeof resolvePartialWindow>[0];

describe('resolvePartialWindow', () => {
  it('keeps an explicit two-sided window', () => {
    expect(resolvePartialWindow(entry({ start_time: '10:00', end_time: '13:00' })))
      .toEqual({ start_time: '10:00', end_time: '13:00' });
  });

  // Quin's case: "June 29 after 4pm" → off from 16:00 through the day's close.
  it('fills the close for an open-ended "after X" window (start only)', () => {
    expect(resolvePartialWindow(entry({ start_time: '16:00', end_time: null })))
      .toEqual({ start_time: '16:00', end_time: '21:00' });
  });

  it('fills the open for an "until X" / "before X" window (end only)', () => {
    expect(resolvePartialWindow(entry({ start_time: null, end_time: '14:00' })))
      .toEqual({ start_time: '09:00', end_time: '14:00' });
  });

  it('resolves named periods', () => {
    expect(resolvePartialWindow(entry({ period_label: 'morning' }))).toEqual({ start_time: '09:00', end_time: '13:00' });
    expect(resolvePartialWindow(entry({ period_label: 'evening' }))).toEqual({ start_time: '17:00', end_time: '21:00' });
  });

  it('returns null when there is nothing partial to resolve (→ treated as full day)', () => {
    expect(resolvePartialWindow(entry({}))).toBeNull();
  });
});
