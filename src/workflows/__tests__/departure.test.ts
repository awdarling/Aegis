import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Feature B: departure signal → manager alert + daily offboarding sweep ──────
//
// Supabase + messaging FULLY MOCKED. Covers:
//   • applyDepartureBackstop / looksLikeDeparture — clear leaving phrases upgrade
//     from the general buckets to report_departure; non-departures don't.
//   • handleReportDeparture — alerts the manager (email guaranteed + additive SMS),
//     writes NOTHING to employees, logs departure_signal_flagged.
//   • runDailySweep — deactivates only employees whose last_day is strictly past.

const h = vi.hoisted(() => {
  type Recorded = { table: string; op: string; rows?: unknown; filters: Record<string, unknown> };
  const recorded: Recorded[] = [];
  // key `${table}:${op}` → data returned at the terminal (object or array).
  const config: Record<string, unknown> = {};
  function makeBuilder(table: string) {
    const state: { op: string; rows?: unknown; filters: Record<string, unknown> } = { op: 'select', filters: {} };
    const term = () => {
      recorded.push({ table, op: state.op, rows: state.rows, filters: state.filters });
      const data = config[`${table}:${state.op}`] ?? null;
      return Promise.resolve({ data, error: null });
    };
    const builder: Record<string, unknown> = {
      delete() { state.op = 'delete'; return builder; },
      insert(rows: unknown) { state.op = 'insert'; state.rows = rows; return builder; },
      update(rows: unknown) { state.op = 'update'; state.rows = rows; return builder; },
      select() { return builder; },
      eq(col: string, val: unknown) { state.filters[col] = val; return builder; },
      in() { return builder; },
      is() { return builder; },
      not(col: string, _op: string, val: unknown) { state.filters[`not:${col}`] = val; return builder; },
      lt(col: string, val: unknown) { state.filters[`lt:${col}`] = val; return builder; },
      gte() { return builder; },
      or(expr: string) { state.filters['or'] = expr; return builder; },
      order() { return builder; },
      limit() { return builder; },
      maybeSingle() { return term(); },
      single() { return term(); },
      then(onF: (v: { data: unknown; error: null }) => unknown, onR?: (e: unknown) => unknown) {
        return term().then(onF, onR);
      },
    };
    return builder;
  }
  const replyMock = vi.fn(async () => {});
  const sendEmailMock = vi.fn(async () => true);
  const sendSmsMock = vi.fn(async () => true);
  return { recorded, config, makeBuilder, replyMock, sendEmailMock, sendSmsMock };
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
vi.mock('../../messaging/sms', () => ({ sendSms: h.sendSmsMock }));
vi.mock('../../messaging/reply', () => ({ reply: h.replyMock, sendInThreadAck: vi.fn(async () => {}) }));

import { looksLikeDeparture, applyDepartureBackstop, type ClassifyResult } from '../../ai/claude';
import { handleReportDeparture } from '../departure';
import { runDailySweep } from '../../scheduler/employee-offboarding';
import type { InboundMessage, VerifiedContact } from '../../security/types';

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const EMPLOYEE_ID = 'e1684385-ab46-472d-82b8-9009cd705bde';

beforeEach(() => {
  h.recorded.length = 0;
  for (const k of Object.keys(h.config)) delete h.config[k];
  h.replyMock.mockClear();
  h.sendEmailMock.mockClear();
  h.sendSmsMock.mockClear();
});

describe('looksLikeDeparture / applyDepartureBackstop', () => {
  const general = (): ClassifyResult => ({ intent: 'general_question', confidence: 'low', extracted: {} });

  it('recognizes clear departure phrases', () => {
    for (const s of [
      'my last day is August 30',
      'putting in my two weeks',
      "consider this my two weeks' notice",
      'I quit',
      "I'm resigning",
      "I won't be coming back after Friday",
    ]) {
      expect(looksLikeDeparture(s)).toBe(true);
    }
  });

  it('does NOT fire on non-departures or retractions', () => {
    for (const s of [
      'can I get next Friday off',
      'what are my shifts this week',
      "never mind, I'm not quitting",
      'my last shift this week is Friday right?',
    ]) {
      expect(looksLikeDeparture(s)).toBe(false);
    }
  });

  it('upgrades general_question → report_departure but never overrides a specific intent', () => {
    expect(applyDepartureBackstop(general(), 'putting in my two weeks').intent).toBe('report_departure');
    const submit: ClassifyResult = { intent: 'submit_time_off', confidence: 'high', extracted: { dates: [] } };
    expect(applyDepartureBackstop(submit, 'my last day is Aug 30').intent).toBe('submit_time_off');
  });
});

describe('handleReportDeparture', () => {
  const contact: VerifiedContact = {
    role: 'employee', company_id: COMPANY_ID, employee_id: EMPLOYEE_ID, user_id: null,
    name: 'Sam Rivera', matched_identifier: '+16163280114', channel: 'sms',
  };
  const message: InboundMessage = { sender: '+16163280114', recipient: '+16166164898', body: 'my last day is Aug 30', channel: 'sms' };

  it('alerts the manager (email + additive SMS), writes NOTHING to employees, logs the signal', async () => {
    h.config['users:select'] = { id: 'mgr-1', email: 'manager@wm.com', name: 'Jack', role: 'manager' };
    h.config['employees:select'] = { contact_phone: '+16165551234' };       // manager's personal phone
    h.config['company_channels:select'] = { channel_value: '+16166164898' }; // Aegis outbound

    await handleReportDeparture(message, contact, { last_day_date: '2026-08-30', note: null });

    // Manager email is the guaranteed channel.
    expect(h.sendEmailMock).toHaveBeenCalledTimes(1);
    expect(h.sendEmailMock.mock.calls[0][0].to).toBe('manager@wm.com');
    // The email carries BOTH one-tap buttons (Acknowledge / Follow-up) with magic links.
    const emailHtml = h.sendEmailMock.mock.calls[0][0].html as string;
    expect(emailHtml).toContain('>Acknowledge</a>');
    expect(emailHtml).toContain("I'll follow up personally</a>");
    expect(emailHtml).toContain('/webhooks/departure?action=acknowledge');
    expect(emailHtml).toContain('/webhooks/departure?action=followup');
    // A one-time departure token was minted in aegis_memory.
    expect(h.recorded.some(r => r.table === 'aegis_memory' && r.op === 'insert'
      && typeof (r.rows as { source?: string }).source === 'string'
      && (r.rows as { source: string }).source.startsWith('departure_token:'))).toBe(true);
    // Additive SMS to the manager's PERSONAL phone (not the Aegis number).
    expect(h.sendSmsMock).toHaveBeenCalledTimes(1);
    expect(h.sendSmsMock.mock.calls[0][0].to).toBe('+16165551234');
    expect(h.sendSmsMock.mock.calls[0][0].from).toBe('+16166164898');

    // NOTHING written to employees.
    expect(h.recorded.some(r => r.table === 'employees' && (r.op === 'insert' || r.op === 'update'))).toBe(false);
    // The signal is logged.
    expect(h.recorded.some(r => r.table === 'activity_log' && r.op === 'insert'
      && (r.rows as { action: string }).action === 'departure_signal_flagged')).toBe(true);
    // Employee acknowledged.
    expect(h.replyMock).toHaveBeenCalledTimes(1);
    expect(h.replyMock.mock.calls[0][2]).toMatch(/thanks/i);
  });

  it('still acks + logs when no manager is found (no employee write)', async () => {
    // users:select stays null → no manager.
    await handleReportDeparture(message, contact, { last_day_date: null, note: null });

    expect(h.sendEmailMock).not.toHaveBeenCalled();
    expect(h.recorded.some(r => r.table === 'employees' && (r.op === 'insert' || r.op === 'update'))).toBe(false);
    expect(h.recorded.some(r => r.table === 'activity_log' && r.op === 'insert'
      && (r.rows as { action: string }).action === 'departure_signal_flagged')).toBe(true);
    expect(h.replyMock).toHaveBeenCalledTimes(1);
  });
});

describe('runDailySweep (offboarding)', () => {
  it('deactivates each returned employee and logs employee_deactivated', async () => {
    h.config['employees:select'] = [
      { id: 'a', company_id: COMPANY_ID, name: 'Gone Gary', last_day: '2026-08-01' },
      { id: 'b', company_id: COMPANY_ID, name: 'Left Lucy', last_day: '2026-08-05' },
    ];

    const flipped = await runDailySweep();
    expect(flipped).toBe(2);

    // One active→false update per employee, guarded on active:true.
    const updates = h.recorded.filter(r => r.table === 'employees' && r.op === 'update');
    expect(updates.length).toBe(2);
    expect(updates.every(u => (u.rows as { active: boolean }).active === false)).toBe(true);
    expect(updates.every(u => u.filters.active === true)).toBe(true);
    // Each deactivation is logged with the offboarding reason.
    const logs = h.recorded.filter(r => r.table === 'activity_log' && r.op === 'insert'
      && (r.rows as { action: string }).action === 'employee_deactivated');
    expect(logs.length).toBe(2);

    // The load query filters active + past last_day (whole-day gate).
    const load = h.recorded.find(r => r.table === 'employees' && r.op === 'select');
    expect(load!.filters.active).toBe(true);
    expect(typeof load!.filters['lt:last_day']).toBe('string');
  });

  it('flips nothing when no departed employees are due', async () => {
    h.config['employees:select'] = [];
    const flipped = await runDailySweep();
    expect(flipped).toBe(0);
    expect(h.recorded.some(r => r.table === 'employees' && r.op === 'update')).toBe(false);
  });
});
