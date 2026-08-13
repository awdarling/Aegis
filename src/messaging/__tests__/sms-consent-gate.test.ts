import { describe, it, expect, vi, beforeEach } from 'vitest';

// N3 consent gate at the send chokepoint. We mock ./consent so we control the
// verdict directly (canSmsEmployee's own logic is covered in consent.test.ts).
const h = vi.hoisted(() => ({
  env: { EMAIL_ONLY: false as boolean, TELNYX_API_KEY: 'k' as string | undefined },
  canSmsEmployee: vi.fn(),
  sendTelnyxMessage: vi.fn(),
  saveConversation: vi.fn().mockResolvedValue(undefined),
  maybeSingle: vi.fn(),
}));

vi.mock('../../config/env', () => ({ env: h.env }));
vi.mock('../consent', () => ({ canSmsEmployee: h.canSmsEmployee }));
vi.mock('../../db/client', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: h.maybeSingle }) }) }) }) },
}));
vi.mock('../telnyx', () => ({ sendTelnyxMessage: h.sendTelnyxMessage }));
vi.mock('../../logger/conversation', () => ({ saveConversation: h.saveConversation }));

import { sendSms } from '../sms';

describe('sendSms — N3 consent gate', () => {
  beforeEach(() => {
    h.env.EMAIL_ONLY = false;
    h.env.TELNYX_API_KEY = 'k';
    h.canSmsEmployee.mockReset();
    h.sendTelnyxMessage.mockReset().mockResolvedValue({ ok: true, id: 'm1' });
    h.saveConversation.mockClear();
  });

  it('BLOCKS a non-consented employee — no provider call, returns false, no consult of consent bypassed', async () => {
    h.canSmsEmployee.mockResolvedValue(false);
    const sent = await sendSms({ to: '+1', from: '+16166164898', body: 'hi', company_id: 'c1', employee_id: 'e1' });
    expect(sent).toBe(false);
    expect(h.canSmsEmployee).toHaveBeenCalledWith('c1', 'e1');
    expect(h.sendTelnyxMessage).not.toHaveBeenCalled();
  });

  it('ALLOWS a consented employee', async () => {
    h.canSmsEmployee.mockResolvedValue(true);
    const sent = await sendSms({ to: '+1', from: '+16166164898', body: 'hi', company_id: 'c1', employee_id: 'e1' });
    expect(sent).toBe(true);
    expect(h.canSmsEmployee).toHaveBeenCalledWith('c1', 'e1');
    expect(h.sendTelnyxMessage).toHaveBeenCalledTimes(1);
  });

  it('ALLOWS allowPreConsent WITHOUT consulting the consent gate (opt-in invite / manager)', async () => {
    const sent = await sendSms({ to: '+1', from: '+16166164898', body: 'hi', company_id: 'c1', allowPreConsent: true });
    expect(sent).toBe(true);
    expect(h.canSmsEmployee).not.toHaveBeenCalled();
    expect(h.sendTelnyxMessage).toHaveBeenCalledTimes(1);
  });

  it('FAILS CLOSED when neither employee_id nor allowPreConsent is provided', async () => {
    const sent = await sendSms({ to: '+1', from: '+16166164898', body: 'hi', company_id: 'c1' });
    expect(sent).toBe(false);
    expect(h.canSmsEmployee).not.toHaveBeenCalled();
    expect(h.sendTelnyxMessage).not.toHaveBeenCalled();
  });

  it('EMAIL_ONLY short-circuits before the consent gate is even consulted', async () => {
    h.env.EMAIL_ONLY = true;
    const sent = await sendSms({ to: '+1', from: '+16166164898', body: 'hi', company_id: 'c1', employee_id: 'e1' });
    expect(sent).toBe(false);
    expect(h.canSmsEmployee).not.toHaveBeenCalled();
  });
});
