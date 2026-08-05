import { describe, it, expect, vi, beforeEach } from 'vitest';

// Issue 8: an employee self-query ("what's my availability") must be scoped to
// THEIR own employee_id. The LLM fetch plan can't supply the UUID, so without a
// forced self-scope the plan pulls the whole company's availability and the
// answer model — told to reveal only the asker's own — returns nothing/wrong.
// This captures the .eq() filters executeFetchPlan applies to each table.

const h = vi.hoisted(() => {
  const captured: { table: string; eqs: [string, unknown][] }[] = [];
  function makeBuilder(table: string) {
    const rec: { table: string; eqs: [string, unknown][] } = { table, eqs: [] };
    captured.push(rec);
    const b: Record<string, unknown> = {
      select() { return b; },
      eq(field: string, value: unknown) { rec.eqs.push([field, value]); return b; },
      neq() { return b; },
      gte() { return b; },
      lte() { return b; },
      ilike() { return b; },
      in() { return b; },
      is() { return b; },
      order() { return b; },
      limit() { return b; },
      then(onF: (v: { data: unknown[]; error: null }) => unknown) {
        return Promise.resolve({ data: [], error: null }).then(onF);
      },
    };
    return b;
  }
  return { captured, makeBuilder };
});

vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({
  env: { ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k', SENDGRID_FROM_EMAIL: 'a@b.test', SENDGRID_FROM_NAME: 'Aegis', BASE_URL: 'http://localhost:3000', NODE_ENV: 'test' },
}));
vi.mock('../../db/client', () => ({ supabase: { from: (t: string) => h.makeBuilder(t) } }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn() }));
vi.mock('../../ai/claude', () => ({ generateReply: vi.fn(), withAnthropicRetry: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ computeWageEstimate: vi.fn() }));
vi.mock('../payroll', () => ({ handleWageRateSync: vi.fn() }));

import { executeFetchPlan } from '../operational-query';

const TODAY = '2026-08-04';

function eqsFor(table: string): [string, unknown][] {
  // The last builder for a table is the one actually awaited (date_context may
  // rebuild it), so fold all its eq() filters together.
  return h.captured.filter(c => c.table === table).flatMap(c => c.eqs);
}

describe('executeFetchPlan employee self-scope', () => {
  beforeEach(() => { h.captured.length = 0; });

  it('scopes an employee availability read to their own employee_id', async () => {
    await executeFetchPlan(
      { fetches: [{ table: 'availability' }] },
      'co-1', TODAY, 'employee', 'emp-self',
    );
    const eqs = eqsFor('availability');
    expect(eqs).toContainEqual(['employee_id', 'emp-self']);
  });

  it('scopes an employee time_off read to their own employee_id', async () => {
    await executeFetchPlan(
      { fetches: [{ table: 'time_off_requests' }], date_context: 'recent' },
      'co-1', TODAY, 'employee', 'emp-self',
    );
    expect(eqsFor('time_off_requests')).toContainEqual(['employee_id', 'emp-self']);
  });

  it('does NOT self-scope a manager query (managers see everyone)', async () => {
    await executeFetchPlan(
      { fetches: [{ table: 'availability' }] },
      'co-1', TODAY, 'manager', null,
    );
    const eqs = eqsFor('availability');
    expect(eqs.some(([f]) => f === 'employee_id')).toBe(false);
  });
});
