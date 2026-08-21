import { describe, it, expect, vi } from 'vitest';

// operational-query.ts constructs the Anthropic client + reads env/db at load;
// mock those so we can reach the pure copy helpers side-effect-free.
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({
  env: { ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k', SENDGRID_FROM_EMAIL: 'a@b.test', SENDGRID_FROM_NAME: 'Aegis', BASE_URL: 'http://localhost:3000', NODE_ENV: 'test' },
}));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn() }));
vi.mock('../../ai/claude', () => ({ generateReply: vi.fn(), withAnthropicRetry: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ computeWageEstimate: vi.fn() }));

import { formatPlainValue, buildUpdateConfirmation, normalizeFieldName } from '../operational-query';

describe('formatPlainValue', () => {
  it('prints strings without quotes (the JSON.stringify bug)', () => {
    expect(formatPlainValue('32')).toBe('32');
    expect(formatPlainValue('open')).toBe('open');
  });
  it('formats numbers, booleans, null, and arrays plainly', () => {
    expect(formatPlainValue(32)).toBe('32');
    expect(formatPlainValue(true)).toBe('yes');
    expect(formatPlainValue(false)).toBe('no');
    expect(formatPlainValue(null)).toBe('not set');
    expect(formatPlainValue(undefined)).toBe('not set');
    expect(formatPlainValue([1, 2, 3])).toBe('1, 2, 3');
  });
});

describe('buildUpdateConfirmation', () => {
  it('asks naturally with no (yes/no) mechanic and no quoted values', () => {
    const msg = buildUpdateConfirmation(
      { entity_name: 'Jordan', field: 'max_weekly_hours', new_value: 32 } as never,
      40,
      '',
    );
    expect(msg).toContain("Jordan's max weekly hours is currently 40");
    expect(msg).toContain('Want me to change it to 32');
    expect(msg).not.toContain('(yes/no)');
    expect(msg).not.toContain('"32"');
  });
});

describe('normalizeFieldName (edit field synonyms, batch 3c)', () => {
  it('maps max-hours phrasings to max_weekly_hours', () => {
    for (const p of ['max hours', 'Max Hours', 'weekly cap', 'hour cap', 'max weekly hours', 'max hrs']) {
      expect(normalizeFieldName(p)).toBe('max_weekly_hours');
    }
  });
  it('passes real column names through unchanged', () => {
    expect(normalizeFieldName('max_weekly_hours')).toBe('max_weekly_hours');
    expect(normalizeFieldName('active')).toBe('active');
    expect(normalizeFieldName('contact_phone')).toBe('contact_phone');
  });
  it('maps other common synonyms', () => {
    expect(normalizeFieldName('role')).toBe('primary_role');
    expect(normalizeFieldName('phone')).toBe('contact_phone');
    expect(normalizeFieldName('email address')).toBe('contact_email');
  });
});
