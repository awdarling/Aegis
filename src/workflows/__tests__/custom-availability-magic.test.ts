import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Integration test: date-limited CUSTOM availability magic-button workflow ───
//
// Supabase + SendGrid + messaging are FULLY MOCKED — no real DB, no real sends.
// Asserts the logic the deployed feature runs:
//   • buildAvailabilityManagerEmail with a custom_end_date mints
//     approve_custom_availability / deny_custom_availability tokens and says
//     "through <date>".
//   • applyCustomAvailabilityDecision APPROVE → deactivates existing overrides +
//     inserts a date_limited custom_availability row (correct shape) + sets the
//     custom_availability_set activity + notifies the employee.
//   • DENY → no custom_availability write + custom_availability_denied + notify.
//   • Employee notices carry NO Homebase link (BUG-4).

const h = vi.hoisted(() => {
  type Recorded = { table: string; op: string; rows?: unknown; filters: Record<string, unknown> };
  const recorded: Recorded[] = [];
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

vi.mock('@anthropic-ai/sdk', () => ({ default: class MockAnthropic { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({
  env: {
    ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k',
    SENDGRID_FROM_EMAIL: 'aegis@test.local', SENDGRID_FROM_NAME: 'Aegis', BASE_URL: 'http://localhost:3000', NODE_ENV: 'test',
  },
}));
vi.mock('../../db/client', () => ({ supabase: { from: (t: string) => h.makeBuilder(t) } }));
vi.mock('../../messaging/email', () => ({ sendEmail: h.sendEmailMock }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn(async () => {}) }));
vi.mock('../../messaging/reply', () => ({ reply: h.replyMock, sendInThreadAck: vi.fn(async () => {}) }));
vi.mock('../../ai/claude', () => ({ withAnthropicRetry: vi.fn() }));

import {
  buildAvailabilityManagerEmail,
  applyCustomAvailabilityDecision,
  isRotatingAvailabilityRequest,
  startOfWeekSunday,
  type AvailabilitySlot,
  type RotationSpec,
} from '../employee-onboarding';

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const EMPLOYEE_ID = 'e1684385-ab46-472d-82b8-9009cd705bde';
const END_DATE = '2026-09-01'; // a Tuesday → formatDateRange yields "Tuesday, September 1"
// "No mornings until Sept 1" → available afternoons only on the working days.
const PROPOSED: AvailabilitySlot[] = [
  { day_of_week: 1, start_time: '13:00', end_time: '21:00' },
  { day_of_week: 3, start_time: '13:00', end_time: '21:00' },
];
const CURRENT: AvailabilitySlot[] = [{ day_of_week: 1, start_time: '09:00', end_time: '21:00' }];

function customInput(decision: 'approved' | 'denied') {
  return {
    decision,
    company_id: COMPANY_ID,
    employee_id: EMPLOYEE_ID,
    employee_name: 'Shmubba Sploosh',
    proposed_availability: PROPOSED,
    custom_end_date: END_DATE,
    current_availability: CURRENT,
    availability_raw: 'no mornings until september 1',
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
});

describe('buildAvailabilityManagerEmail (custom / date-limited)', () => {
  it('mints custom-availability tokens and says "through <date>"', async () => {
    const { subject, text, html } = await buildAvailabilityManagerEmail({
      company_id: COMPANY_ID,
      manager_email: 'sandbox-manager@quriasolutions.com',
      manager_user_id: 'manager-user-1',
      manager_name: 'Sandbox Manager',
      employee_name: 'Shmubba Sploosh',
      current_availability: CURRENT,
      proposed_availability: PROPOSED,
      custom_end_date: END_DATE,
      token_payload: { employee_id: EMPLOYEE_ID, custom_end_date: END_DATE, proposed_availability: PROPOSED },
    });

    // Tokens are the CUSTOM action types (not the permanent-availability ones).
    const tokenInserts = h.recorded.filter(r => r.table === 'aegis_action_tokens' && r.op === 'insert');
    const actionTypes = tokenInserts.map(r => (r.rows as { action_type: string }).action_type).sort();
    expect(actionTypes).toEqual(['approve_custom_availability', 'deny_custom_availability']);

    // Both buttons + a temporary framing through the end date.
    expect(html).toContain('>Approve</a>');
    expect(html).toContain('>Deny</a>');
    expect(subject).toContain('Temporary availability');
    expect(subject).toContain('September 1');
    expect(text).toMatch(/through .*September 1/);
    expect(html).toMatch(/through .*September 1/);
  });
});

describe('applyCustomAvailabilityDecision', () => {
  it('APPROVE deactivates existing overrides and inserts a date_limited override + notifies (no Homebase link)', async () => {
    await applyCustomAvailabilityDecision(customInput('approved'));

    const caOps = h.recorded.filter(r => r.table === 'custom_availability');
    // Deactivate existing active override for this employee.
    expect(caOps.some(r => r.op === 'update'
      && (r.rows as { active: boolean }).active === false
      && r.filters.employee_id === EMPLOYEE_ID)).toBe(true);
    // Insert the new date-limited override with the expected shape.
    const insert = caOps.find(r => r.op === 'insert');
    expect(insert).toBeDefined();
    const row = insert!.rows as Record<string, unknown>;
    expect(row.type).toBe('date_limited');
    expect(row.end_date).toBe(END_DATE);
    expect(row.active).toBe(true);
    expect(row.cycle_weeks).toBeNull();
    expect(row.patterns).toEqual([
      { day_of_week: 1, start_time: '13:00', end_time: '21:00' },
      { day_of_week: 3, start_time: '13:00', end_time: '21:00' },
    ]);
    // It does NOT touch the permanent availability table.
    expect(h.recorded.some(r => r.table === 'availability')).toBe(false);

    expect(h.recorded.some(r => r.table === 'activity_log' && r.op === 'insert'
      && (r.rows as { action: string }).action === 'custom_availability_set')).toBe(true);

    expect(h.replyMock).toHaveBeenCalledTimes(1);
    const body = h.replyMock.mock.calls[0][2] as string;
    expect(body).toMatch(/approved/i);
    expect(body).toMatch(/through .*September 1/);
    expect(body).not.toMatch(/homebase/i);
    expect(body).not.toMatch(/https?:\/\//);
  });

  it('DENY writes no override, logs the denial, and notifies (no Homebase link)', async () => {
    await applyCustomAvailabilityDecision(customInput('denied'));

    expect(h.recorded.some(r => r.table === 'custom_availability')).toBe(false);
    expect(h.recorded.some(r => r.table === 'activity_log' && r.op === 'insert'
      && (r.rows as { action: string }).action === 'custom_availability_denied')).toBe(true);

    expect(h.replyMock).toHaveBeenCalledTimes(1);
    const body = h.replyMock.mock.calls[0][2] as string;
    expect(body).toMatch(/wasn't approved/i);
    expect(body).not.toMatch(/homebase/i);
    expect(body).not.toMatch(/https?:\/\//);
  });
});

// ── Rotating ("every other week") custom availability ─────────────────────────
const ROTATION: RotationSpec = {
  cycle_weeks: 2,
  cycle_start_date: '2026-06-07',
  weeks: [
    { week: 1, days: [{ day_of_week: 6, start_time: '09:00', end_time: '17:00' }] },
    { week: 2, days: [] },
  ],
  end_date: null,
};

describe('rotating availability — pure helpers', () => {
  it('detects rotating phrasings, not ordinary changes', () => {
    expect(isRotatingAvailabilityRequest('I can only work every other week')).toBe(true);
    expect(isRotatingAvailabilityRequest('week on week off')).toBe(true);
    expect(isRotatingAvailabilityRequest('alternating weekends')).toBe(true);
    expect(isRotatingAvailabilityRequest('I can work mornings on Mondays')).toBe(false);
    expect(isRotatingAvailabilityRequest("I can't work Wednesdays")).toBe(false);
  });

  it('anchors the cycle to the Sunday of the week', () => {
    // 2026-06-13 is a Saturday → the Sunday on/before is 2026-06-07.
    expect(startOfWeekSunday('2026-06-13')).toBe('2026-06-07');
    expect(startOfWeekSunday('2026-06-07')).toBe('2026-06-07');
  });
});

describe('buildAvailabilityManagerEmail (rotating)', () => {
  it('mints custom-availability tokens and renders the per-week grid', async () => {
    const { subject, text, html } = await buildAvailabilityManagerEmail({
      company_id: COMPANY_ID,
      manager_email: 'sandbox-manager@quriasolutions.com',
      manager_user_id: 'manager-user-1',
      manager_name: 'Sandbox Manager',
      employee_name: 'Shmubba Sploosh',
      current_availability: [],
      proposed_availability: [],
      rotation: ROTATION,
      token_payload: { employee_id: EMPLOYEE_ID, rotation: ROTATION },
    });

    const actionTypes = h.recorded
      .filter(r => r.table === 'aegis_action_tokens' && r.op === 'insert')
      .map(r => (r.rows as { action_type: string }).action_type)
      .sort();
    expect(actionTypes).toEqual(['approve_custom_availability', 'deny_custom_availability']);

    expect(subject).toMatch(/rotating/i);
    expect(text).toMatch(/2-week cycle/);
    expect(html).toContain('>Approve</a>');
    expect(html).toContain('Week 1');
    expect(html).toContain('Week 2');
  });
});

describe('applyCustomAvailabilityDecision (rotating)', () => {
  const rotInput = (decision: 'approved' | 'denied') => ({
    decision,
    company_id: COMPANY_ID,
    employee_id: EMPLOYEE_ID,
    employee_name: 'Shmubba Sploosh',
    proposed_availability: ROTATION.weeks[0].days,
    custom_end_date: null,
    rotation: ROTATION,
    current_availability: [] as AvailabilitySlot[],
    availability_raw: 'i can only work saturdays every other week',
    decided_by: 'Sandbox Manager',
    employee_sender: 'aegisscheduler@gmail.com',
    employee_recipient: 'sandbox@aegis.quriasolutions.com',
    employee_channel: 'email' as const,
    thread_id: null,
    raw_subject: null,
  });

  it('APPROVE inserts a type=rotating override with the cycle + per-week patterns', async () => {
    await applyCustomAvailabilityDecision(rotInput('approved'));

    const insert = h.recorded.find(r => r.table === 'custom_availability' && r.op === 'insert');
    expect(insert).toBeDefined();
    const row = insert!.rows as Record<string, unknown>;
    expect(row.type).toBe('rotating');
    expect(row.cycle_weeks).toBe(2);
    expect(row.cycle_start_date).toBe('2026-06-07');
    expect(row.end_date).toBeNull();
    expect(row.patterns).toEqual([
      { week: 1, days: [{ day_of_week: 6, start_time: '09:00', end_time: '17:00' }] },
      { week: 2, days: [] },
    ]);
    // It must NOT replace the permanent availability table.
    expect(h.recorded.some(r => r.table === 'availability')).toBe(false);

    const body = h.replyMock.mock.calls[0][2] as string;
    expect(body).toMatch(/rotating/i);
    expect(body).not.toMatch(/homebase/i);
  });
});
