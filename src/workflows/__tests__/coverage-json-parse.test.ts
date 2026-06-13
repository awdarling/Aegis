import { describe, it, expect, vi } from 'vitest';

// emergency-coverage.ts reads env + builds an Anthropic client at import time —
// mock those so importing the pure helper is side-effect-free.
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({
  env: { ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k', SENDGRID_FROM_EMAIL: 'a@b.test', SENDGRID_FROM_NAME: 'Aegis', BASE_URL: 'http://localhost:3000', NODE_ENV: 'test' },
}));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn() }));
vi.mock('../../ai/claude', () => ({ generateReply: vi.fn(), withAnthropicRetry: vi.fn() }));

import { coerceJsonObject, isNewCoverageRequest } from '../emergency-coverage';

type Details = { employee_name: string | null; shift_date: string; shift_name: string | null };

describe('coerceJsonObject (emergency-coverage extraction parser)', () => {
  it('parses a clean JSON object — the name is preserved', () => {
    const out = coerceJsonObject<Details>('{"employee_name":"Maisey Pell","shift_date":"2026-06-13","shift_name":null}');
    expect(out?.employee_name).toBe('Maisey Pell');
    expect(out?.shift_date).toBe('2026-06-13');
  });

  it('parses JSON wrapped in ```json fences — the old bug that blanked the name', () => {
    const fenced = '```json\n{"employee_name":"Maisey Pell","shift_date":"2026-06-13","shift_name":null}\n```';
    const out = coerceJsonObject<Details>(fenced);
    expect(out?.employee_name).toBe('Maisey Pell');
  });

  it('parses JSON when the model adds a sentence of preamble', () => {
    const prose = 'Here are the details:\n{"employee_name":"John Smith","shift_date":"2026-06-14","shift_name":"night"}';
    const out = coerceJsonObject<Details>(prose);
    expect(out?.employee_name).toBe('John Smith');
    expect(out?.shift_name).toBe('night');
  });

  it('returns null on genuinely unparseable text (caller then falls back to today)', () => {
    expect(coerceJsonObject<Details>('I could not understand that')).toBeNull();
    expect(coerceJsonObject<Details>('')).toBeNull();
  });
});

describe('isNewCoverageRequest (stop a stale session swallowing a fresh call-out)', () => {
  it('treats a fresh call-out as a new request — the reported bug', () => {
    expect(isNewCoverageRequest("Maisey Pell can't come in today, I need coverage.")).toBe(true);
  });

  it('catches common call-out phrasings', () => {
    expect(isNewCoverageRequest('John called in sick for Saturday')).toBe(true);
    expect(isNewCoverageRequest('Sarah is out tomorrow, need someone to cover')).toBe(true);
    expect(isNewCoverageRequest('can someone cover for Mike tonight')).toBe(true);
    expect(isNewCoverageRequest('Need a replacement for the AM shift')).toBe(true);
  });

  it('does NOT match a bare name reply (those are answers to "who should I contact?")', () => {
    expect(isNewCoverageRequest('Kori')).toBe(false);
    expect(isNewCoverageRequest('Kori Baumann')).toBe(false);
    expect(isNewCoverageRequest('contact Addison please')).toBe(false);
    expect(isNewCoverageRequest('the first two')).toBe(false);
    expect(isNewCoverageRequest('more')).toBe(false);
  });
});
