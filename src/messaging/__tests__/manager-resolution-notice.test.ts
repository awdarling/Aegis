// "That's handled — nothing for you to do."
//
// Alexander's policy, 2026-08-18: email is only for (a) someone with no text
// number or no consent, or (b) an action item with a click-through button.
// Everything else texts first. A "resolved" notice is neither, so it texts — and
// when it does have to email, it threads under the original request rather than
// arriving as a fresh unread item saying "no action is needed".

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    users: [] as unknown[],
    employees: [] as unknown[],
    channel: { channel_value: '+16166164898' } as unknown,
    emailOnly: false,
    smsResult: true as boolean | 'throw',
  };
  function makeBuilder(table: string) {
    const settle = () => {
      if (table === 'users') return Promise.resolve({ data: state.users, error: null });
      if (table === 'employees') return Promise.resolve({ data: state.employees, error: null });
      if (table === 'company_channels') return Promise.resolve({ data: state.channel, error: null });
      return Promise.resolve({ data: null, error: null });
    };
    const b: Record<string, unknown> = {
      select() { return b }, eq() { return b }, in() { return b }, is() { return b },
      order() { return b }, limit() { return b },
      maybeSingle() { return settle() }, single() { return settle() },
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) { return settle().then(onF, onR) },
    };
    return b;
  }
  const sendSmsMock = vi.fn(async () => {
    if (state.smsResult === 'throw') throw new Error('telnyx exploded');
    return state.smsResult as boolean;
  });
  const sendEmailMock = vi.fn(async () => true);
  return { state, makeBuilder, sendSmsMock, sendEmailMock };
});

vi.mock('../../db/client', () => ({ supabase: { from: (t: string) => h.makeBuilder(t) } }));
vi.mock('../../config/env', () => ({ env: { get EMAIL_ONLY() { return h.state.emailOnly } } }));
vi.mock('../sms', () => ({ sendSms: h.sendSmsMock }));
vi.mock('../email', () => ({ sendEmail: h.sendEmailMock }));

import { sendManagerResolutionNotice } from '../manager-resolution-notice';

const CO = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

const CAROLYN_LOGIN = { id: 'u-carolyn', email: 'carolyn@club.com', name: 'Carolyn', role: 'manager', employee_id: 'e-carolyn' };
const JACK_LOGIN    = { id: 'u-jack',    email: 'jack@club.com',    name: 'Jack',    role: 'manager', employee_id: 'e-jack' };
const CAROLYN = { id: 'e-carolyn', name: 'Carolyn', contact_phone: '+16168223809', contact_email: 'carolyn@club.com', active: true, notification_prefs: {} };
const JACK    = { id: 'e-jack',    name: 'Jack',    contact_phone: '+16165519476', contact_email: 'jack@club.com',    active: true, notification_prefs: {} };

const base = {
  companyId: CO,
  summary: "Jack approved Sam's request for Aug 20–22 off. Nothing needed from you.",
  subject: 'Time off request from Sam Rivera',
  body: 'No action needed.',
};

beforeEach(() => {
  h.state.users = [CAROLYN_LOGIN, JACK_LOGIN];
  h.state.employees = [CAROLYN, JACK];
  h.state.channel = { channel_value: '+16166164898' };
  h.state.emailOnly = false;
  h.state.smsResult = true;
  h.sendSmsMock.mockClear();
  h.sendEmailMock.mockClear();
  vi.restoreAllMocks();
});

describe('it texts, it does not email', () => {
  it('texts the other manager and sends no email at all', async () => {
    const r = await sendManagerResolutionNotice({ ...base, decidedByUserId: 'u-jack' });
    expect(r).toEqual({ texted: 1, emailed: 0, skipped: 0 });
    expect(h.sendEmailMock).not.toHaveBeenCalled();
  });

  it('never tells the person who made the decision', async () => {
    // They just clicked the button. Telling them is the noise we are removing.
    await sendManagerResolutionNotice({ ...base, decidedByUserId: 'u-jack' });
    expect(h.sendSmsMock).toHaveBeenCalledTimes(1);
    expect(h.sendSmsMock.mock.calls[0][0].to).toBe('+16168223809'); // Carolyn
  });

  it('tells everyone when the decision cannot be attributed', async () => {
    // The shared magic-link path can't say who clicked (Data Contract D17).
    // Better that both hear it twice than that one is left holding a dead button.
    await sendManagerResolutionNotice({ ...base, decidedByUserId: null });
    expect(h.sendSmsMock).toHaveBeenCalledTimes(2);
  });

  it('the text carries who / what / for when — never "you have a notification"', async () => {
    await sendManagerResolutionNotice({ ...base, decidedByUserId: 'u-jack' });
    const body = h.sendSmsMock.mock.calls[0][0].body as string;
    expect(body).toContain('Jack approved');
    expect(body).toContain('Sam');
    expect(body).toContain('Aug 20–22');
    expect(body).toMatch(/^Hey Carolyn — /);
    // And it does NOT push them at their inbox: there is nothing waiting there.
    expect(body).not.toMatch(/email/i);
    expect(body).not.toMatch(/approve\/deny link/i);
  });

  it('sends as a manager, so the employee consent gate does not block it', async () => {
    await sendManagerResolutionNotice({ ...base, decidedByUserId: 'u-jack' });
    expect(h.sendSmsMock.mock.calls[0][0].allowPreConsent).toBe(true);
    expect(h.sendSmsMock.mock.calls[0][0].from).toBe('+16166164898');
  });
});

describe('email is the fallback, and it threads', () => {
  it('emails a manager with no phone, threaded under the original request', async () => {
    h.state.employees = [{ ...CAROLYN, contact_phone: null }, JACK];
    const r = await sendManagerResolutionNotice({
      ...base,
      decidedByUserId: 'u-jack',
      inReplyTo: (m) => `<orig-${m.userId}@aegis.quriasolutions.com>`,
      messageId: (m) => `<notice-${m.userId}@aegis.quriasolutions.com>`,
    });
    expect(r).toEqual({ texted: 0, emailed: 1, skipped: 0 });
    const call = h.sendEmailMock.mock.calls[0][0];
    expect(call.to).toBe('carolyn@club.com');
    expect(call.in_reply_to).toBe('<orig-u-carolyn@aegis.quriasolutions.com>');
    expect(call.message_id).toBe('<notice-u-carolyn@aegis.quriasolutions.com>');
    // "Re:" so the mail client collapses it under the original.
    expect(call.subject).toBe('Re: Time off request from Sam Rivera');
  });

  it('falls back to email when the text fails to send', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.state.smsResult = false;
    const r = await sendManagerResolutionNotice({ ...base, decidedByUserId: 'u-jack' });
    expect(r).toEqual({ texted: 0, emailed: 1, skipped: 0 });
  });

  it('falls back to email when the text provider throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.state.smsResult = 'throw';
    const r = await sendManagerResolutionNotice({ ...base, decidedByUserId: 'u-jack' });
    expect(r).toEqual({ texted: 0, emailed: 1, skipped: 0 });
  });

  it('emails everyone in email-only mode', async () => {
    h.state.emailOnly = true;
    const r = await sendManagerResolutionNotice({ ...base, decidedByUserId: 'u-jack' });
    expect(h.sendSmsMock).not.toHaveBeenCalled();
    expect(r.emailed).toBe(1);
  });

  it('still sends, unthreaded, when the original had no Message-ID', async () => {
    // Requests created before the threading fix have nothing to thread to. They
    // should still get the notice — just not collapsed.
    h.state.employees = [{ ...CAROLYN, contact_phone: null }, JACK];
    await sendManagerResolutionNotice({
      ...base,
      decidedByUserId: 'u-jack',
      inReplyTo: () => null,
    });
    const call = h.sendEmailMock.mock.calls[0][0];
    expect(call.in_reply_to).toBeUndefined();
    expect(call.subject).toBe('Time off request from Sam Rivera');
  });
});

describe('nobody is silently dropped', () => {
  it('counts and logs a manager who is unreachable both ways', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.state.employees = [{ ...CAROLYN, contact_phone: null }, JACK];
    h.state.users = [{ ...CAROLYN_LOGIN, email: '' }, JACK_LOGIN];

    const r = await sendManagerResolutionNotice({ ...base, decidedByUserId: 'u-jack' });
    expect(r.skipped).toBe(1);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/still think this is waiting on them/);
  });

  it('respects an owner who has switched approvals off', async () => {
    // A resolution is not an action item, so the safety valve does not apply —
    // an owner who does not want approval traffic genuinely hears nothing.
    // Note the EXPLICIT opt-out: as of 2026-08-22 an owner is not muted for
    // approvals by default, so this has to be a choice they made.
    h.state.users = [{ ...CAROLYN_LOGIN, role: 'owner' }, JACK_LOGIN];
    h.state.employees = [{ ...CAROLYN, notification_prefs: { approvals: false } }, JACK];
    const r = await sendManagerResolutionNotice({ ...base, decidedByUserId: 'u-jack' });
    expect(r).toEqual({ texted: 0, emailed: 0, skipped: 0 });
    expect(h.sendSmsMock).not.toHaveBeenCalled();
    expect(h.sendEmailMock).not.toHaveBeenCalled();
  });

  it('an owner who has said nothing either way is told like anyone else', async () => {
    // The default that matters at a two-manager client: the owner hears about a
    // decision unless they have opted out in as many words.
    h.state.users = [{ ...CAROLYN_LOGIN, role: 'owner' }, JACK_LOGIN];
    const r = await sendManagerResolutionNotice({ ...base, decidedByUserId: 'u-jack' });
    expect(r.texted).toBe(1);
  });

  it('does nothing, and throws nothing, when there is nobody else to tell', async () => {
    h.state.users = [JACK_LOGIN];
    h.state.employees = [JACK];
    const r = await sendManagerResolutionNotice({ ...base, decidedByUserId: 'u-jack' });
    expect(r).toEqual({ texted: 0, emailed: 0, skipped: 0 });
  });
});
