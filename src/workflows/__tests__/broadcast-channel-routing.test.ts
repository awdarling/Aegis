import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Batch-1.5 #13/#14: broadcast delivery — SMS-first, honest accounting ─────────
//
// A default whole-team broadcast used to be SMS-only: email-only teammates were
// marked "no contact info" (though they have an email), 0 emails went out, and a
// failed SMS was still counted as delivered. Fix: route each recipient SMS-first
// with email fallback (via notifyEmployeeSmsFirst), distinguish "no contact on
// file" from "delivery failed", and only count a send that actually succeeded.

const h = vi.hoisted(() => ({
  sendSmsMock: vi.fn(async () => true),
  sendEmailMock: vi.fn(async () => true),
  replyMock: vi.fn(async () => {}),
  logMock: vi.fn(async () => {}),
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
vi.mock('../../ai/claude', () => ({ generateReply: vi.fn(async () => '') }));
// NOTE: '../../messaging/notify' is deliberately NOT mocked — the real
// notifyEmployeeSmsFirst runs against the mocked sendSms/sendEmail so we exercise
// the actual SMS-first-with-fallback wiring.

import { handleBroadcastConfirmation, type BroadcastSession } from '../broadcast';

const managerContact = { role: 'manager', company_id: 'c1', matched_identifier: 'm@x.com', channel: 'sms', name: 'Alex Manager' } as never;
const message = { sender: 'm@x.com', recipient: 'aegis@x.com', body: 'yes', channel: 'sms' } as never;

function session(over: Partial<BroadcastSession> = {}): BroadcastSession & { _memory_id?: string } {
  return {
    company_id: 'c1', admin_contact: 'm@x.com', admin_channel: 'sms', admin_sender: 'm@x.com', admin_recipient: 'aegis@x.com',
    sender_name: 'Alex Manager', sender_role: 'manager',
    message_text: 'Pool closes at 8 tonight.',
    target_type: 'all', target_role: null, target_ids: [], channel: 'sms',
    resolved_recipients: [],
    expires_at: new Date(Date.now() + 60000).toISOString(),
    ...over,
  } as BroadcastSession & { _memory_id?: string };
}

beforeEach(() => {
  h.sendSmsMock.mockClear(); h.sendEmailMock.mockClear(); h.replyMock.mockClear(); h.logMock.mockClear();
  h.sendSmsMock.mockImplementation(async () => true);
  h.sendEmailMock.mockImplementation(async () => true);
});

describe('broadcast channel routing (Batch-1.5 #13)', () => {
  it('emails an email-only teammate on a default SMS broadcast (not "no contact info")', async () => {
    await handleBroadcastConfirmation(message, managerContact, session({
      resolved_recipients: [{ employee_id: 'e1', name: 'Casey', phone: null, email: 'casey@x.com' }],
    }));
    expect(h.sendEmailMock).toHaveBeenCalledTimes(1);
    expect(h.sendEmailMock.mock.calls[0][0].to).toBe('casey@x.com');
    const meta = h.logMock.mock.calls[0][0].metadata;
    expect(meta.sent_email).toBe(1);
    expect(meta.no_contact_names).toEqual([]);
    expect(String(h.replyMock.mock.calls[0][2])).not.toMatch(/no contact info/i);
  });

  it('falls back to email (and does NOT count SMS) when the SMS send fails', async () => {
    h.sendSmsMock.mockImplementation(async () => false);
    await handleBroadcastConfirmation(message, managerContact, session({
      resolved_recipients: [{ employee_id: 'e1', name: 'Luka', phone: '+16167170847', email: 'luka@x.com' }],
    }));
    const meta = h.logMock.mock.calls[0][0].metadata;
    expect(meta.sent_sms).toBe(0);          // the failed SMS is NOT counted as delivered
    expect(meta.sent_email).toBe(1);        // email fallback fired
    expect(h.sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('reports a recipient with neither phone nor email as "no phone or email on file"', async () => {
    await handleBroadcastConfirmation(message, managerContact, session({
      resolved_recipients: [{ employee_id: 'e1', name: 'Ghost', phone: null, email: null }],
    }));
    const meta = h.logMock.mock.calls[0][0].metadata;
    expect(meta.no_contact_names).toEqual(['Ghost']);
    expect(meta.sent_sms).toBe(0);
    expect(meta.sent_email).toBe(0);
    expect(String(h.replyMock.mock.calls[0][2])).toMatch(/no phone or email on file/i);
  });

  it('softened summary copy (#14) — warm headline with a per-channel breakdown', async () => {
    await handleBroadcastConfirmation(message, managerContact, session({
      resolved_recipients: [{ employee_id: 'e1', name: 'Luka', phone: '+16167170847', email: null }],
    }));
    const text = String(h.replyMock.mock.calls[0][2]);
    expect(text).toMatch(/^Done — your message went out to 1 teammate/);
    expect(text).toMatch(/1 by text/);
  });
});
