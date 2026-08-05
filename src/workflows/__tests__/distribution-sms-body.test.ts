import { describe, it, expect } from 'vitest';

// schedule-build pulls in Supabase, messaging, and the Anthropic client at
// import — mock those so we can reach the pure SMS-body helper (mirrors
// distribute-select.test.ts).
import { vi } from 'vitest';
vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local', SUPABASE_SERVICE_ROLE_KEY: 'test', BASE_URL: 'https://test.local',
    ANTHROPIC_API_KEY: 'test', SENDGRID_API_KEY: 'test', SENDGRID_FROM_EMAIL: 'a@test.local',
    EMAIL_ONLY: false,
  },
}));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../ai/claude', () => ({
  generateReply: vi.fn(), classifyIntent: vi.fn(), withAnthropicRetry: vi.fn(),
  AnthropicOverloadError: class AnthropicOverloadError extends Error {},
}));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn(), getTenantSmsNumber: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn(), normalizeReSubject: (s: string) => s }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));

import { buildDistributionSmsBody } from '../schedule-build';

const WEEK = 'Aug 11–17';
const EMAIL_LINE = "Your full schedule and the whole team's is in your email.";
const UPDATED_EMAIL_LINE = "Your full updated schedule and the whole team's is in your email.";

// Two shifts, deliberately out of date order so we also prove the helper sorts.
const shifts = [
  { date: '2026-08-13', shift_name: 'AM Lifeguard', start_time: '09:00', end_time: '13:00' },
  { date: '2026-08-11', shift_name: 'PM Lifeguard', start_time: '15:00', end_time: '21:00' },
];

describe('buildDistributionSmsBody — Bug 2 spec', () => {
  it('phone+email with shifts: lists shifts (sorted) AND points to email', () => {
    const body = buildDistributionSmsBody({ weekLabel: WEEK, shifts, hasEmail: true });
    expect(body).toContain(`Your shifts for ${WEEK}:`);
    expect(body).toContain('PM Lifeguard 3:00 PM-9:00 PM');
    expect(body).toContain('AM Lifeguard 9:00 AM-1:00 PM');
    expect(body).toContain('Aug 11');
    expect(body).toContain('Aug 13');
    expect(body).toContain(EMAIL_LINE);
    // sorted: Aug 11 line appears before Aug 13 line
    expect(body.indexOf('Aug 11')).toBeLessThan(body.indexOf('Aug 13'));
  });

  it('phone-only (no email) with shifts: shifts-only, NO email pointer', () => {
    const body = buildDistributionSmsBody({ weekLabel: WEEK, shifts, hasEmail: false });
    expect(body).toContain(`Your shifts for ${WEEK}:`);
    expect(body).toContain('PM Lifeguard 3:00 PM-9:00 PM');
    expect(body).not.toContain('in your email');
  });

  it('phone+email with NO shifts: off-week note + team-schedule-in-email pointer', () => {
    const body = buildDistributionSmsBody({ weekLabel: WEEK, shifts: [], hasEmail: true });
    expect(body).toContain(`You're not on the schedule for ${WEEK}`);
    expect(body).toContain('enjoy the week off');
    expect(body).toContain("The team's full schedule is in your email.");
  });

  it('phone-only with NO shifts: off-week note only', () => {
    const body = buildDistributionSmsBody({ weekLabel: WEEK, shifts: [], hasEmail: false });
    expect(body).toContain('enjoy the week off');
    expect(body).not.toContain('email');
  });

  it('updated=true with shifts+email: "updated shifts" header + updated email pointer', () => {
    const body = buildDistributionSmsBody({ weekLabel: WEEK, shifts, hasEmail: true, updated: true });
    expect(body).toContain(`Your updated shifts for ${WEEK}:`);
    expect(body).toContain('PM Lifeguard 3:00 PM-9:00 PM');
    expect(body).toContain(UPDATED_EMAIL_LINE);
  });

  it('updated=true with NO shifts: dropped-from-schedule note', () => {
    const body = buildDistributionSmsBody({ weekLabel: WEEK, shifts: [], hasEmail: true, updated: true });
    expect(body).toContain("you're no longer on the schedule this week");
    expect(body).toContain("The team's full schedule is in your email.");
  });

  it('stays in the GSM-7 charset (no en-dash/em-dash) so SMS is not forced to UCS-2', () => {
    const body = buildDistributionSmsBody({ weekLabel: 'Aug 11 - 17', shifts, hasEmail: true });
    expect(body).not.toContain('–'); // en dash
    expect(body).not.toContain('—'); // em dash
  });

  it('does not mutate the caller\'s shifts array', () => {
    const input = shifts.slice();
    const order = input.map((s) => s.date);
    buildDistributionSmsBody({ weekLabel: WEEK, shifts: input, hasEmail: true });
    expect(input.map((s) => s.date)).toEqual(order);
  });
});
