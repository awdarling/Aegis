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

import { resolvePartialWindow, availabilityFollowupNote } from '../time-off';

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

  // W-1 branch 2 (C-4 / J-1a): the open side of a one-sided window comes from the
  // employee's REAL shift that day, never from a hard-coded 09:00 / 21:00 "operating
  // day". With no shift there is no honest answer → null (the caller asks).
  const shift = { start_time: '11:00', end_time: '15:30' }; // Katie's AM Weekday
  it('"after 3pm" on an 11–3:30 shift → 15:00–15:30; with no shift → null', () => {
    expect(resolvePartialWindow(entry({ start_time: '15:00', end_time: null }), shift))
      .toEqual({ start_time: '15:00', end_time: '15:30' });
    expect(resolvePartialWindow(entry({ start_time: '16:00', end_time: null }))).toBeNull();
  });

  it('"until 2pm" on an 11–3:30 shift → 11:00–14:00; with no shift → null', () => {
    expect(resolvePartialWindow(entry({ start_time: null, end_time: '14:00' }), shift))
      .toEqual({ start_time: '11:00', end_time: '14:00' });
    expect(resolvePartialWindow(entry({ start_time: null, end_time: '14:00' }))).toBeNull();
  });

  it('a period word alone ("the morning") means the SHIFT\'s hours, never 09:00–13:00 / 17:00–21:00', () => {
    expect(resolvePartialWindow(entry({ period_label: 'morning' }), shift)).toEqual({ start_time: '11:00', end_time: '15:30' });
    expect(resolvePartialWindow(entry({ period_label: 'evening' }))).toBeNull();
  });

  it('returns null when there is nothing partial to resolve (→ treated as full day)', () => {
    expect(resolvePartialWindow(entry({}))).toBeNull();
  });
});

// #14.5c — a combined time-off + availability email confirms only the time off and
// asks for the availability separately.
describe('availabilityFollowupNote', () => {
  it('adds a "send availability separately" P.S. when the flag is set', () => {
    const note = availabilityFollowupNote({ also_mentions_availability: true });
    expect(note).toMatch(/availability/i);
    expect(note).toMatch(/separate|its own message/i);
  });

  it('is empty when no availability was mentioned', () => {
    expect(availabilityFollowupNote({})).toBe('');
    expect(availabilityFollowupNote({ also_mentions_availability: false })).toBe('');
  });
});
