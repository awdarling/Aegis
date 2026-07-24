import { describe, it, expect, vi } from 'vitest';

// schedule-build.ts imports env + supabase at load — mock them (same pattern as
// fairness-cross-week) so we can import the PURE foldPriorHours helper.
vi.mock('../../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local', SUPABASE_SERVICE_ROLE_KEY: 'test', BASE_URL: 'https://test.local',
    ANTHROPIC_API_KEY: 'test', SENDGRID_API_KEY: 'test', SENDGRID_FROM_EMAIL: 'a@test.local',
    TWILIO_ACCOUNT_SID: 'test', TWILIO_AUTH_TOKEN: 'test',
  },
}));
vi.mock('../../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../../ai/claude', () => ({
  generateReply: vi.fn(), classifyIntent: vi.fn(), withAnthropicRetry: vi.fn(),
  AnthropicOverloadError: class AnthropicOverloadError extends Error {},
}));
vi.mock('../../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn(), normalizeReSubject: (s: string) => s }));
vi.mock('../../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../schedule-simulator', () => ({ computeWageEstimate: vi.fn() }));

import { foldPriorHours, type PriorWeekHours } from '../../../workflows/schedule-build';

function wk(hours: Record<string, number>, to: string[] = []): PriorWeekHours {
  return { hoursByEmp: new Map(Object.entries(hours)), toEmps: new Set(to) };
}
const DECAY = 0.5;

describe('FAIRNESS-3 · time off is not read as under-worked', () => {
  // MICH worked a lot (no TO); NORM normal (no TO); LUCAS was on approved time
  // off EVERY recent week, so his raw hours are near zero.
  const weeks: PriorWeekHours[] = [
    wk({ MICH: 28, NORM: 14, LUCAS: 6 }, ['LUCAS']),
    wk({ MICH: 19, NORM: 14, LUCAS: 6 }, ['LUCAS']),
    wk({ MICH: 25, NORM: 14, LUCAS: 4 }, ['LUCAS']),
  ];

  it('WITHOUT exclusion, the vacationer looks the most under-worked (the bug)', () => {
    const off = foldPriorHours(weeks, DECAY, false);
    expect(off.get('LUCAS')!).toBeCloseTo(6 + 3 + 1, 5);      // 10 — lowest, would rank FIRST next week
    expect(off.get('MICH')!).toBeCloseTo(28 + 9.5 + 6.25, 5); // 43.75
    expect(off.get('NORM')!).toBeCloseTo(24.5, 5);
    expect(off.get('LUCAS')!).toBeLessThan(off.get('NORM')!); // Lucas below a normal peer
  });

  it('WITH exclusion, the vacationer is imputed to a normal week (no longer front-loaded)', () => {
    const on = foldPriorHours(weeks, DECAY, true);
    // No non-TO week for LUCAS → roster normal-week average (114/6 = 19) imputed each week.
    expect(on.get('LUCAS')!).toBeCloseTo(19 * (1 + 0.5 + 0.25), 5); // 33.25
    expect(on.get('LUCAS')!).toBeGreaterThan(foldPriorHours(weeks, DECAY, false).get('LUCAS')!);
    expect(on.get('LUCAS')!).toBeGreaterThan(on.get('NORM')!);      // no longer the most-owed
    // Employees with no time off are completely unaffected.
    expect(on.get('MICH')!).toBeCloseTo(43.75, 5);
    expect(on.get('NORM')!).toBeCloseTo(24.5, 5);
  });

  it('a genuinely under-worked employee (no time off) is NOT imputed — still ranks up', () => {
    const w: PriorWeekHours[] = [
      wk({ MICH: 28, UNDER: 0 }), wk({ MICH: 19, UNDER: 0 }), wk({ MICH: 25, UNDER: 6 }),
    ];
    const on = foldPriorHours(w, DECAY, true);
    const off = foldPriorHours(w, DECAY, false);
    expect(on.get('UNDER') ?? 0).toBeCloseTo(off.get('UNDER') ?? 0, 5); // unchanged
    expect(on.get('UNDER') ?? 0).toBeLessThan(on.get('MICH')!);          // stays low → boosted
  });

  it('a partial vacationer is imputed to THEIR OWN typical, not the roster average', () => {
    const w: PriorWeekHours[] = [
      wk({ PART: 5, X: 10 }, ['PART']),  // TO week, actual 5
      wk({ PART: 20, X: 10 }),           // worked
      wk({ PART: 20, X: 10 }),           // worked
    ];
    const off = foldPriorHours(w, DECAY, false);
    const on = foldPriorHours(w, DECAY, true);
    expect(off.get('PART')!).toBeCloseTo(5 + 10 + 5, 5);   // 20 (raw)
    expect(on.get('PART')!).toBeCloseTo(20 + 10 + 5, 5);   // week0 imputed to own typical (20)
    expect(on.get('PART')!).toBeGreaterThan(off.get('PART')!);
  });

  it('empty history yields an empty map', () => {
    expect(foldPriorHours([], DECAY, true).size).toBe(0);
  });
});
