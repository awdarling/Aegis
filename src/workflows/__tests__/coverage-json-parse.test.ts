import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { coerceJsonObject, isNewCoverageRequest, extractOutreachNames, swapScheduleAssignment, isContactAll, type ScheduleAssignment } from '../emergency-coverage';
import { generateReply } from '../../ai/claude';
import type { Mock } from 'vitest';

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

describe('extractOutreachNames (manager reply → who to contact)', () => {
  const mockReply = generateReply as unknown as Mock;
  beforeEach(() => mockReply.mockReset());

  it('extracts a bare name even when the model wraps it in ```json fences — the reported bug', async () => {
    mockReply.mockResolvedValue('```json\n{"names":["Shmubba"]}\n```');
    expect(await extractOutreachNames('Shmubba')).toEqual(['Shmubba']);
  });

  it('extracts names when the model adds preamble', async () => {
    mockReply.mockResolvedValue('Sure thing: {"names":["Kori Baumann","Mia"]}');
    expect(await extractOutreachNames('Kori and Mia')).toEqual(['Kori Baumann', 'Mia']);
  });

  it('returns empty list for a genuine decline', async () => {
    mockReply.mockResolvedValue('{"names":[]}');
    expect(await extractOutreachNames("never mind, I'll handle it")).toEqual([]);
  });

  it('drops blank/whitespace entries defensively', async () => {
    mockReply.mockResolvedValue('{"names":["Shmubba",""," "]}');
    expect(await extractOutreachNames('Shmubba')).toEqual(['Shmubba']);
  });
});

describe('swapScheduleAssignment (put the coverer on the schedule)', () => {
  const a = (over: Partial<ScheduleAssignment>): ScheduleAssignment => ({
    date: '2026-06-13', employee_id: 'absent', employee_name: 'Test Guard A',
    shift_name: 'PM Lifeguard', role: 'Lifeguard', start_time: '15:00:00', end_time: '21:00:00', hours: 6,
    ...over,
  });

  it('swaps the absent employee for the coverer on the matching shift', () => {
    const before = [a({}), a({ date: '2026-06-14' })];
    const { assignments, swapped } = swapScheduleAssignment(before, {
      shift_date: '2026-06-13', start_time: '15:00:00',
      absent_employee_id: 'absent', coverer_employee_id: 'cover', coverer_name: 'Shmubba Sploosh',
    });
    expect(swapped).toBe(true);
    expect(assignments[0].employee_id).toBe('cover');
    expect(assignments[0].employee_name).toBe('Shmubba Sploosh');
    expect(assignments[0].role).toBe('Lifeguard'); // shift details unchanged
    expect(assignments[1].employee_id).toBe('absent'); // other days untouched
  });

  it('tolerates HH:MM vs HH:MM:SS start-time formats', () => {
    const { swapped } = swapScheduleAssignment([a({ start_time: '15:00' })], {
      shift_date: '2026-06-13', start_time: '15:00:00',
      absent_employee_id: 'absent', coverer_employee_id: 'cover', coverer_name: 'X',
    });
    expect(swapped).toBe(true);
  });

  it('does not swap when the absent employee is not on that shift/date', () => {
    const before = [a({ employee_id: 'someone_else' })];
    const { assignments, swapped } = swapScheduleAssignment(before, {
      shift_date: '2026-06-13', start_time: '15:00:00',
      absent_employee_id: 'absent', coverer_employee_id: 'cover', coverer_name: 'X',
    });
    expect(swapped).toBe(false);
    expect(assignments[0].employee_id).toBe('someone_else');
  });
});

describe('isContactAll (manager chose "everyone" vs a specific name)', () => {
  it('matches blanket "contact everyone" phrasings', () => {
    ['all', 'everyone', 'All of them', 'reach out to all', 'contact all', 'text all', 'the whole list', 'everyone on the list']
      .forEach(s => expect(isContactAll(s)).toBe(true));
  });

  it('does NOT match a specific-name reply', () => {
    ['Kori', 'Kori Baumann', 'contact Addison', 'Shmubba and Mia', 'the first two']
      .forEach(s => expect(isContactAll(s)).toBe(false));
  });
});
