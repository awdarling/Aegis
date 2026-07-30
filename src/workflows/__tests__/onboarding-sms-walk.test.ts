import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Tier-0 FULL onboarding walk over SMS ─────────────────────────────────────
//
// Drives the real handleOnboardingResponse through the entire onboarding flow
// for a brand-new SMS hire — opt_in → name_confirm → email → role → availability
// → availability_confirm → time_off → complete — reusing one session object so
// each step's mutations carry to the next inbound (the router reloads it from
// aegis_memory in production; here we thread it directly). Supabase, Anthropic
// and messaging are FULLY MOCKED. Proves the step machine chains correctly over
// text and that completion writes the employee's email, role, and availability.

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
        return Promise.resolve({ data: thenDataFor(table), error: null }).then(onF, onR);
      },
    };
    return b;
  }
  // Reads via single()/maybeSingle()
  function dataFor(table: string): unknown {
    if (table === 'employees') return employeeRow;
    if (table === 'companies') return { name: 'Sandbox Club' };
    return null;
  }
  // Reads via awaited list queries (no single())
  function thenDataFor(table: string): unknown {
    if (table === 'shift_requirements') return [{ role: 'guard' }, { role: 'Lifeguard' }];
    return null; // shift_types → [] → loadShiftBounds default bounds (06:00–23:00, 4h)
  }

  return {
    writes, makeBuilder,
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

import { handleOnboardingResponse, type OnboardingSession } from '../employee-onboarding';
import type { InboundMessage, VerifiedContact } from '../../security/types';

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const EMPLOYEE_ID = '11111111-1111-1111-1111-111111111111';
const EMPLOYEE_PHONE = '+16165550123';
const TENANT_SMS_NUMBER = '+16166164898';

function txt(t: string) { return { content: [{ type: 'text', text: t }] }; }

function makeSession(): OnboardingSession & { _memory_id: string } {
  const future = new Date(Date.now() + 47 * 60 * 60 * 1000).toISOString();
  return {
    company_id: COMPANY_ID, employee_id: EMPLOYEE_ID, employee_name: 'Sam Rivera',
    employee_phone: EMPLOYEE_PHONE, employee_email: null, employee_channel: 'sms',
    aegis_sms_channel: TENANT_SMS_NUMBER,
    manager_contact: 'manager@sandbox.test', manager_channel: 'email',
    manager_sender: 'manager@sandbox.test', manager_recipient: 'aegis@aegis.quriasolutions.com',
    step: 'opt_in',
    collected: {
      name_confirmed: false, email: null, role: null, availability_raw: null,
      availability_parsed: [], availability_confirmed: false, time_off_submitted: false,
    },
    flagged_low_availability: false, invalid_email_attempts: 0, invalid_availability_attempts: 0,
    warned_24h: false, opt_in_confirmed: false, opt_in_sent_at: new Date().toISOString(),
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
function lastSms(): string {
  const calls = h.sendSmsMock.mock.calls;
  return (calls[calls.length - 1][0] as { body: string }).body;
}

beforeEach(() => {
  h.writes.length = 0;
  h.sendSmsMock.mockClear();
  h.setEmployee({
    id: EMPLOYEE_ID, name: 'Sam Rivera', contact_phone: EMPLOYEE_PHONE, contact_email: null,
    company_id: COMPANY_ID, primary_role: null, active: true, aegis_access: 'employee',
    qualified_roles: [],
  });
  // Context-aware LLM: respond by which helper's system prompt is calling.
  h.createMock.mockImplementation(async (args: { system?: string }) => {
    const sys = args.system ?? '';
    if (sys.includes("confirms a person's name")) return txt(JSON.stringify({ matches: true }));
    if (sys.includes('parsing employee availability from natural language')) {
      return txt(JSON.stringify({ slots: [
        { day_of_week: 1, start_time: '09:00', end_time: '17:00' },
        { day_of_week: 2, start_time: '09:00', end_time: '17:00' },
        { day_of_week: 4, start_time: '13:00', end_time: '21:00' },
      ] }));
    }
    if (sys.includes('Extract time-off dates')) return txt(JSON.stringify({ dates: [] }));
    if (sys.includes('one word')) return txt('yes'); // "clearly no upcoming time off?" → yes
    return txt('{}');
  });
});

describe('full onboarding walk over SMS (Tier 0)', () => {
  it('drives a new hire from opt-in through completion, saving email/role/availability', async () => {
    const s = makeSession();

    // 1. Opt-in
    await handleOnboardingResponse(inbound('YES'), CONTACT, s);
    expect(s.opt_in_confirmed).toBe(true);
    expect(s.step).toBe('name_confirm');
    expect(lastSms().toLowerCase()).toContain('full name');

    // 2. Name
    await handleOnboardingResponse(inbound('Sam Rivera'), CONTACT, s);
    expect(s.collected.name_confirmed).toBe(true);
    expect(s.step).toBe('email');
    expect(lastSms().toLowerCase()).toContain('email');

    // 3. Email
    await handleOnboardingResponse(inbound('sam@example.com'), CONTACT, s);
    expect(s.collected.email).toBe('sam@example.com');
    expect(s.step).toBe('role');
    expect(lastSms()).toContain('guard'); // role list

    // 4. Role (reply "2" → sorted roles ['Lifeguard','guard'] → 'guard')
    await handleOnboardingResponse(inbound('2'), CONTACT, s);
    expect(s.collected.role).toBe('guard');
    expect(s.step).toBe('availability');
    expect(lastSms().toLowerCase()).toContain('availability');

    // 5. Availability (free text → parsed to 3 slots)
    await handleOnboardingResponse(inbound('Mon and Tue 9-5, Thursday 1-9'), CONTACT, s);
    expect(s.collected.availability_parsed).toHaveLength(3);
    expect(s.step).toBe('availability_confirm');
    expect(lastSms()).toContain('Does that look right?');

    // 6. Confirm availability (clean affirmation)
    await handleOnboardingResponse(inbound('looks good'), CONTACT, s);
    expect(s.collected.availability_confirmed).toBe(true);
    expect(s.step).toBe('time_off');
    expect(lastSms().toLowerCase()).toContain('upcoming dates');

    // 7. Time off (none) → completion
    await handleOnboardingResponse(inbound('nothing coming up'), CONTACT, s);
    expect(s.step).toBe('complete');
    expect(lastSms().toLowerCase()).toContain('all set');

    // Completion writes: employee email + role, availability rows, session cleared.
    const empUpdate = h.writes.find(
      w => w.table === 'employees' && w.op === 'update' &&
        (w.rows as Record<string, unknown>).contact_email === 'sam@example.com' &&
        (w.rows as Record<string, unknown>).primary_role === 'guard'
    );
    expect(empUpdate).toBeTruthy();
    expect(h.writes.some(w => w.table === 'availability' && w.op === 'insert')).toBe(true);
    expect(h.writes.some(w => w.table === 'aegis_memory' && w.op === 'delete')).toBe(true);
  });
});
