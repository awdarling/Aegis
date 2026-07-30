import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Onboarding availability confirm — smart partial correction over SMS ───────
//
// The premium "feels like a person" behaviour: at the availability read-back the
// employee can confirm naturally, ask for a specific change (which is applied in
// place and read back), or ask to redo it — no robotic "reply YES/NO" gate.
// Anthropic + Supabase + messaging are FULLY MOCKED. Drives the real
// handleOnboardingResponse at the availability_confirm step.

const h = vi.hoisted(() => {
  let employeeRow: Record<string, unknown> | null = null;
  function makeBuilder(table: string) {
    const state: { op: string } = { op: 'select' };
    const b: Record<string, unknown> = {
      select() { return b; },
      eq() { return b; },
      like() { return b; },
      in() { return b; },
      is() { return b; },
      insert() { return b; },
      update() { return b; },
      delete() { state.op = 'delete'; return b; },
      maybeSingle() { return Promise.resolve({ data: dataFor(table), error: null }); },
      single() { return Promise.resolve({ data: dataFor(table), error: null }); },
      then(onF: (v: { data: null; error: null }) => unknown, onR?: (e: unknown) => unknown) {
        // shift_types (loadShiftBounds) awaits the builder directly → data:null →
        // loadShiftBounds returns default bounds (06:00–23:00, min 4h).
        return Promise.resolve({ data: null, error: null }).then(onF, onR);
      },
    };
    return b;
  }
  function dataFor(table: string): Record<string, unknown> | null {
    return table === 'employees' ? employeeRow : null;
  }
  return {
    makeBuilder,
    setEmployee: (e: Record<string, unknown>) => { employeeRow = e; },
    createMock: vi.fn(),
    sendSmsMock: vi.fn(async () => true),
    sendEmailMock: vi.fn(async () => {}),
    replyMock: vi.fn(async () => {}),
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

import { handleOnboardingResponse, type OnboardingSession, type AvailabilitySlot } from '../employee-onboarding';
import type { InboundMessage, VerifiedContact } from '../../security/types';

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const EMPLOYEE_ID = '11111111-1111-1111-1111-111111111111';
const EMPLOYEE_PHONE = '+16165550123';
const TENANT_SMS_NUMBER = '+16166164898';

// Mon/Tue 9–5, Thu 1–9 (day_of_week: 1=Mon, 2=Tue, 4=Thu)
const START_AVAIL: AvailabilitySlot[] = [
  { day_of_week: 1, start_time: '09:00', end_time: '17:00' },
  { day_of_week: 2, start_time: '09:00', end_time: '17:00' },
  { day_of_week: 4, start_time: '13:00', end_time: '21:00' },
];

function makeSession(): OnboardingSession & { _memory_id: string } {
  const future = new Date(Date.now() + 47 * 60 * 60 * 1000).toISOString();
  return {
    company_id: COMPANY_ID, employee_id: EMPLOYEE_ID, employee_name: 'Sam Rivera',
    employee_phone: EMPLOYEE_PHONE, employee_email: null, employee_channel: 'sms',
    aegis_sms_channel: TENANT_SMS_NUMBER,
    manager_contact: 'manager@sandbox.test', manager_channel: 'email',
    manager_sender: 'manager@sandbox.test', manager_recipient: 'aegis@aegis.quriasolutions.com',
    step: 'availability_confirm',
    collected: {
      name_confirmed: true, email: null, role: 'guard',
      availability_raw: 'mon and tue 9-5, thursday 1-9',
      availability_parsed: START_AVAIL.map(s => ({ ...s })),
      availability_confirmed: false, time_off_submitted: false,
    },
    flagged_low_availability: false, invalid_email_attempts: 0, invalid_availability_attempts: 0,
    warned_24h: false, opt_in_confirmed: true, opt_in_sent_at: new Date().toISOString(),
    started_at: new Date().toISOString(), expires_at: future, _memory_id: 'mem-1',
  };
}

function inbound(body: string): InboundMessage {
  return { sender: EMPLOYEE_PHONE, recipient: TENANT_SMS_NUMBER, body, channel: 'sms' };
}
const CONTACT: VerifiedContact = {
  role: 'employee', company_id: COMPANY_ID, employee_id: EMPLOYEE_ID, user_id: null,
  name: 'Sam Rivera', matched_identifier: EMPLOYEE_PHONE, channel: 'sms',
};
function llmReturns(obj: unknown) {
  h.createMock.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
}
function lastSms(): string {
  const calls = h.sendSmsMock.mock.calls;
  return (calls[calls.length - 1][0] as { body: string }).body;
}

beforeEach(() => {
  h.createMock.mockReset();
  h.sendSmsMock.mockClear();
  h.setEmployee({
    id: EMPLOYEE_ID, name: 'Sam Rivera', contact_phone: EMPLOYEE_PHONE, contact_email: null,
    company_id: COMPANY_ID, primary_role: 'guard', active: true, aegis_access: 'employee',
  });
});

describe('availability confirm — smart partial correction', () => {
  it('a clean affirmation confirms and advances (no LLM call)', async () => {
    const session = makeSession();
    await handleOnboardingResponse(inbound('looks good'), CONTACT, session);

    expect(session.collected.availability_confirmed).toBe(true);
    expect(session.step).toBe('time_off');
    expect(h.createMock).not.toHaveBeenCalled();
    expect(lastSms().toLowerCase()).toContain('upcoming dates'); // the time-off prompt
  });

  it('a partial correction is applied in place and the UPDATED availability is read back', async () => {
    const session = makeSession();
    // "looks good but I can't do Tuesdays" → LLM returns the full set minus Tuesday.
    llmReturns({
      action: 'revise',
      slots: [
        { day_of_week: 1, start_time: '09:00', end_time: '17:00' },
        { day_of_week: 4, start_time: '13:00', end_time: '21:00' },
      ],
    });

    await handleOnboardingResponse(inbound("looks good but I can't do Tuesdays"), CONTACT, session);

    // Still confirming (not advanced), Tuesday dropped, updated read-back sent.
    expect(session.step).toBe('availability_confirm');
    expect(session.collected.availability_confirmed).toBe(false);
    expect(session.collected.availability_parsed.map(s => s.day_of_week).sort()).toEqual([1, 4]);
    const msg = lastSms();
    expect(msg).toContain('updated');
    expect(msg).toContain('Monday');
    expect(msg).toContain('Thursday');
    expect(msg).not.toContain('Tuesday');
    expect(msg).toContain('Does that look right?');
  });

  it('a bare "no" restarts availability collection (no LLM call)', async () => {
    const session = makeSession();
    await handleOnboardingResponse(inbound('no'), CONTACT, session);

    expect(session.step).toBe('availability');
    expect(session.collected.availability_parsed).toEqual([]);
    expect(h.createMock).not.toHaveBeenCalled();
    expect(lastSms().toLowerCase()).toContain('availability'); // re-ask prompt
  });

  it('an unclear reply re-reads the availability back without changing anything', async () => {
    const session = makeSession();
    llmReturns({ action: 'unclear' });

    await handleOnboardingResponse(inbound('what time do you open?'), CONTACT, session);

    expect(session.step).toBe('availability_confirm');
    expect(session.collected.availability_parsed).toHaveLength(3);
    expect(session.collected.availability_confirmed).toBe(false);
    expect(lastSms()).toContain('Does that look right?');
  });
});
