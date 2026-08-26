import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Feature B: departure Acknowledge / Follow-up magic-link core logic ─────────
// Consuming the one-time token, the acknowledge branch writes last_day + notifies
// the employee; the follow-up branch writes nothing + notifies. Supabase, the
// branded page, the notifier, and formatDateRange are mocked.

const h = vi.hoisted(() => {
  type Recorded = { table: string; op: string; rows?: unknown; filters: Record<string, unknown> };
  const recorded: Recorded[] = [];
  const config: Record<string, unknown> = {};
  function makeBuilder(table: string) {
    const state: { op: string; rows?: unknown; filters: Record<string, unknown> } = { op: 'select', filters: {} };
    const term = () => {
      recorded.push({ table, op: state.op, rows: state.rows, filters: state.filters });
      return Promise.resolve({ data: config[`${table}:${state.op}`] ?? null, error: null });
    };
    const builder: Record<string, unknown> = {
      delete() { state.op = 'delete'; return builder; },
      insert(rows: unknown) { state.op = 'insert'; state.rows = rows; return builder; },
      update(rows: unknown) { state.op = 'update'; state.rows = rows; return builder; },
      select() { return builder; },
      eq() { return builder; },
      maybeSingle() { return term(); },
      then(onF: (v: { data: unknown; error: null }) => unknown, onR?: (e: unknown) => unknown) { return term().then(onF, onR); },
    };
    return builder;
  }
  const logActivity = vi.fn(async () => {});
  const notifyEmployeeSmsFirst = vi.fn(async () => 'sms' as const);
  const getAegisSmsChannel = vi.fn(async () => '+16166164898');
  return { recorded, config, makeBuilder, logActivity, notifyEmployeeSmsFirst, getAegisSmsChannel };
});

vi.mock('../../config/env', () => ({ env: { NODE_ENV: 'test', EMAIL_ONLY: false } }));
vi.mock('../../db/client', () => ({ supabase: { from: (t: string) => h.makeBuilder(t) } }));
vi.mock('../../logger/activity-log', () => ({ logActivity: h.logActivity }));
vi.mock('../../messaging/notify', () => ({ getAegisSmsChannel: h.getAegisSmsChannel, notifyEmployeeSmsFirst: h.notifyEmployeeSmsFirst }));
vi.mock('../../workflows/time-off', () => ({ formatDateRange: (a: string) => a }));
vi.mock('../decision', () => ({ brandedPage: (o: { heading: string; body: string }) => `<html>${o.heading}|${o.body}</html>` }));

import { processDepartureDecision } from '../departure-decision';

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const EMPLOYEE_ID = 'e1684385-ab46-472d-82b8-9009cd705bde';
const FUTURE = new Date(Date.now() + 7 * 86400000).toISOString();

function tokenRow(over: Record<string, unknown> = {}) {
  return {
    id: 'mem-1',
    content: JSON.stringify({
      departure_id: 'dep-1',
      company_id: COMPANY_ID,
      employee_id: EMPLOYEE_ID,
      employee_name: 'Sam Rivera',
      employee_contact: '+16163280114',
      employee_channel: 'sms',
      employee_recipient: '+16166164898',
      last_day_date: '2026-08-30',
      note: null,
      manager_name: 'Jack',
      manager_user_id: 'mgr-1',
      thread_id: null,
      raw_subject: null,
      expires_at: FUTURE,
      ...over,
    }),
  };
}

beforeEach(() => {
  h.recorded.length = 0;
  for (const k of Object.keys(h.config)) delete h.config[k];
  // S-3 (actor half): the minting manager is looked up at click time. Default
  // to a live login so the existing branches still run.
  h.config['users:select'] = { id: 'mgr-1', access_revoked_at: null };
  h.logActivity.mockClear();
  h.notifyEmployeeSmsFirst.mockClear();
  h.config['employees:select'] = { contact_phone: '+16163280114', contact_email: 'sam@wm.com' };
});

describe('processDepartureDecision — validation', () => {
  it('rejects a missing action/token', async () => {
    expect((await processDepartureDecision({})).status).toBe(400);
    expect((await processDepartureDecision({ action: 'acknowledge', departureId: 'dep-1' })).status).toBe(400);
  });
  it('rejects an unknown action', async () => {
    expect((await processDepartureDecision({ action: 'approve', departureId: 'dep-1', token: 't' })).status).toBe(400);
  });
  it('404s a used/unknown token', async () => {
    // aegis_memory:select stays null
    const r = await processDepartureDecision({ action: 'acknowledge', departureId: 'dep-1', token: 't' });
    expect(r.status).toBe(404);
  });
  it('rejects a departureId that does not match the token', async () => {
    h.config['aegis_memory:select'] = tokenRow();
    const r = await processDepartureDecision({ action: 'acknowledge', departureId: 'WRONG', token: 't' });
    expect(r.status).toBe(400);
  });
  it('410s an expired token', async () => {
    h.config['aegis_memory:select'] = tokenRow({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const r = await processDepartureDecision({ action: 'acknowledge', departureId: 'dep-1', token: 't' });
    expect(r.status).toBe(410);
  });
});

describe('processDepartureDecision — acknowledge', () => {
  it('writes last_day, logs departure_acknowledged, texts the employee, and consumes the token', async () => {
    h.config['aegis_memory:select'] = tokenRow();
    const r = await processDepartureDecision({ action: 'acknowledge', departureId: 'dep-1', token: 't' });

    expect(r.status).toBe(200);
    // last_day written to employees
    const upd = h.recorded.find(x => x.table === 'employees' && x.op === 'update');
    expect(upd).toBeDefined();
    expect((upd!.rows as { last_day: string }).last_day).toBe('2026-08-30');
    // logged as an acknowledgment
    expect(h.logActivity).toHaveBeenCalledTimes(1);
    expect(h.logActivity.mock.calls[0][0].action).toBe('departure_acknowledged');
    // employee texted
    expect(h.notifyEmployeeSmsFirst).toHaveBeenCalledTimes(1);
    expect(h.notifyEmployeeSmsFirst.mock.calls[0][0].body).toMatch(/recorded|last day/i);
    // token consumed
    expect(h.recorded.some(x => x.table === 'aegis_memory' && x.op === 'delete')).toBe(true);
  });

  it('with no date given: writes nothing to employees but still acknowledges + texts', async () => {
    h.config['aegis_memory:select'] = tokenRow({ last_day_date: null });
    const r = await processDepartureDecision({ action: 'acknowledge', departureId: 'dep-1', token: 't' });

    expect(r.status).toBe(200);
    expect(h.recorded.some(x => x.table === 'employees' && x.op === 'update')).toBe(false);
    expect(h.logActivity.mock.calls[0][0].action).toBe('departure_acknowledged');
    expect(h.notifyEmployeeSmsFirst).toHaveBeenCalledTimes(1);
  });
});

describe('processDepartureDecision — revoked manager (S-3 actor half)', () => {
  it('refuses the link when the minting manager has been revoked, and writes nothing', async () => {
    h.config['aegis_memory:select'] = tokenRow();
    h.config['users:select'] = { id: 'mgr-1', access_revoked_at: '2026-06-18T00:00:00Z' };
    const r = await processDepartureDecision({ action: 'acknowledge', departureId: 'dep-1', token: 't' });
    expect(r.status).toBe(403);
    expect(h.recorded.filter((x) => x.table === 'employees' && x.op === 'update')).toHaveLength(0);
    expect(h.notifyEmployeeSmsFirst).not.toHaveBeenCalled();
  });
  it('refuses when the manager login no longer exists (fail closed)', async () => {
    h.config['aegis_memory:select'] = tokenRow();
    h.config['users:select'] = null;
    const r = await processDepartureDecision({ action: 'followup', departureId: 'dep-1', token: 't' });
    expect(r.status).toBe(403);
  });
});

describe('processDepartureDecision — followup', () => {
  it('writes NOTHING to employees, logs followup, texts the employee, consumes the token', async () => {
    h.config['aegis_memory:select'] = tokenRow();
    const r = await processDepartureDecision({ action: 'followup', departureId: 'dep-1', token: 't' });

    expect(r.status).toBe(200);
    expect(h.recorded.some(x => x.table === 'employees' && x.op === 'update')).toBe(false);
    expect(h.logActivity.mock.calls[0][0].action).toBe('departure_followup_requested');
    expect(h.notifyEmployeeSmsFirst).toHaveBeenCalledTimes(1);
    expect(h.notifyEmployeeSmsFirst.mock.calls[0][0].body).toMatch(/reach out/i);
    expect(h.recorded.some(x => x.table === 'aegis_memory' && x.op === 'delete')).toBe(true);
  });
});
