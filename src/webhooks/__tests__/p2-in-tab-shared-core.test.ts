import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// ── P2 (DRIFT §P2, 2026-08-30): the Homebase in-tab Time Off button now lands
// in the SAME shared core as the email link and the texted reply (F13) ───────
//
// Before this fix, `/api/time-off-decision` in Homebase called a second,
// separate decision function (`decideTimeOffRequest`) that had no idea a
// request was a call-out — an in-tab approval never marked the schedule,
// never started coverage, and never retired a manager's parked text-reply
// state. This exercises the REAL applyTimeOffDecision (via
// /internal/apply-time-off-decision with body.source = 'in_tab') against a
// stateful DB mock, the same harness shape as n3-apply-time-off-endpoint.

const h = vi.hoisted(() => {
  const state = {
    tor: null as { id: string; company_id: string; employee_id: string; status: string; start_date: string; end_date: string; reason: string | null } | null,
    users: [] as Array<{ id: string; name: string; avatar_url: string | null; access_revoked_at: string | null }>,
    employees: [] as Array<Record<string, unknown>>,
    memory: [] as Array<{ id: string; source: string; content: string }>,
    memoryDeletes: [] as Array<Record<string, unknown>>,
  };
  function makeBuilder(table: string) {
    const f: Record<string, unknown> = {};
    let op = 'select';
    let payload: Record<string, unknown> | undefined;
    const finish = () => {
      if (table === 'time_off_requests') {
        if (op === 'select') {
          const match = state.tor
            && (!f.id || state.tor.id === f.id)
            && (!f.company_id || state.tor.company_id === f.company_id)
            ? state.tor : null;
          return { data: match, error: null };
        }
        if (op === 'update') {
          if (state.tor && state.tor.id === f.id && (!f.status || state.tor.status === f.status)) {
            Object.assign(state.tor, payload);
          }
          return { data: null, error: null };
        }
      }
      if (table === 'employees' && op === 'select') {
        return { data: state.employees.find(e => e.id === f.id) ?? null, error: null };
      }
      if (table === 'users' && op === 'select') {
        return { data: state.users.find(u => u.id === f.id) ?? null, error: null };
      }
      if (table === 'company_channels' && op === 'select') {
        return { data: { channel_value: '+15559990000' }, error: null };
      }
      if (table === 'companies' && op === 'select') {
        return { data: { timezone: 'America/Detroit' }, error: null };
      }
      if (table === 'aegis_memory') {
        if (op === 'select' && typeof f.source === 'string') {
          const row = state.memory.find(r => r.source === f.source) ?? null;
          return { data: row, error: null };
        }
        if (op === 'select') {
          return { data: [], error: null };
        }
        if (op === 'delete') {
          state.memoryDeletes.push({ ...f });
          return { data: null, error: null };
        }
        if (op === 'insert') {
          return { data: null, error: null };
        }
      }
      return { data: null, error: null };
    };
    const b: Record<string, unknown> = {
      select() { return b; },
      insert(p: Record<string, unknown>) { op = 'insert'; payload = p; return b; },
      update(p: Record<string, unknown>) { op = 'update'; payload = p; return b; },
      delete() { op = 'delete'; return b; },
      eq(col: string, val: unknown) { f[col] = val; return b; },
      like(col: string, val: unknown) { f[`like:${col}`] = val; return b; },
      in(col: string, val: unknown) { f[`in:${col}`] = val; return b; },
      maybeSingle() { return Promise.resolve(finish()); },
      single() { return Promise.resolve(finish()); },
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) { return Promise.resolve(finish()).then(onF, onR); },
    };
    return b;
  }
  return {
    state, makeBuilder,
    sendSms: vi.fn(async () => true),
    sendEmail: vi.fn(async () => true),
    markCalledOut: vi.fn(async () => {}),
    startCoverage: vi.fn(async () => ({ outcome: 'started', shiftName: 'Afternoon', contacted: ['rosa'] })),
    findCoverageSession: vi.fn(async () => null),
    logActivity: vi.fn(async () => {}),
  };
});

vi.mock('../../config/env', () => ({
  env: {
    NODE_ENV: 'test', EMAIL_ONLY: false, BASE_URL: 'http://aegis.test',
    ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x',
    SENDGRID_API_KEY: 'x', SENDGRID_FROM_EMAIL: 'a@b.c', SENDGRID_FROM_NAME: 'Aegis',
  },
}));
vi.mock('../../db/client', () => ({ supabase: { from: (t: string) => h.makeBuilder(t) } }));
vi.mock('../../messaging/sms', () => ({ sendSms: h.sendSms, getTenantSmsNumber: vi.fn(async () => null) }));
vi.mock('../../messaging/email', () => ({ sendEmail: h.sendEmail }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(async () => {}), sendInThreadAck: vi.fn(async () => {}), normalizeReSubject: (s: string) => s }));
vi.mock('../../logger/activity-log', () => ({ logActivity: h.logActivity }));
vi.mock('../../messaging/manager-directory', () => ({
  resolveManagers: vi.fn(async () => ({ managers: [], unreachableBySms: [], smsChannel: '+15559990000' })),
  recipientsFor: (d: { managers: unknown[] }) => d.managers,
  primaryRecipient: () => null,
}));
vi.mock('../../workflows/emergency-coverage', () => ({
  processCoverageButtonDecision: vi.fn(),
  processCoverageBatchButton: vi.fn(),
  startCoverageForCallOut: h.startCoverage,
  markAssignmentsCalledOut: h.markCalledOut,
  findCoverageSessionForTimeOffRequest: h.findCoverageSession,
}));

import express from 'express';
import type { AddressInfo } from 'node:net';
import { internalRouter } from '../internal';

process.env.AEGIS_INTERNAL_SECRET = 'test-internal-secret';

const app = express();
app.use('/internal', internalRouter);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
afterAll(() => server.close());

async function post(body: Record<string, unknown>) {
  const res = await fetch(`http://127.0.0.1:${port}/internal/apply-time-off-decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-internal-secret' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) as Record<string, unknown> | null };
}

const IN_TAB_BODY = {
  time_off_request_id: 'req-1',
  action: 'approve',
  company_id: 'co-1',
  manager_user_id: 'mgr-1',
  source: 'in_tab',
};

beforeEach(() => {
  h.state.tor = { id: 'req-1', company_id: 'co-1', employee_id: 'emp-1', status: 'pending', start_date: '2026-09-02', end_date: '2026-09-02', reason: null };
  h.state.users = [{ id: 'mgr-1', name: 'Jack McCorkle', avatar_url: 'https://x.test/jack.png', access_revoked_at: null }];
  h.state.employees = [{ id: 'emp-1', name: 'Mia Shaffer', contact_phone: '+15550001111', contact_email: 'mia@x.test' }];
  h.state.memory = [];
  h.state.memoryDeletes = [];
  h.sendSms.mockClear();
  h.sendEmail.mockClear();
  h.markCalledOut.mockClear();
  h.startCoverage.mockClear();
  h.logActivity.mockClear();
});

describe('in-tab decisions land in the one shared core', () => {
  it('a plain time-off request behaves exactly as the email/text doors would', async () => {
    const r = await post(IN_TAB_BODY);
    expect(r.status).toBe(200);
    expect(r.json?.outcome).toBe('applied');
    expect(String(r.json?.message)).toMatch(/Mia.*approved and they've been told/);
    expect(h.state.tor!.status).toBe('approved');
    expect(h.markCalledOut).not.toHaveBeenCalled();
    // Activity attributes the Time Off tab as the door, and the manager's
    // avatar rides along even though the browser never sent one.
    expect(h.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      actor_name: 'Jack McCorkle',
      actor_avatar_url: 'https://x.test/jack.png',
      summary: expect.stringContaining('via the Time Off tab'),
    }));
  });

  it('resolves a CALL-OUT server-side from the to_thread row — the browser never has to know', async () => {
    h.state.memory.push({
      id: 'mem-1',
      source: 'to_thread:req-1',
      content: JSON.stringify({
        channel: 'sms',
        call_out: [{ date: '2026-09-02', shift_name: 'Afternoon', start_time: '15:00:00', end_time: '20:15:00' }],
      }),
    });
    // The in-tab caller sends NO call_out — exactly what the Homebase route
    // will send, since the tab has no business knowing the snapshot shape.
    const r = await post({ ...IN_TAB_BODY, action: 'approve_and_cover' });
    expect(r.json?.outcome).toBe('applied');
    expect(h.markCalledOut).toHaveBeenCalledTimes(1);
    expect(h.startCoverage).toHaveBeenCalledTimes(1);
    expect(String(r.json?.message)).toMatch(/texting 1 qualified teammate/);
  });

  it('a plain in-tab APPROVE of a call-out marks the schedule but does not start coverage ("Approve only")', async () => {
    h.state.memory.push({
      id: 'mem-1',
      source: 'to_thread:req-1',
      content: JSON.stringify({
        channel: 'email',
        call_out: [{ date: '2026-09-02', shift_name: 'Afternoon', start_time: '15:00:00', end_time: '20:15:00' }],
      }),
    });
    const r = await post({ ...IN_TAB_BODY, action: 'approve' });
    expect(r.json?.outcome).toBe('applied');
    expect(h.markCalledOut).toHaveBeenCalledTimes(1);
    expect(h.startCoverage).not.toHaveBeenCalled();
  });

  it('retires the parked text-reply state — a later texted reply is refused truthfully', async () => {
    const r = await post(IN_TAB_BODY);
    expect(r.json?.outcome).toBe('applied');
    const likes = h.state.memoryDeletes.map(d => `${d['like:source']}|${d['like:content'] ?? ''}`);
    expect(likes.some(l => l.startsWith('callout_decision:%') && l.includes('req-1'))).toBe(true);
    expect(likes.some(l => l.startsWith('decision_token:%') && l.includes('req-1'))).toBe(true);
  });

  it('a second decision through any door (in-tab arriving second) reports already_decided truthfully', async () => {
    // First door: a text reply / email link already decided it.
    h.state.tor!.status = 'approved';
    const r = await post(IN_TAB_BODY);
    expect(r.status).toBe(200);
    expect(r.json?.outcome).toBe('already_decided');
    expect(String(r.json?.message)).toMatch(/Already handled/);
  });

  it('a foreign-company request is refused (company-scoped lookup, not_found rather than a cross-tenant write)', async () => {
    const r = await post({ ...IN_TAB_BODY, company_id: 'co-OTHER' });
    expect(r.status).toBe(200);
    expect(r.json?.outcome).toBe('not_found');
    expect(h.state.tor!.status).toBe('pending');
  });

  it('a revoked manager is refused from the in-tab door exactly as from email (defense in depth alongside Homebase middleware)', async () => {
    h.state.users = [{ id: 'mgr-1', name: 'Jack McCorkle', avatar_url: null, access_revoked_at: '2026-08-01T00:00:00Z' }];
    const r = await post(IN_TAB_BODY);
    expect(r.status).toBe(403);
    expect(h.state.tor!.status).toBe('pending');
  });
});
