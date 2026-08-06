import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── SMS go-live guard: availability decision notifications are SMS-FIRST ────────
//
// Batch-1 F1: the availability approve/deny employee notice must text a
// phone-holder when EMAIL_ONLY=false, INDEPENDENT of the channel the pending was
// created with. The Homebase availability tab passes employee_channel='email',
// so the old channel-mirroring route emailed phone-holders who should have been
// texted. notifyEmployeeOfAvailabilityDecision now resolves the employee's real
// contacts + the tenant SMS number and routes SMS-first (email = fallback).
//
// Under EMAIL_ONLY sendSms is a runtime no-op, so this is invisible in prod
// today; this test pins the WIRING for go-live (EMAIL_ONLY=false). Drives the
// REAL applyAvailabilityDecision; only the transport (sendSms/sendEmail), DB,
// env, and Anthropic are mocked. change_request_id is omitted so the guarded
// ledger-flip is skipped and we isolate the notify path.

const h = vi.hoisted(() => {
  // The employee on file — a phone-holder with an email too. Flip hasPhone to
  // exercise the email fallback (no phone → email).
  const state = { hasPhone: true };
  function makeBuilder(table?: string) {
    const builder: Record<string, unknown> = {
      delete() { return builder; },
      insert() { return builder; },
      update() { return builder; },
      select() { return builder; },
      eq() { return builder; },
      in() { return builder; },
      is() { return builder; },
      maybeSingle() {
        if (table === 'employees') {
          return Promise.resolve({
            data: { contact_phone: state.hasPhone ? '+16163280114' : null, contact_email: 'sam@example.com' },
            error: null,
          });
        }
        if (table === 'company_channels') {
          return Promise.resolve({ data: { channel_value: '+16167477953' }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      single() { return Promise.resolve({ data: null, error: null }); },
      then(onF: (v: { data: null; error: null }) => unknown, onR?: (e: unknown) => unknown) {
        return Promise.resolve({ data: null, error: null }).then(onF, onR);
      },
    };
    return builder;
  }
  const sendSmsMock = vi.fn(async () => true);
  const sendEmailMock = vi.fn(async () => {});
  return { makeBuilder, sendSmsMock, sendEmailMock, state };
});

vi.mock('@anthropic-ai/sdk', () => ({ default: class MockAnthropic { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({
  // EMAIL_ONLY omitted → falsy → SMS-first is active (go-live posture).
  env: {
    ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k',
    SENDGRID_FROM_EMAIL: 'aegis@test.local', SENDGRID_FROM_NAME: 'Aegis', BASE_URL: 'http://localhost:3000', NODE_ENV: 'test',
  },
}));
vi.mock('../../db/client', () => ({ supabase: { from: (t: string) => h.makeBuilder(t) } }));
vi.mock('../../messaging/sms', () => ({ sendSms: h.sendSmsMock }));
vi.mock('../../messaging/email', () => ({ sendEmail: h.sendEmailMock }));
vi.mock('../../ai/claude', () => ({ withAnthropicRetry: vi.fn() }));

import { applyAvailabilityDecision, type AvailabilitySlot } from '../employee-onboarding';

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const EMPLOYEE_ID = 'e1684385-ab46-472d-82b8-9009cd705bde';
const PROPOSED: AvailabilitySlot[] = [{ day_of_week: 2, start_time: '09:00', end_time: '17:00' }];
const CURRENT: AvailabilitySlot[] = [{ day_of_week: 1, start_time: '09:00', end_time: '17:00' }];

function input(channel: 'sms' | 'email', sender: string, decision: 'approved' | 'denied' = 'approved') {
  return {
    decision,
    company_id: COMPANY_ID,
    employee_id: EMPLOYEE_ID,
    employee_name: 'Sam Rivera',
    current_availability: CURRENT,
    proposed_availability: PROPOSED,
    availability_raw: 'drop mondays',
    decided_by: 'Sandbox Manager',
    employee_sender: sender,
    employee_recipient: channel === 'sms' ? '+16167477953' : 'sandbox@aegis.quriasolutions.com',
    employee_channel: channel,
    thread_id: null,
    raw_subject: null,
    // change_request_id omitted → guarded flip skipped → isolate the notify path
  };
}

beforeEach(() => { h.sendSmsMock.mockClear(); h.sendEmailMock.mockClear(); h.state.hasPhone = true; });

describe('availability decision notification — SMS-first for phone-holders (Batch-1 F1)', () => {
  it('APPROVE texts the phone-holder (SMS-channel pending)', async () => {
    await applyAvailabilityDecision(input('sms', '+16163280114'));
    expect(h.sendSmsMock).toHaveBeenCalledTimes(1);
    expect(h.sendSmsMock.mock.calls[0][0]).toMatchObject({ to: '+16163280114' });
    expect(h.sendEmailMock).not.toHaveBeenCalled();
  });

  it('DENY texts the phone-holder (SMS-channel pending)', async () => {
    await applyAvailabilityDecision(input('sms', '+16163280114', 'denied'));
    expect(h.sendSmsMock).toHaveBeenCalledTimes(1);
    expect(h.sendSmsMock.mock.calls[0][0]).toMatchObject({ to: '+16163280114' });
    expect(h.sendEmailMock).not.toHaveBeenCalled();
  });

  it('APPROVE on an EMAIL-channel pending STILL texts the phone-holder (the F1 fix)', async () => {
    // The Homebase availability tab passes employee_channel='email'; the phone-
    // holder must still be texted, not emailed.
    await applyAvailabilityDecision(input('email', 'sam@example.com'));
    expect(h.sendSmsMock).toHaveBeenCalledTimes(1);
    expect(h.sendSmsMock.mock.calls[0][0]).toMatchObject({ to: '+16163280114' });
    expect(h.sendEmailMock).not.toHaveBeenCalled();
  });

  it('falls back to EMAIL when the employee has no phone on file', async () => {
    h.state.hasPhone = false;
    await applyAvailabilityDecision(input('email', 'sam@example.com'));
    expect(h.sendEmailMock).toHaveBeenCalledTimes(1);
    expect(h.sendEmailMock.mock.calls[0][0]).toMatchObject({ to: 'sam@example.com' });
    expect(h.sendSmsMock).not.toHaveBeenCalled();
  });
});
