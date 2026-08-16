import { describe, it, expect, vi, beforeEach } from 'vitest';

// N3 per-surface regression. Every employee-facing notification funnels through
// notifyEmployeeSmsFirst (broadcast blasts, day-closure fan-out, departure
// notices) — and its sibling notifyEmployeeDecision (time-off / swap decision
// notices) shares the identical SMS leg. This exercises the REAL sms.ts consent
// gate (only ./consent is stubbed) to prove: a non-consented employee receives
// ZERO SMS and the notice falls back to email instead.
const h = vi.hoisted(() => ({
  env: { EMAIL_ONLY: false as boolean, TELNYX_API_KEY: 'k' as string | undefined },
  canSmsEmployee: vi.fn(),
  sendTelnyxMessage: vi.fn(),
  sendEmail: vi.fn().mockResolvedValue(true),
  saveConversation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config/env', () => ({ env: h.env }));
vi.mock('../consent', () => ({ canSmsEmployee: h.canSmsEmployee }));
vi.mock('../telnyx', () => ({ sendTelnyxMessage: h.sendTelnyxMessage }));
vi.mock('../email', () => ({ sendEmail: h.sendEmail }));
vi.mock('../../logger/conversation', () => ({ saveConversation: h.saveConversation }));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));

import { notifyEmployeeSmsFirst } from '../notify';

const base = {
  company_id: 'c1',
  smsChannel: '+16166164898',
  phone: '+15557654321',
  email: 'jack@club.com',
  body: 'You were added to Saturday.',
  subject: 'Schedule update',
  employee_id: 'jack',
};

describe('notifyEmployeeSmsFirst — non-consented employee gets ZERO SMS', () => {
  beforeEach(() => {
    h.env.EMAIL_ONLY = false;
    h.env.TELNYX_API_KEY = 'k';
    h.canSmsEmployee.mockReset();
    h.sendTelnyxMessage.mockReset().mockResolvedValue({ ok: true, id: 'm1' });
    h.sendEmail.mockClear();
  });

  it('a non-opted-in employee is NEVER texted — falls back to email', async () => {
    h.canSmsEmployee.mockResolvedValue(false);
    const used = await notifyEmployeeSmsFirst(base);
    expect(used).toBe('email');
    expect(h.sendTelnyxMessage).not.toHaveBeenCalled(); // zero SMS
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('an opted-in employee is texted (SMS-first preserved for the consented)', async () => {
    h.canSmsEmployee.mockResolvedValue(true);
    const used = await notifyEmployeeSmsFirst(base);
    expect(used).toBe('sms');
    expect(h.sendTelnyxMessage).toHaveBeenCalledTimes(1);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('a non-consented employee with NO email is suppressed — still zero SMS', async () => {
    h.canSmsEmployee.mockResolvedValue(false);
    const used = await notifyEmployeeSmsFirst({ ...base, email: null });
    expect(used).toBe('none');
    expect(h.sendTelnyxMessage).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });
});
