import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Batch-1.5 #18: the onboarding-fanout YES/NO confirm must YIELD a clearly-
// different actionable request (e.g. a new emergency-coverage call-out) instead
// of swallowing it as an invalid YES/NO and lingering. Mirrors the H7 coverage
// interruptibility pattern.

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
vi.mock('../../ai/claude', () => ({ generateReply: vi.fn(), classifyIntent: vi.fn(), withAnthropicRetry: vi.fn(), AnthropicOverloadError: class extends Error {} }));

const reply = vi.fn(async () => {});
vi.mock('../../messaging/reply', () => ({ reply: (...a: unknown[]) => reply(...a), sendInThreadAck: vi.fn(), normalizeReSubject: (s: string) => s }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/notify', () => ({ notifyEmployeeSmsFirst: vi.fn(), getAegisSmsChannel: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));

// The two modules the yield helper dynamically imports.
const managerInterruptIntent = vi.fn();
vi.mock('../../router/interrupt', () => ({ managerInterruptIntent: (...a: unknown[]) => managerInterruptIntent(...a) }));
const routeIntent = vi.fn(async () => {});
vi.mock('../../router/intent-router', () => ({ routeIntent: (...a: unknown[]) => routeIntent(...a) }));

import { handleOnboardingFanoutConfirm } from '../employee-onboarding';
import type { InboundMessage, VerifiedContact } from '../../security/types';

const mgr: VerifiedContact = { role: 'manager', company_id: 'co-1', employee_id: null, user_id: 'u1', name: 'Manager', matched_identifier: 'm@club.com', channel: 'sms' };
const msg = (body: string): InboundMessage => ({ sender: 'm@club.com', recipient: 'aegis@club.com', body, channel: 'sms' });
const pending = { _memory_id: 'mem1', target_employee_ids: ['e1', 'e2'] } as never;

beforeEach(() => { reply.mockClear(); routeIntent.mockClear(); managerInterruptIntent.mockReset(); });

describe('onboarding-fanout confirm interruptibility (#18)', () => {
  it('yields a new emergency-coverage request to the router instead of re-prompting', async () => {
    managerInterruptIntent.mockResolvedValue('request_emergency_coverage');
    await handleOnboardingFanoutConfirm(msg('Marcus called in sick, need someone for the morning'), mgr, pending);
    expect(routeIntent).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled(); // NOT "Reply YES to start onboarding or NO to cancel."
  });

  it('re-prompts on an ambiguous non-YES/NO that is not a different actionable intent', async () => {
    managerInterruptIntent.mockResolvedValue(null);
    await handleOnboardingFanoutConfirm(msg('huh?'), mgr, pending);
    expect(routeIntent).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(String(reply.mock.calls[0][2])).toMatch(/Reply YES to start onboarding/);
  });

  it('a clear NO still cancels (does not yield)', async () => {
    await handleOnboardingFanoutConfirm(msg('no, cancel that'), mgr, pending);
    expect(routeIntent).not.toHaveBeenCalled();
    expect(managerInterruptIntent).not.toHaveBeenCalled();
    expect(String(reply.mock.calls[0][2])).toMatch(/cancelled/i);
  });
});
