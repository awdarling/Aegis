import { describe, it, expect, vi } from 'vitest';

// ── Swap-direction regression suite ───────────────────────────────────────────
//
// THE BUGS (live Watermark swap testing, 2026-07-24):
//  1. "Emily is taking my 3-9 pm shift on Saturday" — a one-way giveaway (Emily
//     covers the sender's shift) was read as a two-way TRADE, so Aegis replied
//     "Emily has more than one shift that week — which of theirs do you want to
//     take?" (direction inverted).
//  2. "Colin is taking my Thursday AM" — same misread; because Colin had no shift
//     that week, Aegis dead-ended with "they'd need one of their own to give you"
//     instead of recording that Colin covers the sender's shift.
//
// ROOT CAUSE: extractSwapDetails hardcoded "swap = two-way trade, sender takes one
// of the target's shifts" with no notion of direction. The fix adds a `direction`
// (giveaway | pickup | trade); normalizeSwapExtraction is the deterministic layer
// that decides it (and routes the giveaway branch in handleInitiateSwap), and
// buildSwapAskText pins the one-way vs two-way wording of the coworker ping.
//
// LLM prose classification is verified in the sandbox; these tests pin the
// deterministic normalization + wording the fix depends on.

vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local',
    SUPABASE_SERVICE_ROLE_KEY: 'test',
    BASE_URL: 'https://test.local',
    ANTHROPIC_API_KEY: 'test',
    SENDGRID_API_KEY: 'test',
    SENDGRID_FROM_EMAIL: 'a@test.local',
    TWILIO_ACCOUNT_SID: 'test',
    TWILIO_AUTH_TOKEN: 'test',
    EMAIL_ONLY: true,
  },
}));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../ai/claude', () => ({
  generateReply: vi.fn(),
  classifyIntent: vi.fn(),
  AnthropicOverloadError: class AnthropicOverloadError extends Error {},
}));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ computeWageEstimate: vi.fn() }));

import { normalizeSwapExtraction, buildSwapAskText } from '../shift-swap';

describe('normalizeSwapExtraction — swap direction', () => {
  it('BUG 1 (Emily): "X is taking my shift" with no return shift → giveaway, not trade', () => {
    const out = normalizeSwapExtraction({
      direction: 'giveaway',
      shift_name: 'Saturday 3-9pm',
      target_employee_name: 'Emily',
      target_shift_name: null,
      target_shift_date: null,
    });
    expect(out.direction).toBe('giveaway');
    expect(out.target_employee_name).toBe('Emily');
    expect(out.target_shift_name).toBeNull();
  });

  it('BUG 2 (Colin): "Colin is taking my Thursday AM" → giveaway', () => {
    const out = normalizeSwapExtraction({
      direction: 'giveaway',
      shift_name: 'Thursday AM',
      target_employee_name: 'Colin',
      target_shift_name: null,
    });
    expect(out.direction).toBe('giveaway');
  });

  it('genuine two-way trade still resolves to trade (regression)', () => {
    const out = normalizeSwapExtraction({
      direction: 'trade',
      shift_name: 'Saturday AM',
      target_employee_name: 'Joe',
      target_shift_name: 'Friday PM',
    });
    expect(out.direction).toBe('trade');
    expect(out.target_shift_name).toBe('Friday PM');
  });

  it('pickup direction passes through', () => {
    const out = normalizeSwapExtraction({ direction: 'pickup', target_employee_name: 'Sam', target_shift_name: 'Sunday' });
    expect(out.direction).toBe('pickup');
  });

  it('fallback: missing direction + NO return shift → giveaway (never defaults to trade)', () => {
    const out = normalizeSwapExtraction({
      shift_name: 'Saturday 3-9pm',
      target_employee_name: 'Emily',
      target_shift_name: null,
    });
    expect(out.direction).toBe('giveaway');
  });

  it('fallback: missing direction + a named return shift → trade', () => {
    const out = normalizeSwapExtraction({
      shift_name: 'Saturday AM',
      target_employee_name: 'Joe',
      target_shift_name: 'Friday PM',
    });
    expect(out.direction).toBe('trade');
  });

  it('null/garbage parse → giveaway default with all nulls', () => {
    const out = normalizeSwapExtraction(null);
    expect(out.direction).toBe('giveaway');
    expect(out.shift_name).toBeNull();
    expect(out.target_employee_name).toBeNull();
    expect(out.willing_days).toEqual([]);
  });

  it('willing_days keeps only integers 0..6', () => {
    const out = normalizeSwapExtraction({ willing_days: [1, 3, 7, -1, 2.5, 'x', 6] as unknown as number[] });
    expect(out.willing_days).toEqual([1, 3, 6]);
  });
});

describe('buildSwapAskText — coworker ping wording', () => {
  const base = {
    receiverName: 'Emily Vander Heide',
    requesterName: 'Alex',
    shiftName: 'Saturday PM',
    shiftStart: '15:00',
    shiftEnd: '21:00',
    role: 'Lifeguard',
    shiftDateDisplay: 'Saturday, July 25',
  };

  it('giveaway (no return shift): asks to COVER, never says "trade"', () => {
    const ask = buildSwapAskText({ ...base, targetShiftName: null });
    expect(ask.isGiveaway).toBe(true);
    expect(ask.text).toContain('agreed to take');
    expect(ask.text.toLowerCase()).toContain('cover');
    expect(ask.text.toLowerCase()).not.toContain('trade');
    expect(ask.text.toLowerCase()).not.toContain('give up your');
    expect(ask.subject).toBe('Shift coverage request from Alex');
  });

  it('trade (return shift named): says trade and names both shifts', () => {
    const ask = buildSwapAskText({
      ...base,
      targetShiftName: 'Friday AM',
      targetShiftDateDisplay: 'Friday, July 24',
    });
    expect(ask.isGiveaway).toBe(false);
    expect(ask.text.toLowerCase()).toContain('trade shifts');
    expect(ask.text).toContain('give up your Friday AM shift');
    expect(ask.subject).toBe('Shift trade request from Alex');
  });
});
