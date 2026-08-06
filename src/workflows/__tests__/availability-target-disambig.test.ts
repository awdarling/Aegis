import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Batch-1 F7: normal-vs-temporary availability disambiguation ─────────────────
//
// When an employee has BOTH a normal availability AND an ACTIVE custom override,
// an availability CHANGE must ASK which they mean (never auto-clobber). If only one
// exists, act directly (no clarifier).

const h = vi.hoisted(() => ({
  replyMock: vi.fn(async () => {}),
  memoryInserts: [] as Array<Record<string, unknown>>,
  hasNormal: true,
  hasOverride: true,
}));

vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: false, ANTHROPIC_API_KEY: 'x', SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', SENDGRID_FROM_EMAIL: 'a@b.c', BASE_URL: 'http://x' } }));

function makeBuilder(table: string) {
  const builder: Record<string, unknown> = {
    select() { return builder; },
    eq() { return builder; },
    in() { return builder; },
    is() { return builder; },
    limit() { return builder; },
    delete() { return builder; },
    update() { return builder; },
    insert(vals: Record<string, unknown>) { if (table === 'aegis_memory') h.memoryInserts.push(vals); return Promise.resolve({ error: null }); },
    maybeSingle() { return Promise.resolve({ data: null, error: null }); },
    single() { return Promise.resolve({ data: null, error: null }); },
    then(onF: (v: { data: unknown; error: null }) => unknown, onR?: (e: unknown) => unknown) {
      let data: unknown = null;
      if (table === 'availability') data = h.hasNormal ? [{ day_of_week: 1 }] : [];
      else if (table === 'custom_availability') data = h.hasOverride ? [{ end_date: '2026-08-31' }] : [];
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

import { handleUpdateAvailability, classifyAvailTarget } from '../employee-onboarding';

const contact = { role: 'employee', company_id: 'c1', employee_id: 'e1', user_id: null, name: 'Sam', matched_identifier: '+16163280114', channel: 'sms' } as never;
const message = { sender: '+16163280114', recipient: '+16166164898', body: 'open all week', channel: 'sms' } as never;

beforeEach(() => { h.replyMock.mockClear(); h.memoryInserts.length = 0; h.hasNormal = true; h.hasOverride = true; });

describe('classifyAvailTarget', () => {
  it('reads a normal answer', () => { expect(classifyAvailTarget('the normal one')).toBe('normal'); });
  it('reads a temporary answer', () => { expect(classifyAvailTarget('temporary please')).toBe('temporary'); });
  it('is unclear otherwise', () => { expect(classifyAvailTarget('uhh what?')).toBe('unclear'); });
});

describe('handleUpdateAvailability — F7 disambiguation gate', () => {
  it('ASKS which when BOTH normal + active override exist', async () => {
    await handleUpdateAvailability(message, contact, {});
    expect(h.replyMock).toHaveBeenCalledTimes(1);
    const body = h.replyMock.mock.calls[0][2] as string;
    expect(body).toMatch(/normal/i);
    expect(body).toMatch(/temporary/i);
    expect(body).toMatch(/through/i); // names the override end date
    // remembered the original request for replay
    expect(h.memoryInserts.some(m => (m.source as string)?.startsWith('avail_target_disambig:'))).toBe(true);
  });

  it('does NOT ask when the target is already resolved (avail_target set)', async () => {
    // With avail_target set, the gate is skipped — it proceeds into the parse path
    // (which throws on the mocked LLM); we only assert the disambiguation question
    // was NOT the reply.
    await handleUpdateAvailability(message, contact, { avail_target: 'normal' }).catch(() => {});
    const asked = h.replyMock.mock.calls.some(c => /do you want to change your normal availability, or your temporary/i.test(c[2] as string));
    expect(asked).toBe(false);
  });

  it('does NOT ask when only one availability exists', async () => {
    h.hasOverride = false;
    await handleUpdateAvailability(message, contact, {}).catch(() => {});
    const asked = h.replyMock.mock.calls.some(c => /do you want to change your normal availability, or your temporary/i.test(c[2] as string));
    expect(asked).toBe(false);
  });
});
