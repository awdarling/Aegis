import { describe, it, expect, vi } from 'vitest';

// employee-onboarding constructs the Anthropic client + reads env at load; mock
// those so importing the module to reach the pure helpers is side-effect-free.
// NOTE: '../time-off' is intentionally NOT mocked — isOnboardingTimeOffConfirm
// reuses the REAL isTimeOffAffirmation so the test proves onboarding and the
// normal time-off flow agree on what counts as "send it".
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

import {
  isOnboardingTimeOffConfirm,
  coalesceDateEntries,
  extractOnboardingReason,
} from '../employee-onboarding';

// ── Issue 2: onboarding TO confirm parsing must match the normal flow ─────────
describe('isOnboardingTimeOffConfirm', () => {
  it('accepts natural confirmations that classifyAffirmation alone dropped', () => {
    for (const s of [
      'yes',
      "yeah that's right",
      'yep send it',
      'looks good, go ahead',
      'that works',
      'sounds good send it',
      'go for it',
      'please do',
      'perfect, send it over',
    ]) {
      expect(isOnboardingTimeOffConfirm(s), s).toBe(true);
    }
  });

  it('does NOT treat a correction as a clean yes (falls through to the edit branch)', () => {
    for (const s of [
      'yeah but make it the 21st',
      'yes actually change it to Friday',
      "no that's wrong",
      'not quite',
      'instead do the 5th',
    ]) {
      expect(isOnboardingTimeOffConfirm(s), s).toBe(false);
    }
  });
});

// ── Issue 3: a contiguous range must be ONE request, not two ──────────────────
describe('coalesceDateEntries', () => {
  it('merges two adjacent full-day rows (a split weekend) into one range', () => {
    const out = coalesceDateEntries([
      { start_date: '2026-08-08', end_date: '2026-08-08', time_off_type: 'full_day' },
      { start_date: '2026-08-09', end_date: '2026-08-09', time_off_type: 'full_day' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].start_date).toBe('2026-08-08');
    expect(out[0].end_date).toBe('2026-08-09');
  });

  it('merges overlapping ranges and keeps the later end date', () => {
    const out = coalesceDateEntries([
      { start_date: '2026-08-08', end_date: '2026-08-10', time_off_type: 'full_day' },
      { start_date: '2026-08-09', end_date: '2026-08-11', time_off_type: 'full_day' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].end_date).toBe('2026-08-11');
  });

  it('leaves genuinely separate dates as distinct requests', () => {
    const out = coalesceDateEntries([
      { start_date: '2026-08-05', end_date: '2026-08-05', time_off_type: 'full_day' },
      { start_date: '2026-08-20', end_date: '2026-08-20', time_off_type: 'full_day' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('does not merge a partial day into an adjacent full day', () => {
    const out = coalesceDateEntries([
      { start_date: '2026-08-08', end_date: '2026-08-08', time_off_type: 'partial', period_label: 'afternoon' },
      { start_date: '2026-08-09', end_date: '2026-08-09', time_off_type: 'full_day' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('merges adjacent partials that share the same window', () => {
    const out = coalesceDateEntries([
      { start_date: '2026-08-08', end_date: '2026-08-08', time_off_type: 'partial', period_label: 'morning' },
      { start_date: '2026-08-09', end_date: '2026-08-09', time_off_type: 'partial', period_label: 'morning' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].end_date).toBe('2026-08-09');
  });
});

// ── Issue 4: capture a reason the employee adds on confirmation ───────────────
describe('extractOnboardingReason', () => {
  it('pulls the reason out of a context-adding confirmation', () => {
    expect(extractOnboardingReason("yes, it's for a family wedding")).toBe('a family wedding');
    expect(extractOnboardingReason('yep — going to a wedding')).toBe('wedding');
    expect(extractOnboardingReason('sounds good, because I am traveling')).toBe('I am traveling');
    expect(extractOnboardingReason('send it, to attend my sister’s graduation')).toMatch(/graduation/);
  });

  it('returns null for a bare confirmation with no reason', () => {
    for (const s of ['yes', 'yep send it', 'looks good, go ahead', 'that works', 'yes that works for me']) {
      expect(extractOnboardingReason(s), s).toBeNull();
    }
  });
});
