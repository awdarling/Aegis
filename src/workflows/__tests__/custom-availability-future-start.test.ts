import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Feature A: FUTURE-START custom availability ("weekends-only starting <date>") ─
//
// Supabase + messaging FULLY MOCKED. Asserts the understand-and-save layer for a
// change that BEGINS on a future date:
//   • handleUpdateAvailability surfaces extracted.effective_start_date onto the
//     pending (custom_end_date stays null for an open-ended future-start), routes it
//     as an override (never touches the permanent availability table), and the
//     employee confirmation states the start date.
//   • A start date in the past/today is ignored (treated as immediate).
//   • applyCustomAvailabilityDecision APPROVE writes a custom_availability row with
//     effective_start_date set and end_date null (open-ended) — NOT a plain
//     availability edit.
//   • The future-window case (start + end) carries both.
//   • resolveChangeKind classifies a future-start override as date_limited (additive
//     in the ledger), never 'permanent'.

const h = vi.hoisted(() => {
  type Recorded = { table: string; op: string; rows?: unknown; filters: Record<string, unknown> };
  const recorded: Recorded[] = [];
  function makeBuilder(table: string) {
    const state: { op: string; rows?: unknown; filters: Record<string, unknown> } = { op: 'select', filters: {} };
    const builder: Record<string, unknown> = {
      delete() { state.op = 'delete'; return builder; },
      insert(rows: unknown) { state.op = 'insert'; state.rows = rows; return builder; },
      update(rows: unknown) { state.op = 'update'; state.rows = rows; return builder; },
      select() { return builder; },
      eq(col: string, val: unknown) { state.filters[col] = val; return builder; },
      in() { return builder; },
      is() { return builder; },
      limit() { return builder; },
      maybeSingle() { recorded.push({ table, op: state.op, filters: state.filters }); return Promise.resolve({ data: null, error: null }); },
      single() { recorded.push({ table, op: state.op, filters: state.filters }); return Promise.resolve({ data: null, error: null }); },
      then(onF: (v: { data: null; error: null }) => unknown, onR?: (e: unknown) => unknown) {
        recorded.push({ table, op: state.op, rows: state.rows, filters: state.filters });
        return Promise.resolve({ data: null, error: null }).then(onF, onR);
      },
    };
    return builder;
  }
  const replyMock = vi.fn(async () => {});
  const withAnthropicRetryMock = vi.fn();
  return { recorded, makeBuilder, replyMock, withAnthropicRetryMock };
});

vi.mock('@anthropic-ai/sdk', () => ({ default: class MockAnthropic { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({
  env: {
    ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k',
    SENDGRID_FROM_EMAIL: 'aegis@test.local', SENDGRID_FROM_NAME: 'Aegis', BASE_URL: 'http://localhost:3000', NODE_ENV: 'test',
  },
}));
vi.mock('../../db/client', () => ({ supabase: { from: (t: string) => h.makeBuilder(t) } }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn(async () => {}) }));
vi.mock('../../messaging/reply', () => ({ reply: h.replyMock, sendInThreadAck: vi.fn(async () => {}) }));
vi.mock('../../ai/claude', () => ({ withAnthropicRetry: h.withAnthropicRetryMock }));

import {
  applyCustomAvailabilityDecision,
  handleUpdateAvailability,
  type AvailabilitySlot,
} from '../employee-onboarding';
import { resolveChangeKind } from '../availability-change-requests';
import type { InboundMessage, VerifiedContact } from '../../security/types';

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const EMPLOYEE_ID = 'e1684385-ab46-472d-82b8-9009cd705bde';
// A date safely in the future relative to whenever the suite runs (the immediate-vs-
// future gate compares against the real clock).
const FUTURE_START = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
const FUTURE_END = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
const PROPOSED: AvailabilitySlot[] = [
  { day_of_week: 0, start_time: '09:00', end_time: '17:00' },
  { day_of_week: 6, start_time: '09:00', end_time: '17:00' },
];

beforeEach(() => {
  h.recorded.length = 0;
  h.replyMock.mockClear();
});

describe('resolveChangeKind — future-start override is date_limited (additive), not permanent', () => {
  it('effective_start_date alone → date_limited', () => {
    expect(resolveChangeKind({ effective_start_date: FUTURE_START })).toBe('date_limited');
  });
  it('effective_start_date + custom_end_date → date_limited', () => {
    expect(resolveChangeKind({ effective_start_date: FUTURE_START, custom_end_date: FUTURE_END })).toBe('date_limited');
  });
  it('no dates → permanent (unchanged)', () => {
    expect(resolveChangeKind({})).toBe('permanent');
  });
});

describe('handleUpdateAvailability — future-start intake', () => {
  const contact: VerifiedContact = {
    role: 'employee',
    company_id: COMPANY_ID,
    employee_id: EMPLOYEE_ID,
    user_id: null,
    name: 'Shmubba Sploosh',
    matched_identifier: '+15551112222',
    channel: 'sms',
  };
  const message: InboundMessage = {
    sender: '+15551112222',
    recipient: '+15559998888',
    body: 'make me weekends-only starting later this month',
    channel: 'sms',
  };

  function pendingFromMemory(): Record<string, unknown> {
    const insert = h.recorded.find(r => r.table === 'aegis_memory' && r.op === 'insert');
    expect(insert).toBeDefined();
    return JSON.parse((insert!.rows as { content: string }).content) as Record<string, unknown>;
  }

  beforeEach(() => {
    h.withAnthropicRetryMock.mockReset();
    h.withAnthropicRetryMock.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ mode: 'set', slots: PROPOSED }) }],
    });
  });

  it('a future "starting <date>" becomes an override pending (effective_start_date set, custom_end_date null), never touches permanent availability, and the employee sees the start framing', async () => {
    await handleUpdateAvailability(message, contact, { effective_start_date: FUTURE_START });

    const pending = pendingFromMemory();
    expect(pending.effective_start_date).toBe(FUTURE_START);   // ← future-start flag
    expect(pending.custom_end_date ?? null).toBeNull();        // open-ended
    expect(pending.rotation ?? null).toBeNull();
    expect(pending.proposed_availability).toEqual(PROPOSED);
    // MUST NOT write the permanent availability table at intake.
    expect(h.recorded.some(r => r.table === 'availability' && r.op !== 'select')).toBe(false);

    const reply = h.replyMock.mock.calls[0][2] as string;
    expect(reply).toMatch(/starting/i);
    expect(reply).not.toMatch(/homebase/i);
  });

  it('a future window ("from <start> until <end>") carries BOTH bounds', async () => {
    await handleUpdateAvailability(message, contact, { effective_start_date: FUTURE_START, end_date: FUTURE_END });

    const pending = pendingFromMemory();
    expect(pending.effective_start_date).toBe(FUTURE_START);
    expect(pending.custom_end_date).toBe(FUTURE_END);
  });

  it('a start date in the past is ignored (treated as immediate — effective_start_date null)', async () => {
    await handleUpdateAvailability(message, contact, { effective_start_date: '2000-01-01' });

    const pending = pendingFromMemory();
    expect(pending.effective_start_date ?? null).toBeNull();
  });
});

describe('applyCustomAvailabilityDecision — future-start write', () => {
  const input = (over: Record<string, unknown>) => ({
    decision: 'approved' as const,
    company_id: COMPANY_ID,
    employee_id: EMPLOYEE_ID,
    employee_name: 'Shmubba Sploosh',
    proposed_availability: PROPOSED,
    custom_end_date: null as string | null,
    current_availability: [] as AvailabilitySlot[],
    availability_raw: 'weekends-only starting later this month',
    decided_by: 'Sandbox Manager',
    employee_sender: 'aegisscheduler@gmail.com',
    employee_recipient: 'sandbox@aegis.quriasolutions.com',
    employee_channel: 'email' as const,
    thread_id: null,
    raw_subject: null,
    ...over,
  });

  it('APPROVE writes a date_limited override with effective_start_date set + end_date NULL (open-ended), not a permanent availability edit', async () => {
    await applyCustomAvailabilityDecision(input({ effective_start_date: FUTURE_START, custom_end_date: null }));

    const insert = h.recorded.find(r => r.table === 'custom_availability' && r.op === 'insert');
    expect(insert).toBeDefined();
    const row = insert!.rows as Record<string, unknown>;
    expect(row.type).toBe('date_limited');
    expect(row.effective_start_date).toBe(FUTURE_START);
    expect(row.end_date).toBeNull();
    expect(row.active).toBe(true);
    expect(row.patterns).toEqual(PROPOSED);
    expect(h.recorded.some(r => r.table === 'availability')).toBe(false);
    expect(h.recorded.some(r => r.table === 'activity_log' && r.op === 'insert'
      && (r.rows as { action: string }).action === 'custom_availability_set')).toBe(true);

    const body = h.replyMock.mock.calls[0][2] as string;
    expect(body).toMatch(/approved/i);
    expect(body).toMatch(/starting/i);
  });

  it('APPROVE with a future window writes both effective_start_date and end_date', async () => {
    await applyCustomAvailabilityDecision(input({ effective_start_date: FUTURE_START, custom_end_date: FUTURE_END }));

    const insert = h.recorded.find(r => r.table === 'custom_availability' && r.op === 'insert');
    const row = insert!.rows as Record<string, unknown>;
    expect(row.effective_start_date).toBe(FUTURE_START);
    expect(row.end_date).toBe(FUTURE_END);
  });
});
