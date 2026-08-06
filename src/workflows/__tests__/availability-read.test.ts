import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Batch-1 F5: availability READ (query_my_availability → handleMyAvailabilityQuery)
//
// Employees can text to read their current availability. Read-only, replies on the
// asker's channel via reply(), never opens a time-off request. When both a normal
// availability and an ACTIVE custom override exist, it shows BOTH (F7 read side).

const h = vi.hoisted(() => ({
  replyMock: vi.fn(async () => {}),
  normal: [] as Array<Record<string, unknown>>,
  custom: [] as Array<Record<string, unknown>>,
}));

vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: false, ANTHROPIC_API_KEY: 'x', SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', SENDGRID_FROM_EMAIL: 'a@b.c', BASE_URL: 'http://x' } }));

function makeBuilder(table: string) {
  const builder: Record<string, unknown> = {
    select() { return builder; },
    eq() { return builder; },
    in() { return builder; },
    is() { return builder; },
    insert() { return Promise.resolve({ error: null }); },
    update() { return builder; },
    delete() { return builder; },
    maybeSingle() { return Promise.resolve({ data: null, error: null }); },
    single() { return Promise.resolve({ data: null, error: null }); },
    then(onF: (v: { data: unknown; error: null }) => unknown, onR?: (e: unknown) => unknown) {
      const data = table === 'availability' ? h.normal : table === 'custom_availability' ? h.custom : null;
      return Promise.resolve({ data, error: null }).then(onF, onR);
    },
  };
  return builder;
}

vi.mock('../../db/client', () => ({ supabase: { from: (t: string) => makeBuilder(t) } }));
vi.mock('../../messaging/reply', () => ({ reply: h.replyMock, sendInThreadAck: vi.fn(), normalizeReSubject: (s: string) => s }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn(async () => true) }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../ai/claude', () => ({ withAnthropicRetry: vi.fn() }));

import { handleMyAvailabilityQuery } from '../employee-onboarding';

const contact = { role: 'employee', company_id: 'c1', employee_id: 'e1', user_id: null, name: 'Sam Rivera', matched_identifier: '+16163280114', channel: 'sms' } as never;
const message = { sender: '+16163280114', recipient: '+16166164898', body: "what's my availability?", channel: 'sms' } as never;

beforeEach(() => { h.replyMock.mockClear(); h.normal = []; h.custom = []; });

describe('handleMyAvailabilityQuery (Batch-1 F5)', () => {
  it('shows normal availability when only normal exists', async () => {
    h.normal = [{ day_of_week: 1, start_time: '09:00', end_time: '17:00' }];
    await handleMyAvailabilityQuery(message, contact, {});
    const body = h.replyMock.mock.calls[0][2] as string;
    expect(body).toMatch(/Monday/);
    expect(body).not.toMatch(/temporary override/i);
  });

  it('shows BOTH normal and an active temporary override (F7 read side)', async () => {
    h.normal = [{ day_of_week: 1, start_time: '09:00', end_time: '17:00' }];
    h.custom = [{ type: 'date_limited', end_date: '2026-08-31', cycle_weeks: null, patterns: [{ day_of_week: 2, start_time: '11:00', end_time: '15:00' }], active: true }];
    await handleMyAvailabilityQuery(message, contact, {});
    const body = h.replyMock.mock.calls[0][2] as string;
    expect(body).toMatch(/Normal:/);
    expect(body).toMatch(/[Tt]emporary override/);
    expect(body).toMatch(/Tuesday/);
    expect(body).toMatch(/through/);
  });

  it('invites setup when nothing is set', async () => {
    await handleMyAvailabilityQuery(message, contact, {});
    const body = h.replyMock.mock.calls[0][2] as string;
    expect(body).toMatch(/don't have any availability set/i);
  });

  it('never opens a time-off request (only replies)', async () => {
    h.normal = [{ day_of_week: 5, start_time: '09:00', end_time: '13:00' }];
    await handleMyAvailabilityQuery(message, contact, {});
    expect(h.replyMock).toHaveBeenCalledTimes(1);
  });
});
