import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Tier-0 SMS test: the onboarding OPT-IN CONSENT GATE over SMS ──────────────
//
// The single most safety-critical SMS behaviour: no scheduling content may be
// sent to a new hire until they affirmatively reply YES (A2P 10DLC / TCPA). The
// whole legal go-live gate depends on this. Supabase + messaging + Anthropic are
// FULLY MOCKED — no real DB, no real send. Drives the real
// handleOnboardingResponse at the `opt_in` step over an inbound SMS and asserts:
//   • YES  → opt-in recorded, advance to name_confirm, confirm text over SMS
//   • STOP → onboarding halted + session cleared, opt-out text, decline logged
//   • ambiguous → re-prompt only, NO advance, NO content leak, opt-in still false
//   • every outbound goes over SMS from the tenant's own number (never email)

const h = vi.hoisted(() => {
  const inserts: { table: string; rows: Record<string, unknown> }[] = [];
  const deletes: { table: string }[] = [];
  let employeeRow: Record<string, unknown> | null = null;

  function makeBuilder(table: string) {
    const state: { op: string } = { op: 'select' };
    const b: Record<string, unknown> = {
      select() { return b; },
      eq() { return b; },
      like() { return b; },
      in() { return b; },
      is() { return b; },
      insert(rows: Record<string, unknown>) { inserts.push({ table, rows }); return b; },
      update() { return b; },
      delete() { state.op = 'delete'; return b; },
      maybeSingle() { return Promise.resolve({ data: dataFor(table), error: null }); },
      single() { return Promise.resolve({ data: dataFor(table), error: null }); },
      then(onF: (v: { data: null; error: null }) => unknown, onR?: (e: unknown) => unknown) {
        if (state.op === 'delete') deletes.push({ table });
        return Promise.resolve({ data: null, error: null }).then(onF, onR);
      },
    };
    return b;
  }
  function dataFor(table: string): Record<string, unknown> | null {
    if (table === 'employees') return employeeRow;
    if (table === 'companies') return { name: 'Sandbox Club' };
    return null;
  }

  return {
    inserts, deletes, makeBuilder,
    setEmployee: (e: Record<string, unknown>) => { employeeRow = e; },
    sendSmsMock: vi.fn(async () => true),
    sendEmailMock: vi.fn(async () => {}),
    replyMock: vi.fn(async () => {}),
  };
});

vi.mock('@anthropic-ai/sdk', () => ({ default: class MockAnthropic { messages = { create: vi.fn() }; } }));
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
vi.mock('../../ai/claude', () => ({ withAnthropicRetry: vi.fn() }));

import { handleOnboardingResponse, type OnboardingSession } from '../employee-onboarding';
import type { InboundMessage, VerifiedContact } from '../../security/types';

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const EMPLOYEE_ID = '11111111-1111-1111-1111-111111111111';
const EMPLOYEE_PHONE = '+16165550123';
const TENANT_SMS_NUMBER = '+16166164898'; // the tenant's own Telnyx number

function makeSession(overrides: Partial<OnboardingSession> = {}): OnboardingSession & { _memory_id: string } {
  const future = new Date(Date.now() + 47 * 60 * 60 * 1000).toISOString();
  return {
    company_id: COMPANY_ID,
    employee_id: EMPLOYEE_ID,
    employee_name: 'Sam Rivera',
    employee_phone: EMPLOYEE_PHONE,
    employee_email: null,
    employee_channel: 'sms',
    aegis_sms_channel: TENANT_SMS_NUMBER,
    manager_contact: 'manager@sandbox.test',
    manager_channel: 'email',
    manager_sender: 'manager@sandbox.test',
    manager_recipient: 'aegis@aegis.quriasolutions.com',
    step: 'opt_in',
    collected: {
      name_confirmed: false, email: null, role: null,
      availability_raw: null, availability_parsed: [], availability_confirmed: false,
      time_off_submitted: false,
    },
    flagged_low_availability: false,
    invalid_email_attempts: 0,
    invalid_availability_attempts: 0,
    warned_24h: false,
    opt_in_confirmed: false,
    opt_in_sent_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    expires_at: future,
    _memory_id: 'mem-1',
    ...overrides,
  };
}

function inboundSms(body: string): InboundMessage {
  return { sender: EMPLOYEE_PHONE, recipient: TENANT_SMS_NUMBER, body, channel: 'sms' };
}

const CONTACT: VerifiedContact = {
  role: 'employee', company_id: COMPANY_ID, employee_id: EMPLOYEE_ID, user_id: null,
  name: 'Sam Rivera', matched_identifier: EMPLOYEE_PHONE, channel: 'sms',
};

const EMPLOYEE = {
  id: EMPLOYEE_ID, name: 'Sam Rivera', contact_phone: EMPLOYEE_PHONE, contact_email: null,
  company_id: COMPANY_ID, primary_role: null, active: true, aegis_access: 'employee',
};

beforeEach(() => {
  h.inserts.length = 0;
  h.deletes.length = 0;
  h.sendSmsMock.mockClear();
  h.sendEmailMock.mockClear();
  h.replyMock.mockClear();
  h.setEmployee({ ...EMPLOYEE });
});

describe('onboarding opt-in gate over SMS', () => {
  it('YES → records opt-in, advances to name_confirm, texts the confirmation over SMS', async () => {
    const session = makeSession();
    await handleOnboardingResponse(inboundSms('YES'), CONTACT, session);

    expect(session.opt_in_confirmed).toBe(true);
    expect(session.step).toBe('name_confirm');

    // Outbound went over SMS from the tenant's own number — never email.
    expect(h.sendEmailMock).not.toHaveBeenCalled();
    expect(h.sendSmsMock).toHaveBeenCalledTimes(1);
    const smsArg = h.sendSmsMock.mock.calls[0][0] as { to: string; from: string; body: string; company_id: string };
    expect(smsArg.to).toBe(EMPLOYEE_PHONE);
    expect(smsArg.from).toBe(TENANT_SMS_NUMBER);
    expect(smsArg.company_id).toBe(COMPANY_ID);
    expect(smsArg.body.toLowerCase()).toContain('name');

    // Consent was logged for the audit trail.
    expect(h.inserts.some(i => i.table === 'activity_log' && i.rows.action === 'employee_opt_in_confirmed')).toBe(true);
  });

  it('STOP → halts onboarding, clears the session, sends the opt-out text, logs the decline', async () => {
    const session = makeSession();
    await handleOnboardingResponse(inboundSms('STOP'), CONTACT, session);

    expect(session.opt_in_confirmed).toBe(false);
    // opt-out acknowledgement sent over SMS
    expect(h.sendSmsMock).toHaveBeenCalledTimes(1);
    const body = (h.sendSmsMock.mock.calls[0][0] as { body: string }).body.toLowerCase();
    expect(body).toContain('further messages');
    // session cleared + decline logged
    expect(h.deletes.some(d => d.table === 'aegis_memory')).toBe(true);
    expect(h.inserts.some(i => i.table === 'activity_log' && i.rows.action === 'employee_opt_in_declined')).toBe(true);
  });

  it('ambiguous reply → re-prompts only; no advance, no consent, no content leak', async () => {
    const session = makeSession();
    await handleOnboardingResponse(inboundSms('maybe later'), CONTACT, session);

    // Gate holds: still on opt_in, still not consented.
    expect(session.opt_in_confirmed).toBe(false);
    expect(session.step).toBe('opt_in');

    // The only thing sent is the opt-in re-prompt — never name/role/scheduling content.
    expect(h.sendSmsMock).toHaveBeenCalledTimes(1);
    const body = (h.sendSmsMock.mock.calls[0][0] as { body: string }).body.toLowerCase();
    expect(body).toContain('yes');
    // No consent decision logged either way.
    expect(h.inserts.some(i => i.table === 'activity_log' &&
      (i.rows.action === 'employee_opt_in_confirmed' || i.rows.action === 'employee_opt_in_declined'))).toBe(false);
  });
});
