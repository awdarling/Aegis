import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Batch-1 F4: manager broadcast — attribution, actor, targeting ───────────────
//
// Managers can broadcast to their OWN company. Employee-facing attribution is the
// SENDER's name ("<SenderName>: <message>"), not the company name; the activity
// log actor reflects manager vs quria_admin; and a manager targeting managers-only
// is redirected (that stays a quria-admin action).

const h = vi.hoisted(() => ({
  sendSmsMock: vi.fn(async () => {}),
  sendEmailMock: vi.fn(async () => {}),
  replyMock: vi.fn(async () => {}),
  logMock: vi.fn(async () => {}),
  generateReplyMock: vi.fn(async () => ''),
}));

vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: false } }));
vi.mock('../../db/client', () => ({
  supabase: {
    from: (t: string) => ({
      select() { return this; }, eq() { return this; }, in() { return this; }, delete() { return this; },
      insert() { return Promise.resolve({ error: null }); },
      single() { return Promise.resolve({ data: t === 'companies' ? { name: 'Watermark' } : null, error: null }); },
      maybeSingle() { return Promise.resolve({ data: t === 'company_channels' ? { channel_value: '+16166164898' } : null, error: null }); },
      then(onF: (v: { data: unknown; error: null }) => unknown, onR?: (e: unknown) => unknown) { return Promise.resolve({ data: [], error: null }).then(onF, onR); },
    }),
  },
}));
vi.mock('../../messaging/sms', () => ({ sendSms: h.sendSmsMock }));
vi.mock('../../messaging/email', () => ({ sendEmail: h.sendEmailMock }));
vi.mock('../../messaging/reply', () => ({ reply: h.replyMock }));
vi.mock('../../logger/activity-log', () => ({ logActivity: h.logMock }));
vi.mock('../../ai/claude', () => ({ generateReply: h.generateReplyMock }));

import { handleBroadcast, handleBroadcastConfirmation, type BroadcastSession } from '../broadcast';

const managerContact = { role: 'manager', company_id: 'c1', matched_identifier: 'm@x.com', channel: 'sms', name: 'Alex Manager' } as never;
const message = { sender: 'm@x.com', recipient: 'aegis@x.com', body: 'yes', channel: 'sms' } as never;

function session(over: Partial<BroadcastSession> = {}): BroadcastSession & { _memory_id?: string } {
  return {
    company_id: 'c1', admin_contact: 'm@x.com', admin_channel: 'sms', admin_sender: 'm@x.com', admin_recipient: 'aegis@x.com',
    sender_name: 'Alex Manager', sender_role: 'manager',
    message_text: 'Pool opens at 10 tomorrow.',
    target_type: 'all', target_role: null, target_ids: ['e1'], channel: 'both',
    resolved_recipients: [{ employee_id: 'e1', name: 'Luka', phone: '+16167170847', email: 'luka@x.com' }],
    expires_at: new Date(Date.now() + 60000).toISOString(),
    ...over,
  } as BroadcastSession & { _memory_id?: string };
}

beforeEach(() => { h.sendSmsMock.mockClear(); h.sendEmailMock.mockClear(); h.replyMock.mockClear(); h.logMock.mockClear(); h.generateReplyMock.mockReset(); });

describe('handleBroadcastConfirmation — sender-name attribution + actor (F4)', () => {
  it('attributes SMS + email to the sender name, not the company', async () => {
    await handleBroadcastConfirmation(message, managerContact, session());
    expect(h.sendSmsMock.mock.calls[0][0].body).toBe('Alex Manager: Pool opens at 10 tomorrow.');
    expect(h.sendEmailMock.mock.calls[0][0].subject).toBe('Message from Alex Manager');
    expect(h.sendEmailMock.mock.calls[0][0].text).toContain('Alex Manager:');
  });

  it('logs the actor as manager for a manager broadcast', async () => {
    await handleBroadcastConfirmation(message, managerContact, session());
    const logged = h.logMock.mock.calls[0][0] as { actor: string; action: string };
    expect(logged.actor).toBe('manager');
    expect(logged.action).toBe('manager_broadcast_sent');
  });

  it('logs the actor as quria_admin for a quria broadcast', async () => {
    const q = { ...managerContact, role: 'quria_admin', name: 'Quria Ops' } as never;
    await handleBroadcastConfirmation(message, q, session({ sender_name: 'Quria Ops', sender_role: 'quria_admin' }));
    const logged = h.logMock.mock.calls[0][0] as { actor: string };
    expect(logged.actor).toBe('quria_admin');
  });
});

describe('handleBroadcast — manager targeting restriction (F4)', () => {
  it('redirects a manager who targets managers-only', async () => {
    h.generateReplyMock.mockResolvedValue('{"message_text":"hi","target_type":"managers","target_role":null,"target_names":null,"channel":"sms"}');
    await handleBroadcast(message, managerContact, {});
    expect(h.replyMock).toHaveBeenCalledTimes(1);
    expect(h.replyMock.mock.calls[0][2]).toMatch(/Quria-admin action/i);
    expect(h.sendSmsMock).not.toHaveBeenCalled();
  });
});
