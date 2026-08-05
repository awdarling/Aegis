import { describe, it, expect, vi, beforeEach } from 'vitest';

// H7 — an UNCONFIRMED (not-yet-sent) shift-swap must not hold a clearly-different
// request hostage. When the reply to "should I set that swap up?" is neither yes
// nor no but IS a different actionable intent, drop the pending swap and re-route;
// otherwise keep re-asking.

vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local', SUPABASE_SERVICE_ROLE_KEY: 'test',
    BASE_URL: 'https://test.local', ANTHROPIC_API_KEY: 'test',
    SENDGRID_API_KEY: 'test', SENDGRID_FROM_EMAIL: 'a@test.local', EMAIL_ONLY: true,
  },
}));

function q(): any {
  const p: any = Promise.resolve({ data: null, error: null });
  for (const m of ['select','insert','update','delete','upsert','eq','neq','is','in','or','and','not','filter','ilike','like','gte','lte','gt','lt','contains','overlaps','order','limit','range']) {
    p[m] = () => q();
  }
  p.single = () => Promise.resolve({ data: null, error: null });
  p.maybeSingle = () => Promise.resolve({ data: null, error: null });
  return p;
}
vi.mock('../../db/client', () => ({ supabase: { from: () => q() } }));

vi.mock('../../ai/claude', () => ({ generateReply: vi.fn(), weekdayAnchors: () => '', classifyIntent: vi.fn() }));
const reply = vi.fn(async () => {});
vi.mock('../../messaging/reply', () => ({ reply: (...a: unknown[]) => reply(...a), sendInThreadAck: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ computeWageEstimate: vi.fn(async () => 0) }));
vi.mock('../../lib/aegis-actions/tokens', () => ({ generateActionToken: vi.fn(async () => 'tok') }));
vi.mock('../../lib/custom-availability', () => ({ resolveAvailabilityForWeek: vi.fn(async () => []) }));

const employeeInterruptIntent = vi.fn();
vi.mock('../../router/interrupt', () => ({
  employeeInterruptIntent: (...a: unknown[]) => employeeInterruptIntent(...a),
}));
const routeIntent = vi.fn(async () => {});
vi.mock('../../router/intent-router', () => ({ routeIntent: (...a: unknown[]) => routeIntent(...a) }));

import { handleSwapConfirmation } from '../shift-swap';
import type { InboundMessage, VerifiedContact } from '../../security/types';

const emp: VerifiedContact = {
  role: 'employee', company_id: 'co-1', employee_id: 'e1', user_id: null,
  name: 'Sam', matched_identifier: 's@club.com', channel: 'sms',
};
const msg = (body: string): InboundMessage => ({
  sender: 's@club.com', recipient: 'aegis@club.com', body, channel: 'sms',
});
const pending: any = { mode: 'directed', shift_date: '2026-08-08', shift_name: 'Morning' };

beforeEach(() => { reply.mockClear(); routeIntent.mockClear(); employeeInterruptIntent.mockReset(); });

describe('H7 — unconfirmed swap yields to a different intent', () => {
  it('re-routes when the ambiguous reply is a different actionable intent', async () => {
    employeeInterruptIntent.mockResolvedValue('query_my_shifts');
    await handleSwapConfirmation(msg("what's my schedule next week?"), emp, pending);
    expect(routeIntent).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
  });

  it('re-asks (does not re-route) when the reply is just a fumbled yes/no', async () => {
    employeeInterruptIntent.mockResolvedValue(null);
    await handleSwapConfirmation(msg('hmm not sure'), emp, pending);
    expect(routeIntent).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
  });
});
