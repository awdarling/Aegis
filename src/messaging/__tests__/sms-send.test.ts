import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable mocks shared with the hoisted vi.mock factories.
const h = vi.hoisted(() => {
  const maybeSingle = vi.fn();
  const chain = { select: () => chain, eq: () => chain, maybeSingle };
  return {
    env: { EMAIL_ONLY: false as boolean, TELNYX_API_KEY: 'k' as string | undefined },
    maybeSingle,
    supabase: { from: () => chain },
    sendTelnyxMessage: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../config/env', () => ({ env: h.env }));
vi.mock('../../db/client', () => ({ supabase: h.supabase }));
vi.mock('../telnyx', () => ({ sendTelnyxMessage: h.sendTelnyxMessage }));
vi.mock('../../logger/conversation', () => ({ saveConversation: h.saveConversation }));

import { sendSms, getTenantSmsNumber } from '../sms';

describe('sendSms — email-only guard, provider guard, per-tenant number', () => {
  beforeEach(() => {
    h.env.EMAIL_ONLY = false;
    h.env.TELNYX_API_KEY = 'k';
    h.maybeSingle.mockReset();
    h.sendTelnyxMessage.mockReset();
    h.saveConversation.mockClear();
    h.sendTelnyxMessage.mockResolvedValue({ ok: true, id: 'msg_1' });
  });

  it('sends nothing while EMAIL_ONLY is on', async () => {
    h.env.EMAIL_ONLY = true;
    const sent = await sendSms({ to: '+1', from: '+16166164898', body: 'hi', company_id: 'c1', allowPreConsent: true });
    expect(sent).toBe(false);
    expect(h.sendTelnyxMessage).not.toHaveBeenCalled();
  });

  it('sends nothing when Telnyx is not configured', async () => {
    h.env.TELNYX_API_KEY = undefined;
    const sent = await sendSms({ to: '+1', from: '+16166164898', body: 'hi', company_id: 'c1', allowPreConsent: true });
    expect(sent).toBe(false);
    expect(h.sendTelnyxMessage).not.toHaveBeenCalled();
  });

  it('uses the caller-supplied from number when present (a reply carries it)', async () => {
    const sent = await sendSms({ to: '+16165550123', from: '+16166164898', body: 'hi', company_id: 'c1', allowPreConsent: true });
    expect(sent).toBe(true);
    expect(h.sendTelnyxMessage).toHaveBeenCalledWith({ from: '+16166164898', to: '+16165550123', text: 'hi' });
    // no per-tenant lookup needed when from is supplied
    expect(h.maybeSingle).not.toHaveBeenCalled();
    expect(h.saveConversation).toHaveBeenCalledTimes(1);
  });

  it('resolves the tenant number from company_channels when from is empty', async () => {
    h.maybeSingle.mockResolvedValue({ data: { channel_value: '+16166164898' }, error: null });
    const sent = await sendSms({ to: '+16165550123', from: '', body: 'hi', company_id: 'c1', allowPreConsent: true });
    expect(sent).toBe(true);
    expect(h.sendTelnyxMessage).toHaveBeenCalledWith({ from: '+16166164898', to: '+16165550123', text: 'hi' });
  });

  it('refuses to send when the tenant has no configured SMS number', async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    const sent = await sendSms({ to: '+16165550123', from: '', body: 'hi', company_id: 'c1', allowPreConsent: true });
    expect(sent).toBe(false);
    expect(h.sendTelnyxMessage).not.toHaveBeenCalled();
  });

  it('returns false when the provider send fails, and logs the failure to the DB', async () => {
    h.sendTelnyxMessage.mockResolvedValue({ ok: false, error: 'boom' });
    const sent = await sendSms({ to: '+1', from: '+16166164898', body: 'hi', company_id: 'c1', allowPreConsent: true });
    expect(sent).toBe(false);
    // A failed send is no longer invisible: it's written to the conversation,
    // distinctly marked so it can't be mistaken for a delivered message.
    expect(h.saveConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: 'c1',
        channel: 'sms',
        direction: 'outbound',
        content: '[SEND FAILED — boom] hi',
        to_address: '+1',
      }),
    );
  });
});

describe('getTenantSmsNumber', () => {
  beforeEach(() => h.maybeSingle.mockReset());

  it('returns the tenant channel_value', async () => {
    h.maybeSingle.mockResolvedValue({ data: { channel_value: '+16166164898' }, error: null });
    expect(await getTenantSmsNumber('c1')).toBe('+16166164898');
  });

  it('returns null when no row / on error', async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getTenantSmsNumber('c1')).toBeNull();
    h.maybeSingle.mockResolvedValue({ data: null, error: { message: 'db down' } });
    expect(await getTenantSmsNumber('c1')).toBeNull();
  });
});
