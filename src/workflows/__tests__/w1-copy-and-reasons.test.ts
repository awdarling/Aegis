import { describe, it, expect, vi } from 'vitest';

// ── W-1 branch 5 (C-7 + the "no reason given" decision) ───────────────────────
//
// Decision (Alexander, 2026-08-26): when an employee gives no reason, store NULL
// and show "no reason given" — never "personal reasons" (4 of 6 live rows had it
// invented; a manager reading it believes the employee said it).
// Plus the C-7 copy items: one time formatter (no seconds), both trade legs with
// times, approvals naming what was gained AND given up, "you're not scheduled
// this Saturday (Aug 22) — did you mean the 29th?", natural questions instead of
// "reply yes or no", sick calls + cancelling in "what can you do?", and
// "(that's a Wednesday)" when the employee's weekday doesn't match their date.

vi.mock('../../config/env', () => ({ env: { SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', BASE_URL: 'http://x', ANTHROPIC_API_KEY: 'x', SENDGRID_API_KEY: 'x', SENDGRID_FROM_EMAIL: 'a@b.c', EMAIL_ONLY: true } }));
vi.mock('../../db/client', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'is', 'like', 'order', 'limit', 'gte', 'lte', 'insert', 'update', 'delete', 'neq']) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data: null, error: null });
  chain.single = async () => ({ data: null, error: null });
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(res({ data: [], error: null }));
  return { supabase: { from: () => chain } };
});
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), normalizeReSubject: (s: string) => s, sendInThreadAck: vi.fn() }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ runSimulation: vi.fn(), getWeekBounds: vi.fn(), loadTimeOffPolicies: vi.fn(), computeWageEstimate: vi.fn() }));
vi.mock('../../lib/time-off-policies', () => ({ computeTimeOffViolations: vi.fn() }));

import { normalizeReason, reasonForManager, weekdayMismatchNote } from '../time-off';
import { buildSwapAskText, describeDayForNotScheduled, reasonAddressedToYou } from '../shift-swap';
import { buildSwapDecisionMessages } from '../../webhooks/decision';
import { buildTimeOffManagerEmail } from '../time-off-manager-email';
import { buildCapabilitiesReply, allowedActionsLine } from '../../router/capabilities';
import { formatClockRange } from '../../lib/shift-hours';

describe('no reason given — the decision', () => {
  it('normalizeReason: nothing said → null; the old invented default → null; a real reason stays', () => {
    expect(normalizeReason(undefined)).toBeNull();
    expect(normalizeReason(null)).toBeNull();
    expect(normalizeReason('')).toBeNull();
    expect(normalizeReason('personal reasons')).toBeNull();
    expect(normalizeReason('Personal reasons')).toBeNull();
    expect(normalizeReason('the watermark competition')).toBe('the watermark competition');
    expect(normalizeReason('illness')).toBe('illness');
  });
  it('reasonForManager renders "no reason given"', () => {
    expect(reasonForManager(null)).toBe('no reason given');
    expect(reasonForManager('personal reasons')).toBe('no reason given');
    expect(reasonForManager('a wedding')).toBe('a wedding');
  });
  it('the approval email card says "no reason given" when the row has none', async () => {
    const { text, html } = await buildTimeOffManagerEmail({
      time_off_request: { id: 'to-1', employee_id: 'e1', company_id: 'c1', start_date: '2026-08-21', end_date: '2026-08-21', reason: null, status: 'pending', requested_at: new Date().toISOString(), decided_at: null, decided_by: null, aegis_recommendation: null, aegis_reasoning: null, time_off_type: 'full_day', partial_days: null } as never,
      employee: { id: 'e1', name: 'Maisey Pell', company_id: 'c1', primary_role: 'Lifeguard', qualified_roles: ['Lifeguard'], max_weekly_hours: 40, contact_phone: null, contact_email: null, active: true, created_at: '', individual_wage: null, is_veteran: false } as never,
      company_id: 'c1', company_name: 'Watermark', manager_email: 'jack@x', manager_user_id: 'u1', manager_name: 'Jack',
    } as never);
    expect(text).toMatch(/Reason: no reason given/);
    expect(html).toMatch(/no reason given/);
    expect(text).not.toMatch(/personal reasons/i);
  });
});

describe('C-7 copy', () => {
  it('one time formatter — no seconds, ever', () => {
    expect(formatClockRange('11:00:00', '15:30:00')).toBe('11am–3:30pm');
  });

  it('a trade ask names BOTH legs with times and asks a natural question', () => {
    const { text } = buildSwapAskText({
      receiverName: 'Jenna Stibitz', requesterName: 'Katie Schillaci',
      shiftName: 'Flex', shiftStart: '13:00:00', shiftEnd: '20:00:00', role: 'Lifeguard', shiftDateDisplay: 'Sunday, August 23',
      targetShiftName: 'AM Weekend', targetShiftDateDisplay: 'Sunday, August 23', targetShiftStart: '09:00:00', targetShiftEnd: '15:30:00',
    });
    expect(text).toMatch(/give up your AM Weekend shift \(9am–3:30pm\) on Sunday, August 23/);
    expect(text).toMatch(/pick up Katie Schillaci's Flex shift \(1pm–8pm, Lifeguard\) on Sunday, August 23/);
    expect(text).not.toMatch(/:00:00|reply yes or no/i);
    expect(text).toMatch(/\?\s*$/);
  });

  it('a giveaway ask is a natural question too', () => {
    const { text, isGiveaway } = buildSwapAskText({
      receiverName: 'Margaret Holt', requesterName: 'Maisey Pell',
      shiftName: 'AM Weekday', shiftStart: '11:00:00', shiftEnd: '15:30:00', role: 'Lifeguard', shiftDateDisplay: 'Wednesday, August 19',
    });
    expect(isGiveaway).toBe(true);
    expect(text).toMatch(/\(11am–3:30pm, Lifeguard\)/);
    expect(text).toMatch(/Can you confirm you'll cover it\?$/);
  });

  it('an approved trade tells each person what they gained AND what they gave up', () => {
    const { requesterMsg, receiverMsg } = buildSwapDecisionMessages(
      { shift_name: 'AM Weekday', receiver_name: 'Katie Schillaci', target_shift_name: 'Flex' },
      true, 'Thursday, August 20', 'Friday, August 21',
    );
    expect(requesterMsg).toMatch(/You're now on the Flex shift on Friday, August 21/);
    expect(requesterMsg).toMatch(/your AM Weekday shift on Thursday, August 20 goes to the other side/);
    expect(receiverMsg).toMatch(/You're now on the AM Weekday shift on Thursday, August 20/);
    expect(receiverMsg).toMatch(/your Flex shift on Friday, August 21 goes to the other side/);
  });

  it('"you\'re not scheduled this Saturday (Aug 22)" instead of the log line', () => {
    expect(describeDayForNotScheduled('2026-08-22', '2026-08-17')).toBe('this Saturday (Aug 22)');
    expect(describeDayForNotScheduled('2026-09-05', '2026-08-17')).toMatch(/^on /);
  });

  it('"what can you do?" names sick calls and cancelling time off', () => {
    const reply = buildCapabilitiesReply('employee', 'Katie');
    expect(reply).toMatch(/Call in sick/);
    expect(reply).toMatch(/cancel one/);
    expect(allowedActionsLine('employee')).toMatch(/sick calls/);
  });

  it('Katie: "Tuesday August 26th" → "(that\'s a Wednesday)"; a correct weekday adds nothing', () => {
    expect(weekdayMismatchNote('I need Tuesday August 26th off', ['2026-08-26'])).toBe(" (that's a Wednesday)");
    expect(weekdayMismatchNote('I need Wednesday August 26th off', ['2026-08-26'])).toBe('');
    expect(weekdayMismatchNote('I need Aug 26 off', ['2026-08-26'])).toBe('');
    // A range that includes the named day is fine.
    expect(weekdayMismatchNote('Monday through Friday next week', ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28'])).toBe('');
  });

  it('blocked-swap copy speaks to "you"', () => {
    expect(reasonAddressedToYou('Mya Vanderzwaag has approved time off on that date.', 'Mya Vanderzwaag')).toBe('you have approved time off that day.');
  });
});
