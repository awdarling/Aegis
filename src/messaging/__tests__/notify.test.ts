import { describe, it, expect, beforeEach, vi } from 'vitest';

// Unit test for the cross-cutting SMS-first notifier (Batch-1). Prefers SMS for a
// phone-holder when EMAIL_ONLY=false + tenant SMS number present; email is the
// fallback on send failure or when SMS isn't possible.

const h = vi.hoisted(() => ({
  sendSmsMock: vi.fn(async () => true),
  sendEmailMock: vi.fn(async () => true),
  env: { EMAIL_ONLY: false } as { EMAIL_ONLY: boolean },
}));

vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../config/env', () => ({ env: h.env }));
vi.mock('../sms', () => ({ sendSms: h.sendSmsMock }));
vi.mock('../email', () => ({ sendEmail: h.sendEmailMock }));

import { notifyEmployeeSmsFirst } from '../notify';

const base = { company_id: 'c1', smsChannel: '+16160000000', phone: '+16165550123', email: 'sam@x.com', body: 'hi', subject: 'S' };

beforeEach(() => { h.sendSmsMock.mockClear(); h.sendEmailMock.mockClear(); h.env.EMAIL_ONLY = false; h.sendSmsMock.mockResolvedValue(true); });

describe('notifyEmployeeSmsFirst', () => {
  it('texts a phone-holder when EMAIL_ONLY=false', async () => {
    const ch = await notifyEmployeeSmsFirst({ ...base });
    expect(ch).toBe('sms');
    expect(h.sendSmsMock).toHaveBeenCalledTimes(1);
    expect(h.sendEmailMock).not.toHaveBeenCalled();
  });

  it('falls back to email when the SMS send fails', async () => {
    h.sendSmsMock.mockResolvedValueOnce(false);
    const ch = await notifyEmployeeSmsFirst({ ...base });
    expect(ch).toBe('email');
    expect(h.sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('emails when there is no phone', async () => {
    const ch = await notifyEmployeeSmsFirst({ ...base, phone: null });
    expect(ch).toBe('email');
    expect(h.sendSmsMock).not.toHaveBeenCalled();
  });

  it('emails when there is no tenant SMS number', async () => {
    const ch = await notifyEmployeeSmsFirst({ ...base, smsChannel: null });
    expect(ch).toBe('email');
    expect(h.sendSmsMock).not.toHaveBeenCalled();
  });

  it('emails (never texts) under EMAIL_ONLY', async () => {
    h.env.EMAIL_ONLY = true;
    const ch = await notifyEmployeeSmsFirst({ ...base });
    expect(ch).toBe('email');
    expect(h.sendSmsMock).not.toHaveBeenCalled();
  });

  it('returns none when unreachable (no phone/SMS and no email)', async () => {
    const ch = await notifyEmployeeSmsFirst({ ...base, phone: null, email: null });
    expect(ch).toBe('none');
    expect(h.sendSmsMock).not.toHaveBeenCalled();
    expect(h.sendEmailMock).not.toHaveBeenCalled();
  });
});
