import { describe, it, expect, vi } from 'vitest';

// subtractWindows lives in employee-onboarding.ts, which constructs an Anthropic
// client + reads env at module load — mock those so the import is side-effect-free.
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({
  env: { ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k', SENDGRID_FROM_EMAIL: 'a@b.test', SENDGRID_FROM_NAME: 'Aegis', BASE_URL: 'http://localhost:3000', NODE_ENV: 'test' },
}));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn() }));
vi.mock('../../ai/claude', () => ({ withAnthropicRetry: vi.fn() }));

import { subtractWindows, applyNegativeRemovals, type AvailabilitySlot } from '../employee-onboarding';

const slot = (day: number, start: string, end: string): AvailabilitySlot => ({ day_of_week: day, start_time: start, end_time: end });

describe('subtractWindows (negative availability)', () => {
  it('drops a whole day when a full-day window is removed ("can\'t work Wednesdays")', () => {
    const current = [slot(1, '09:00', '21:00'), slot(3, '09:00', '21:00'), slot(5, '09:00', '21:00')];
    const remove = [slot(3, '09:00', '21:00'), slot(5, '09:00', '21:00')]; // Wed + Fri full
    expect(subtractWindows(current, remove)).toEqual([slot(1, '09:00', '21:00')]);
  });

  it('trims the front when a morning is removed ("no Monday mornings")', () => {
    const current = [slot(1, '09:00', '21:00')];
    const remove = [slot(1, '09:00', '12:00')]; // morning
    expect(subtractWindows(current, remove)).toEqual([slot(1, '12:00', '21:00')]);
  });

  it('splits a slot into two when a midday window is removed', () => {
    const current = [slot(1, '09:00', '21:00')];
    const remove = [slot(1, '12:00', '13:00')];
    expect(subtractWindows(current, remove)).toEqual([slot(1, '09:00', '12:00'), slot(1, '13:00', '21:00')]);
  });

  it('leaves a slot untouched when the removal does not overlap', () => {
    const current = [slot(1, '09:00', '12:00')];
    const remove = [slot(1, '13:00', '17:00')];
    expect(subtractWindows(current, remove)).toEqual([slot(1, '09:00', '12:00')]);
  });

  it('leaves other days untouched', () => {
    const current = [slot(3, '09:00', '17:00')];
    const remove = [slot(1, '09:00', '21:00')]; // Monday removal, current is Wednesday
    expect(subtractWindows(current, remove)).toEqual([slot(3, '09:00', '17:00')]);
  });

  it('returns nothing when the removal fully covers the only slot', () => {
    const current = [slot(1, '10:00', '14:00')];
    const remove = [slot(1, '09:00', '21:00')];
    expect(subtractWindows(current, remove)).toEqual([]);
  });

  it('full-week default: "can\'t work Mon & Wed" with nothing on file → available the other 5 days', () => {
    // Mirrors the handler\'s empty-availability path: start from a full operating
    // week (all 7 days, full hours) and subtract the negated whole days.
    const fullWeek = [0, 1, 2, 3, 4, 5, 6].map(d => slot(d, '09:00', '21:00'));
    const remove = [slot(1, '09:00', '21:00'), slot(3, '09:00', '21:00')]; // Mon + Wed
    expect(subtractWindows(fullWeek, remove)).toEqual([
      slot(0, '09:00', '21:00'),
      slot(2, '09:00', '21:00'),
      slot(4, '09:00', '21:00'),
      slot(5, '09:00', '21:00'),
      slot(6, '09:00', '21:00'),
    ]);
  });
});

describe('applyNegativeRemovals (whole-day drop vs partial trim)', () => {
  const bounds = { earliest_start: '09:00', latest_end: '21:15' };
  const fullWeek = () => [0, 1, 2, 3, 4, 5, 6].map(d => slot(d, '09:00', '21:15'));

  it('clean whole-day removal (00:00–23:59) drops Mon + Wed entirely — no sliver', () => {
    const result = applyNegativeRemovals(fullWeek(), [slot(1, '00:00', '23:59'), slot(3, '00:00', '23:59')], bounds);
    expect(result.map(s => s.day_of_week)).toEqual([0, 2, 4, 5, 6]);
  });

  it('IMPRECISE whole-day removal (09:00–21:00, ~9pm not 9:15pm) still drops the day — the bug fix', () => {
    const result = applyNegativeRemovals(fullWeek(), [slot(1, '09:00', '21:00')], bounds);
    // Monday must be GONE, not left as a 9:00pm–9:15pm sliver.
    expect(result.some(s => s.day_of_week === 1)).toBe(false);
    expect(result.map(s => s.day_of_week)).toEqual([0, 2, 3, 4, 5, 6]);
  });

  it('partial removal ("Monday mornings", 09:00–12:00) trims, keeps the rest of Monday', () => {
    const result = applyNegativeRemovals(fullWeek(), [slot(1, '09:00', '12:00')], bounds);
    expect(result.find(s => s.day_of_week === 1)).toEqual(slot(1, '12:00', '21:15'));
  });

  it('partial evening removal ("no Monday evenings", 17:00–21:15) keeps Monday daytime', () => {
    const result = applyNegativeRemovals(fullWeek(), [slot(1, '17:00', '21:15')], bounds);
    expect(result.find(s => s.day_of_week === 1)).toEqual(slot(1, '09:00', '17:00'));
  });

  it('subtracts from existing availability when on file (whole-day clears that day)', () => {
    const current = [slot(1, '09:00', '17:00'), slot(3, '09:00', '17:00')];
    const result = applyNegativeRemovals(current, [slot(1, '00:00', '23:59')], bounds);
    expect(result).toEqual([slot(3, '09:00', '17:00')]);
  });
});
