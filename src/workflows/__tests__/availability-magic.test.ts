import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Integration test: availability magic-button workflow ──────────────────────
//
// Supabase + SendGrid + the inbound/outbound messaging layer are FULLY MOCKED —
// nothing touches a real DB and no email is sent. We assert the LOGIC the
// deployed feature will run:
//   • buildAvailabilityManagerEmail renders an Approve AND a Deny button, each a
//     well-formed /api/aegis-action magic-link carrying a distinct token.
//   • applyAvailabilityDecision APPROVE → availability delete+insert (expected
//     shape) + employee approve-notify; DENY → no availability write + deny-notify.
//   • The employee decision notice carries NO Homebase link (BUG-4).
//
// Shared mock state goes through vi.hoisted so the (hoisted) vi.mock factories
// can reference it safely.

const h = vi.hoisted(() => {
  type Recorded = { table: string; op: string; rows?: unknown; filters: Record<string, unknown> };
  const recorded: Recorded[] = [];

  // Chainable + awaitable Supabase query-builder stand-in. Every awaited
  // terminal (.insert(...), delete().eq(...), .maybeSingle()) records the op so
  // tests can assert what would have hit the DB. Resolves { data, error:null }.
  function makeBuilder(table: string) {
    const state: { op: string; rows?: unknown; filters: Record<string, unknown> } = { op: 'select', filters: {} };
    const builder: Record<string, unknown> = {
      delete() { state.op = 'delete'; return builder; },
      insert(rows: unknown) { state.op = 'insert'; state.rows = rows; return builder; },
      update(rows: unknown) { state.op = 'update'; state.rows = rows; return builder; },
      select() { return builder; },
      eq(col: string, val: unknown) { state.filters[col] = val; return builder; },
      in() { return builder; },
      is() { return builder; },
      maybeSingle() { recorded.push({ table, op: state.op, filters: state.filters }); return Promise.resolve({ data: null, error: null }); },
      single() { recorded.push({ table, op: state.op, filters: state.filters }); return Promise.resolve({ data: null, error: null }); },
      then(onF: (v: { data: null; error: null }) => unknown, onR?: (e: unknown) => unknown) {
        recorded.push({ table, op: state.op, rows: state.rows, filters: state.filters });
        return Promise.resolve({ data: null, error: null }).then(onF, onR);
      },
    };
    return builder;
  }

  const replyMock = vi.fn(async () => {});
  const sendEmailMock = vi.fn(async () => {});
  return { recorded, makeBuilder, replyMock, sendEmailMock };
});

vi.mock('@anthropic-ai/sdk', () => ({
  // employee-onboarding instantiates `new Anthropic(...)` at module load.
  default: class MockAnthropic { messages = { create: vi.fn() }; },
}));
vi.mock('../../config/env', () => ({
  env: {
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    SUPABASE_URL: 'http://localhost',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
    SENDGRID_FROM_EMAIL: 'aegis@test.local',
    SENDGRID_FROM_NAME: 'Aegis',
    BASE_URL: 'http://localhost:3000',
    NODE_ENV: 'test',
  },
}));
vi.mock('../../db/client', () => ({ supabase: { from: (t: string) => h.makeBuilder(t) } }));
vi.mock('../../messaging/email', () => ({ sendEmail: h.sendEmailMock }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn(async () => {}) }));
vi.mock('../../messaging/reply', () => ({ reply: h.replyMock, sendInThreadAck: vi.fn(async () => {}) }));
vi.mock('../../ai/claude', () => ({ withAnthropicRetry: vi.fn() }));

import {
  buildAvailabilityManagerEmail,
  applyAvailabilityDecision,
  type AvailabilitySlot,
} from '../employee-onboarding';

// Sandbox-shaped fixtures (Shmubba Sploosh / Sandbox Manager).
const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const EMPLOYEE_ID = 'e1684385-ab46-472d-82b8-9009cd705bde';
const CURRENT: AvailabilitySlot[] = [{ day_of_week: 1, start_time: '10:00', end_time: '15:00' }];
const PROPOSED: AvailabilitySlot[] = [
  { day_of_week: 1, start_time: '09:00', end_time: '17:00' },
  { day_of_week: 3, start_time: '09:00', end_time: '13:00' },
];

function decisionInput(decision: 'approved' | 'denied') {
  return {
    decision,
    company_id: COMPANY_ID,
    employee_id: EMPLOYEE_ID,
    employee_name: 'Shmubba Sploosh',
    current_availability: CURRENT,
    proposed_availability: PROPOSED,
    availability_raw: 'Mondays 9 to 5 and Wednesday mornings',
    decided_by: 'Sandbox Manager',
    employee_sender: 'aegisscheduler@gmail.com',
    employee_recipient: 'sandbox@aegis.quriasolutions.com',
    employee_channel: 'email' as const,
    thread_id: null,
    raw_subject: null,
  };
}

beforeEach(() => {
  h.recorded.length = 0;
  h.replyMock.mockClear();
  h.sendEmailMock.mockClear();
});

describe('buildAvailabilityManagerEmail', () => {
  it('renders Approve + Deny buttons, each a valid magic-link with a distinct token', async () => {
    const tokenPayload = {
      employee_id: EMPLOYEE_ID,
      employee_name: 'Shmubba Sploosh',
      company_id: COMPANY_ID,
      current_availability: CURRENT,
      proposed_availability: PROPOSED,
      availability_raw: 'Mondays 9 to 5 and Wednesday mornings',
      employee_sender: 'aegisscheduler@gmail.com',
      employee_recipient: 'sandbox@aegis.quriasolutions.com',
      employee_channel: 'email',
      thread_id: null,
      raw_subject: null,
    };

    const { subject, text, html } = await buildAvailabilityManagerEmail({
      company_id: COMPANY_ID,
      manager_email: 'sandbox-manager@quriasolutions.com',
      manager_user_id: 'manager-user-1',
      manager_name: 'Sandbox Manager',
      employee_name: 'Shmubba Sploosh',
      current_availability: CURRENT,
      proposed_availability: PROPOSED,
      token_payload: tokenPayload,
    });

    expect(subject).toContain('Shmubba Sploosh');
    // Both buttons present (label text inside the anchors).
    expect(html).toContain('>Approve</a>');
    expect(html).toContain('>Deny</a>');

    // Two well-formed magic-link URLs → HOMEBASE_URL/api/aegis-action?token=...
    const urls = [...html.matchAll(/href="(https:\/\/homebase\.test\.local\/api\/aegis-action\?token=[^"]+)"/g)].map(m => m[1]);
    expect(urls.length).toBe(2);
    const tokens = urls.map(u => new URL(u).searchParams.get('token'));
    expect(tokens[0]).toBeTruthy();
    expect(tokens[1]).toBeTruthy();
    expect(tokens[0]).not.toBe(tokens[1]); // approve token ≠ deny token

    // Two tokens were minted, one approve_availability + one deny_availability,
    // each carrying the approval-snapshot payload.
    const tokenInserts = h.recorded.filter(r => r.table === 'aegis_action_tokens' && r.op === 'insert');
    expect(tokenInserts.length).toBe(2);
    const actionTypes = tokenInserts
      .map(r => (r.rows as { action_type: string }).action_type)
      .sort();
    expect(actionTypes).toEqual(['approve_availability', 'deny_availability']);
    for (const ins of tokenInserts) {
      expect((ins.rows as { payload: { employee_id: string } }).payload.employee_id).toBe(EMPLOYEE_ID);
    }

    // Requirement 4: the reply-YES/NO fallback instruction is present alongside
    // the buttons (text + HTML), so a manager is never stranded.
    expect(text).toMatch(/reply YES/i);
    expect(html).toMatch(/reply <strong>YES<\/strong>/i);
  });
});

describe('applyAvailabilityDecision', () => {
  it('APPROVE replaces the employee availability and approve-notifies (no Homebase link)', async () => {
    await applyAvailabilityDecision(decisionInput('approved'));

    const availOps = h.recorded.filter(r => r.table === 'availability');
    // delete scoped to the employee, then insert the proposed set.
    expect(availOps.some(r => r.op === 'delete' && r.filters.employee_id === EMPLOYEE_ID)).toBe(true);
    const insert = availOps.find(r => r.op === 'insert');
    expect(insert).toBeDefined();
    expect(insert!.rows).toEqual([
      { company_id: COMPANY_ID, employee_id: EMPLOYEE_ID, day_of_week: 1, start_time: '09:00', end_time: '17:00' },
      { company_id: COMPANY_ID, employee_id: EMPLOYEE_ID, day_of_week: 3, start_time: '09:00', end_time: '13:00' },
    ]);

    // Activity logged as an update.
    expect(h.recorded.some(r => r.table === 'activity_log' && r.op === 'insert' && (r.rows as { action: string }).action === 'availability_updated')).toBe(true);

    // Employee notified, approve wording, NO Homebase link (BUG-4).
    expect(h.replyMock).toHaveBeenCalledTimes(1);
    const body = h.replyMock.mock.calls[0][2] as string;
    expect(body).toMatch(/approved/i);
    expect(body).not.toMatch(/homebase/i);
    expect(body).not.toMatch(/https?:\/\//);
  });

  it('DENY writes no availability, logs the denial, and deny-notifies (no Homebase link)', async () => {
    await applyAvailabilityDecision(decisionInput('denied'));

    // No availability table writes on deny.
    expect(h.recorded.some(r => r.table === 'availability')).toBe(false);

    expect(h.recorded.some(r => r.table === 'activity_log' && r.op === 'insert' && (r.rows as { action: string }).action === 'availability_update_denied')).toBe(true);

    expect(h.replyMock).toHaveBeenCalledTimes(1);
    const body = h.replyMock.mock.calls[0][2] as string;
    expect(body).toMatch(/wasn'?t approved|not approved/i);
    expect(body).not.toMatch(/homebase/i);
    expect(body).not.toMatch(/https?:\/\//);
  });
});
