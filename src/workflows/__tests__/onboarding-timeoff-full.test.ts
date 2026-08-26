import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Onboarding time-off now gets the FULL treatment ──────────────────────────
//
// When a new hire names time-off dates during onboarding, handleTimeOffStep must
// route each request through the SAME create+notify core the normal time-off
// flow uses (coverage sim + rich manager approve/deny email + SMS alert) — NOT
// the old bare insert + one-line manager text — AND send the employee a real
// "passed it to your manager" confirmation (the gap Alexander hit: his family
// vacation got a silent "you're all set"). Completion then emails the manager an
// audit summary that lists the pending time off. This pins that wiring.
//
// '../time-off' is mocked so createTimeOffRequestAndNotify is observable without
// dragging in the simulator; resolvePartialWindow / formatDateRange are stubbed
// too (onboarding imports all three from that module).

const h = vi.hoisted(() => {
  const writes: { table: string; op: string; rows?: unknown }[] = [];
  let employeeRow: Record<string, unknown> | null = null;

  function makeBuilder(table: string) {
    const b: Record<string, unknown> = {
      select() { return b; },
      eq() { return b; },
      like() { return b; },
      in() { return b; },
      is() { return b; },
      order() { return b; },
      limit() { return b; },
      insert(rows: unknown) { writes.push({ table, op: 'insert', rows }); return b; },
      update(rows: unknown) { writes.push({ table, op: 'update', rows }); return b; },
      delete() { writes.push({ table, op: 'delete' }); return b; },
      maybeSingle() { return Promise.resolve({ data: dataFor(table), error: null }); },
      single() { return Promise.resolve({ data: dataFor(table), error: null }); },
      then(onF: (v: { data: unknown; error: null }) => unknown, onR?: (e: unknown) => unknown) {
        // LIST queries (no .single()/.maybeSingle()). The manager directory
        // loads a company's logins and its people as lists and joins them in
        // memory, so these have to be arrays, not the single-row fixtures above.
        return Promise.resolve({ data: listFor(table), error: null }).then(onF, onR);
      },
    };
    return b;
  }
  function dataFor(table: string): unknown {
    if (table === 'employees') return employeeRow;
    if (table === 'companies') return { name: 'Sandbox Club' };
    if (table === 'users') return MANAGER_LOGIN;
    return null;
  }
  // Morgan's login points at Morgan's person record — the users.employee_id
  // link, not a string match on her email address.
  const MANAGER_LOGIN = {
    id: 'mgr-1', email: 'morgan@sandbox.test', name: 'Morgan',
    role: 'manager', employee_id: 'emp-morgan',
  };
  const MANAGER_PERSON = {
    id: 'emp-morgan', name: 'Morgan', contact_phone: '+15550001111',
    contact_email: 'morgan@sandbox.test', active: true, notification_prefs: {},
  };
  function listFor(table: string): unknown {
    if (table === 'users') return [MANAGER_LOGIN];
    if (table === 'employees') return [MANAGER_PERSON];
    return null;
  }

  return {
    writes, makeBuilder,
    setEmployee: (e: Record<string, unknown>) => { employeeRow = e; },
    createMock: vi.fn(),
    sendSmsMock: vi.fn(async () => true),
    sendEmailMock: vi.fn(async () => {}),
    replyMock: vi.fn(async () => {}),
    createTimeOffMock: vi.fn(async () => 'tor-abc'),
  };
});

vi.mock('@anthropic-ai/sdk', () => ({ default: class MockAnthropic { messages = { create: h.createMock }; } }));
vi.mock('../../ai/claude', () => ({ withAnthropicRetry: (fn: () => unknown) => fn() }));
vi.mock('../../config/env', () => ({
  env: {
    ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k',
    SENDGRID_FROM_EMAIL: 'aegis@test.local', SENDGRID_FROM_NAME: 'Aegis', BASE_URL: 'http://localhost:3000',
    NODE_ENV: 'test', EMAIL_ONLY: false,
  },
}));
vi.mock('../../db/client', () => ({ supabase: { from: (t: string) => h.makeBuilder(t) } }));
vi.mock('../../messaging/email', () => ({ sendEmail: h.sendEmailMock }));
vi.mock('../../messaging/sms', () => ({ sendSms: h.sendSmsMock, getTenantSmsNumber: vi.fn(async () => null) }));
vi.mock('../../messaging/reply', () => ({ reply: h.replyMock, sendInThreadAck: vi.fn(async () => {}) }));
vi.mock('../time-off', () => ({
  createTimeOffRequestAndNotify: h.createTimeOffMock,
  resolvePartialWindow: () => null,
  // W-1 branch 2: partial entries resolve against the schedule before staging;
  // pass-through here (these tests stage full days).
  resolvePartialEntries: async (entries: unknown[]) => entries,
  formatDateRange: (a: string, b: string) => (a === b ? a : `${a} to ${b}`),
  // Onboarding now reuses the normal flow's affirmation detector at the confirm
  // step; mirror the real regex so the mocked module keeps the same behavior.
  isTimeOffAffirmation: (body: string) =>
    /^(yes|yeah|yea|yep|yup|y\b|correct|confirmed|confirm|that'?s right|right|ok|okay|sure|send(?: it| that| it over)?|go (?:ahead|for it)|do it|please do|please|sounds good|looks good|that works|perfect|great|👍)/.test(
      body.trim().toLowerCase(),
    ),
}));

import { handleOnboardingResponse, type OnboardingSession } from '../employee-onboarding';
import type { InboundMessage, VerifiedContact } from '../../security/types';

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const EMPLOYEE_ID = '11111111-1111-1111-1111-111111111111';
const EMPLOYEE_PHONE = '+16165550123';
const TENANT_SMS_NUMBER = '+16166164898';

function txt(t: string) { return { content: [{ type: 'text', text: t }] }; }

function makeSessionAtTimeOff(): OnboardingSession & { _memory_id: string } {
  const future = new Date(Date.now() + 47 * 60 * 60 * 1000).toISOString();
  return {
    company_id: COMPANY_ID, employee_id: EMPLOYEE_ID, employee_name: 'Sam Rivera',
    employee_phone: EMPLOYEE_PHONE, employee_email: null, employee_channel: 'sms',
    aegis_sms_channel: TENANT_SMS_NUMBER,
    manager_contact: 'manager@sandbox.test', manager_channel: 'email',
    manager_sender: 'manager@sandbox.test', manager_recipient: 'aegis@aegis.quriasolutions.com',
    step: 'time_off',
    collected: {
      name_confirmed: true, email: 'sam@example.com', role: 'guard', availability_raw: 'Mon 9-5',
      availability_parsed: [
        { day_of_week: 1, start_time: '09:00', end_time: '17:00' },
        { day_of_week: 4, start_time: '13:00', end_time: '21:00' },
      ],
      availability_confirmed: true, time_off_submitted: false,
    },
    flagged_low_availability: false, invalid_email_attempts: 0, invalid_availability_attempts: 0,
    warned_24h: false, opt_in_confirmed: true, opt_in_sent_at: new Date().toISOString(),
    started_at: new Date().toISOString(), expires_at: future, _memory_id: 'mem-1',
  };
}

const CONTACT: VerifiedContact = {
  role: 'employee', company_id: COMPANY_ID, employee_id: EMPLOYEE_ID, user_id: null,
  name: 'Sam Rivera', matched_identifier: EMPLOYEE_PHONE, channel: 'sms',
};

function inbound(body: string): InboundMessage {
  return { sender: EMPLOYEE_PHONE, recipient: TENANT_SMS_NUMBER, body, channel: 'sms' };
}
function smsBodies(): string[] {
  return h.sendSmsMock.mock.calls.map(c => (c[0] as { body: string }).body);
}

beforeEach(() => {
  h.writes.length = 0;
  h.sendSmsMock.mockClear();
  h.sendEmailMock.mockClear();
  h.createTimeOffMock.mockClear();
  h.setEmployee({
    id: EMPLOYEE_ID, name: 'Sam Rivera', contact_phone: EMPLOYEE_PHONE, contact_email: 'sam@example.com',
    company_id: COMPANY_ID, primary_role: 'guard', active: true, aegis_access: 'employee',
    qualified_roles: ['guard'],
  });
  h.createMock.mockImplementation(async (args: { system?: string; messages?: Array<{ content?: unknown }> }) => {
    const sys = args.system ?? '';
    const userMsg = String(args.messages?.[0]?.content ?? '').toLowerCase();
    // Date extraction returns a date only when the message actually names one, so
    // "yes"/"skip" at the confirm step parse to no dates (as the real model would).
    if (sys.includes('Extract time-off dates')) {
      if (userMsg.includes('21')) {
        return txt(JSON.stringify({ dates: [{ start_date: '2026-08-21', end_date: '2026-08-21', time_off_type: 'full_day' }] }));
      }
      if (userMsg.includes('20') || userMsg.includes('august') || userMsg.includes('trip')) {
        return txt(JSON.stringify({ dates: [{ start_date: '2026-08-20', end_date: '2026-08-20', time_off_type: 'full_day' }] }));
      }
      return txt(JSON.stringify({ dates: [] }));
    }
    if (sys.includes('one word')) return txt('no');
    return txt('{}');
  });
});

describe('onboarding time-off has a confirmation step before it submits', () => {
  it('stages the dates and asks to confirm — nothing is submitted yet', async () => {
    const s = makeSessionAtTimeOff();

    await handleOnboardingResponse(inbound('I need August 20th off for a family trip'), CONTACT, s);

    // NOT submitted — high-stakes, so it must be confirmed first.
    expect(h.createTimeOffMock).not.toHaveBeenCalled();
    expect(h.writes.some(w => w.table === 'time_off_requests' && w.op === 'insert')).toBe(false);
    expect(s.step).toBe('time_off_confirm');
    expect(s.collected.time_off_pending).toHaveLength(1);
    expect(s.collected.time_off_pending![0].start_date).toBe('2026-08-20');

    // Employee is asked to confirm and shown the date.
    const prompt = smsBodies()[smsBodies().length - 1].toLowerCase();
    expect(prompt).toContain('look right');
    expect(prompt).toContain('yes');
  });

  it('YES submits through the shared core, confirms to the employee, completes, emails the summary', async () => {
    const s = makeSessionAtTimeOff();
    await handleOnboardingResponse(inbound('I need August 20th off for a family trip'), CONTACT, s);
    await handleOnboardingResponse(inbound('yes'), CONTACT, s);

    // Routed through the SHARED core (not a bare local insert).
    expect(h.createTimeOffMock).toHaveBeenCalledTimes(1);
    const [companyArg, employeeArg, pendingArg] = h.createTimeOffMock.mock.calls[0] as [
      string, { id: string }, { start_date: string; channel: string; sender: string }
    ];
    expect(companyArg).toBe(COMPANY_ID);
    expect(employeeArg.id).toBe(EMPLOYEE_ID);
    expect(pendingArg.start_date).toBe('2026-08-20');
    expect(pendingArg.channel).toBe('sms');
    expect(pendingArg.sender).toBe(EMPLOYEE_PHONE);
    expect(h.writes.some(w => w.table === 'time_off_requests' && w.op === 'insert')).toBe(false);

    const bodies = smsBodies().map(b => b.toLowerCase());
    expect(bodies.some(b => b.includes('sent your time off') && b.includes('manager'))).toBe(true);
    expect(s.collected.time_off_submitted).toBe(true);
    expect(s.collected.time_off_pending).toBeNull();
    expect(s.step).toBe('complete');

    // Completion message nudges the employee about other capabilities.
    expect(bodies.some(b => b.includes('what can you do'))).toBe(true);

    // Manager audit summary email went out and lists the pending time off.
    const summaryCall = h.sendEmailMock.mock.calls
      .map(c => c[0] as { to: string; subject: string; text: string; html: string })
      .find(e => e.subject.includes('completed onboarding'));
    expect(summaryCall).toBeTruthy();
    expect(summaryCall!.to).toBe('morgan@sandbox.test');
    expect(summaryCall!.text).toContain('2026-08-20');
    expect(summaryCall!.text.toLowerCase()).toContain('pending your approval');
  });

  it('an edit at the confirm step re-parses and re-confirms without submitting', async () => {
    const s = makeSessionAtTimeOff();
    await handleOnboardingResponse(inbound('August 20th off'), CONTACT, s);
    await handleOnboardingResponse(inbound('actually make it the 21st'), CONTACT, s);

    expect(h.createTimeOffMock).not.toHaveBeenCalled();
    expect(s.step).toBe('time_off_confirm');
    expect(s.collected.time_off_pending).toHaveLength(1);
    expect(s.collected.time_off_pending![0].start_date).toBe('2026-08-21');
    const prompt = smsBodies()[smsBodies().length - 1].toLowerCase();
    expect(prompt).toContain('2026-08-21');
    expect(prompt).toContain('look right');
  });

  it('"skip" at the confirm step finishes with NO time off sent', async () => {
    const s = makeSessionAtTimeOff();
    await handleOnboardingResponse(inbound('August 20th off'), CONTACT, s);
    await handleOnboardingResponse(inbound('skip'), CONTACT, s);

    expect(h.createTimeOffMock).not.toHaveBeenCalled();
    expect(s.collected.time_off_submitted).toBe(false);
    expect(s.collected.time_off_pending).toBeNull();
    expect(s.step).toBe('complete');
    // No pending time off in the manager summary.
    const summaryCall = h.sendEmailMock.mock.calls
      .map(c => c[0] as { subject: string; text: string })
      .find(e => e.subject.includes('completed onboarding'));
    expect(summaryCall!.text.toLowerCase()).toContain('no time off');
  });
});
