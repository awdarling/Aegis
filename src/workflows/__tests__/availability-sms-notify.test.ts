import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── SMS go-live guard: availability decision notifications route by channel ─────
//
// The availability approve/deny employee notice must go out on the SAME channel
// the employee submitted on — an SMS-submitted change gets an SMS decision — via
// the shared channel-aware `reply()` (→ sendSms / sendEmail). Under EMAIL_ONLY
// sendSms is a runtime no-op, so this is invisible in prod today; this test pins
// the WIRING so a future refactor can't silently drop SMS notifications when
// EMAIL_ONLY is flipped off at go-live.
//
// Drives the REAL applyAvailabilityDecision + real reply(); only the transport
// (sendSms/sendEmail), DB, env, and Anthropic are mocked. change_request_id is
// omitted so the guarded ledger-flip is skipped and we isolate the notify path.

const h = vi.hoisted(() => {
  function makeBuilder() {
    const builder: Record<string, unknown> = {
      delete() { return builder; },
      insert() { return builder; },
      update() { return builder; },
      select() { return builder; },
      eq() { return builder; },
      in() { return builder; },
      is() { return builder; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      single() { return Promise.resolve({ data: null, error: null }); },
      then(onF: (v: { data: null; error: null }) => unknown, onR?: (e: unknown) => unknown) {
        return Promise.resolve({ data: null, error: null }).then(onF, onR);
      },
    };
    return builder;
  }
  // sendSms returns truthy so reply() treats the text as sent (no email fallback).
  const sendSmsMock = vi.fn(async () => true);
  const sendEmailMock = vi.fn(async () => {});
  return { makeBuilder, sendSmsMock, sendEmailMock };
});

vi.mock('@anthropic-ai/sdk', () => ({ default: class MockAnthropic { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({
  env: {
    ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k',
    SENDGRID_FROM_EMAIL: 'aegis@test.local', SENDGRID_FROM_NAME: 'Aegis', BASE_URL: 'http://localhost:3000', NODE_ENV: 'test',
  },
}));
vi.mock('../../db/client', () => ({ supabase: { from: () => h.makeBuilder() } }));
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

beforeEach(() => { h.sendSmsMock.mockClear(); h.sendEmailMock.mockClear(); });

describe('availability decision notification — channel routing (SMS go-live guard)', () => {
  it('APPROVE on an SMS-channel change texts the employee (sendSms, not sendEmail)', async () => {
    await applyAvailabilityDecision(input('sms', '+16163280114'));
    expect(h.sendSmsMock).toHaveBeenCalledTimes(1);
    expect(h.sendSmsMock.mock.calls[0][0]).toMatchObject({ to: '+16163280114' });
    expect(h.sendEmailMock).not.toHaveBeenCalled();
  });

  it('DENY on an SMS-channel change also texts the employee', async () => {
    await applyAvailabilityDecision(input('sms', '+16163280114', 'denied'));
    expect(h.sendSmsMock).toHaveBeenCalledTimes(1);
    expect(h.sendSmsMock.mock.calls[0][0]).toMatchObject({ to: '+16163280114' });
    expect(h.sendEmailMock).not.toHaveBeenCalled();
  });

  it('APPROVE on an email-channel change emails the employee (sendEmail, not sendSms)', async () => {
    await applyAvailabilityDecision(input('email', 'sam@example.com'));
    expect(h.sendEmailMock).toHaveBeenCalledTimes(1);
    expect(h.sendEmailMock.mock.calls[0][0]).toMatchObject({ to: 'sam@example.com' });
    expect(h.sendSmsMock).not.toHaveBeenCalled();
  });
});
