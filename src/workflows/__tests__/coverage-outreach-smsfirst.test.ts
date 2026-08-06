import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Batch-1 F2: emergency-coverage outreach is SMS-FIRST for phone-holders ──────
//
// dispatchOutreach was email-first: `if (employee.contact_email) { email } else if
// (phone) { sms }` — so a phone+email guard targeted for coverage got an EMAIL,
// never a text. SMS spec §3.5 makes coverage text-native end to end. This drives
// the REAL dispatchOutreach (EMAIL_ONLY=false) and asserts a phone-holder is
// texted, while a no-phone employee still gets the email (with buttons) fallback.

const h = vi.hoisted(() => ({
  sendSmsMock: vi.fn(async () => true),
  sendEmailMock: vi.fn(async () => {}),
}));

vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local', SUPABASE_SERVICE_ROLE_KEY: 'test',
    BASE_URL: 'https://test.local', ANTHROPIC_API_KEY: 'test',
    SENDGRID_API_KEY: 'test', SENDGRID_FROM_EMAIL: 'a@test.local', EMAIL_ONLY: false,
  },
}));

// Permissive builder: inserts/updates/deletes succeed; reads return nothing.
function makeBuilder() {
  const builder: Record<string, unknown> = {
    insert: () => Promise.resolve({ error: null }),
    update() { return builder; },
    delete() { return builder; },
    select() { return builder; },
    eq() { return builder; },
    in() { return builder; },
    is() { return builder; },
    like() { return builder; },
    order() { return builder; },
    limit() { return builder; },
    maybeSingle() { return Promise.resolve({ data: null, error: null }); },
    single() { return Promise.resolve({ data: null, error: null }); },
    then(onF: (v: { data: null; error: null }) => unknown, onR?: (e: unknown) => unknown) {
      return Promise.resolve({ data: null, error: null }).then(onF, onR);
    },
  };
  return builder;
}

vi.mock('../../db/client', () => ({ supabase: { from: () => makeBuilder() } }));
vi.mock('../../ai/claude', () => ({ generateReply: vi.fn(), classifyIntent: vi.fn(), withAnthropicRetry: vi.fn(), AnthropicOverloadError: class extends Error {} }));
vi.mock('../../messaging/email', () => ({ sendEmail: h.sendEmailMock }));
vi.mock('../../messaging/sms', () => ({ sendSms: h.sendSmsMock }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ computeWageEstimate: vi.fn(async () => 0) }));

import { dispatchOutreach, type CoverageSession } from '../emergency-coverage';
import type { Employee } from '../../db/types';

function session(): CoverageSession {
  return {
    session_id: 's1',
    company_id: 'c1',
    manager_contact: 'm@x.com', manager_channel: 'email',
    manager_sender: 'm@x.com', manager_recipient: 'aegis@x.com',
    callout_employee_id: 'e9', callout_employee_name: 'Jenna',
    shift_date: '2026-08-08',
    shift_info: { shift_name: 'Morning', start_time: '09:00', end_time: '13:00', role: 'Lifeguard' } as CoverageSession['shift_info'],
    state: 'outreach_in_progress',
    outreach_queue: [], outreach_results: [],
    coverage_filled: false, covered_by_employee_id: null,
    urgency_window_minutes: 120,
  } as CoverageSession;
}

function emp(over: Partial<Employee>): Employee {
  return { id: 'e1', company_id: 'c1', name: 'Luka', contact_phone: null, contact_email: null, ...over } as Employee;
}

beforeEach(() => { h.sendSmsMock.mockClear(); h.sendEmailMock.mockClear(); });

describe('dispatchOutreach — SMS-first for phone-holders (Batch-1 F2)', () => {
  it('texts a phone+email employee (SMS, not email)', async () => {
    const r = await dispatchOutreach({ employee: emp({ contact_phone: '+16165550123', contact_email: 'luka@x.com' }), session: session(), aegisSmsNumber: '+16167477953' });
    expect(r.sent).toBe(true);
    expect(h.sendSmsMock).toHaveBeenCalledTimes(1);
    expect(h.sendSmsMock.mock.calls[0][0]).toMatchObject({ to: '+16165550123' });
    expect(h.sendEmailMock).not.toHaveBeenCalled();
  });

  it('falls back to email (with buttons) for a no-phone employee', async () => {
    const r = await dispatchOutreach({ employee: emp({ contact_phone: null, contact_email: 'luka@x.com' }), session: session(), aegisSmsNumber: '+16167477953' });
    expect(r.sent).toBe(true);
    expect(h.sendEmailMock).toHaveBeenCalledTimes(1);
    expect(h.sendSmsMock).not.toHaveBeenCalled();
  });

  it('falls back to email when the tenant has no Aegis SMS number', async () => {
    await dispatchOutreach({ employee: emp({ contact_phone: '+16165550123', contact_email: 'luka@x.com' }), session: session(), aegisSmsNumber: null });
    expect(h.sendEmailMock).toHaveBeenCalledTimes(1);
    expect(h.sendSmsMock).not.toHaveBeenCalled();
  });
});
