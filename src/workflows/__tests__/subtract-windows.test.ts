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

import { subtractWindows, type AvailabilitySlot } from '../employee-onboarding';

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
