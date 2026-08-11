import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Batch-1.5 finding #17: "add a new employee" over SMS ─────────────────────────
//
// Creating an employee RECORD is Homebase-owned (Data Contract Rule 0). Aegis must
// NOT insert an employees row from the SMS lane — it points the manager to Homebase
// and offers to onboard once the record exists. This pins that behavior: the
// handler replies with the redirect and never writes to `employees`.

const insertSpy = vi.fn();
const fromSpy = vi.fn((table: string) => ({ insert: (...a: unknown[]) => { insertSpy(table, ...a); return { select: () => ({}) }; } }));

vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: false, ANTHROPIC_API_KEY: 'x', SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', SENDGRID_FROM_EMAIL: 'a@b.c', BASE_URL: 'http://x' } }));
vi.mock('../../db/client', () => ({ supabase: { from: (t: string) => fromSpy(t) } }));
const replyMock = vi.fn();
vi.mock('../../messaging/reply', () => ({ reply: (...a: unknown[]) => replyMock(...a), sendInThreadAck: vi.fn(), normalizeReSubject: (s: string) => s }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/notify', () => ({ notifyEmployeeSmsFirst: vi.fn(), getAegisSmsChannel: vi.fn() }));
vi.mock('../../ai/claude', () => ({ withAnthropicRetry: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));

import { handleAddEmployee } from '../employee-onboarding';
import type { InboundMessage, VerifiedContact } from '../../security/types';

const message: InboundMessage = { sender: '+16163280114', recipient: '+16166164898', body: 'add a new employee', channel: 'sms' };
const manager: VerifiedContact = { role: 'manager', company_id: 'c1', employee_id: '66', user_id: null, name: 'Sandbox Manager', matched_identifier: '+16163280114', channel: 'sms' };

describe('handleAddEmployee (Batch-1.5 #17)', () => {
  beforeEach(() => { insertSpy.mockClear(); replyMock.mockClear(); });

  it('redirects to Homebase and offers to onboard once the record exists', async () => {
    await handleAddEmployee(message, manager, {});
    expect(replyMock).toHaveBeenCalledTimes(1);
    const text = String(replyMock.mock.calls[0][2]);
    expect(text).toMatch(/Homebase/);
    expect(text).toMatch(/onboard/i);
  });

  it('never inserts an employees row from the SMS lane', async () => {
    await handleAddEmployee(message, manager, {});
    const insertedTables = insertSpy.mock.calls.map(c => c[0]);
    expect(insertedTables).not.toContain('employees');
  });
});
