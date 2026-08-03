import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mirror operational-grounding.test.ts's module mocks so importing the fetch
// helper is side-effect-free, but swap the DB client for a chainable recorder
// that captures every query-builder call.
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({
  env: { ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k', SENDGRID_FROM_EMAIL: 'a@b.test', SENDGRID_FROM_NAME: 'Aegis', BASE_URL: 'http://localhost:3000', NODE_ENV: 'test' },
}));
vi.mock('../../db/client', () => {
  const calls: unknown[][] = [];
  const qb: Record<string, unknown> = {
    from: (t: string) => { calls.push(['from', t]); return qb; },
    select: (s: string) => { calls.push(['select', s]); return qb; },
    eq: (c: string, v: unknown) => { calls.push(['eq', c, v]); return qb; },
    neq: () => qb, gte: () => qb, lte: () => qb, in: () => qb, ilike: () => qb,
    order: () => qb, limit: () => qb,
    then: (resolve: (x: unknown) => void) => resolve({ data: [], error: null }),
    __calls: calls,
  };
  return { supabase: qb };
});
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn() }));
vi.mock('../../ai/claude', () => ({ generateReply: vi.fn(), withAnthropicRetry: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ computeWageEstimate: vi.fn() }));
vi.mock('../payroll', () => ({ handleWageRateSync: vi.fn() }));

import { executeFetchPlan } from '../operational-query';
import { supabase } from '../../db/client';

const calls = () => (supabase as unknown as { __calls: unknown[][] }).__calls;

// The posted (published) schedule is distributed team-wide, so employees may see
// the roster for any day — but they must NEVER be shown an unpublished draft.
describe('executeFetchPlan — employee published-only schedule guard', () => {
  beforeEach(() => { calls().length = 0; });

  it('restricts an employee schedule read to published rows', async () => {
    await executeFetchPlan({ fetches: [{ table: 'schedules' }] }, 'co1', '2026-07-31', 'employee');
    expect(calls()).toContainEqual(['eq', 'status', 'published']);
  });

  it('does NOT restrict a manager schedule read (drafts stay visible)', async () => {
    await executeFetchPlan({ fetches: [{ table: 'schedules' }] }, 'co1', '2026-07-31', 'manager');
    expect(calls()).not.toContainEqual(['eq', 'status', 'published']);
  });
});
