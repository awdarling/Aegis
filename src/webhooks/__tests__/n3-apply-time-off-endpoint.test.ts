import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// ── N-3: POST /internal/apply-time-off-decision — the Homebase door lands in
// the ONE shared decision core (F13) ──────────────────────────────────────────
//
// This runs the REAL applyTimeOffDecision against a stateful DB mock, because
// the contract under test is behavioral: a decision through the new
// Homebase-link door writes the status ONCE, retires the other door's parked
// state, and a second arrival through EITHER door gets the truthful
// already-decided answer. Also pinned: the revoked-manager refusal (S-3 actor
// half — which the old Homebase magic-link path never had) and the internal
// bearer auth.

const h = vi.hoisted(() => {
  const state = {
    tor: null as { id: string; company_id: string; employee_id: string; status: string; start_date: string; end_date: string; reason: string | null } | null,
    users: [] as Array<{ id: string; name: string; access_revoked_at: string | null }>,
    employees: [] as Array<Record<string, unknown>>,
    memory: [] as Array<{ id: string; source: string; content: string }>,
    memoryDeletes: [] as Array<Record<string, unknown>>,
    patternInserts: [] as Array<Record<string, unknown>>,
  };
  let seq = 0;
  function makeBuilder(table: string) {
    const f: Record<string, unknown> = {};
    let op = 'select';
    let payload: Record<string, unknown> | undefined;
    const finish = () => {
      if (table === 'time_off_requests') {
        if (op === 'select') {
          const match = state.tor && (!f.id || state.tor.id === f.id) ? state.tor : null;
          return { data: match, error: null };
        }
        if (op === 'update') {
          // The guarded optimistic write: only flips a still-pending row.
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
        if (op === 'insert' && payload) {
          state.patternInserts.push(payload);
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
    nextId: () => `mem-${++seq}`,
    sendSms: vi.fn(async () => true),
    sendEmail: vi.fn(async () => true),
    markCalledOut: vi.fn(async () => {}),
    startCoverage: vi.fn(async () => ({ outcome: 'started', shiftName: 'Afternoon', contacted: ['rosa'] })),
    findCoverageSession: vi.fn(async () => null),
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
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn(async () => {}) }));
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

async function post(body: Record<string, unknown>, auth = true) {
  const res = await fetch(`http://127.0.0.1:${port}/internal/apply-time-off-decision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: 'Bearer test-internal-secret' } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) as Record<string, unknown> | null };
}

const BASE_BODY = {
  time_off_request_id: 'req-1',
  action: 'approve',
  company_id: 'co-1',
  manager_user_id: 'mgr-1',
};

beforeEach(() => {
  h.state.tor = { id: 'req-1', company_id: 'co-1', employee_id: 'emp-1', status: 'pending', start_date: '2026-09-02', end_date: '2026-09-02', reason: null };
  h.state.users = [{ id: 'mgr-1', name: 'Jack McCorkle', access_revoked_at: null }];
  h.state.employees = [{ id: 'emp-1', name: 'Mia Shaffer', contact_phone: '+15550001111', contact_email: 'mia@x.test' }];
  h.state.memory = [];
  h.state.memoryDeletes = [];
  h.state.patternInserts = [];
  h.sendSms.mockClear();
  h.sendEmail.mockClear();
  h.markCalledOut.mockClear();
  h.startCoverage.mockClear();
});

describe('auth + actor checks', () => {
  it('refuses without the internal bearer secret', async () => {
    const r = await post(BASE_BODY, false);
    expect(r.status).toBe(401);
    expect(h.state.tor!.status).toBe('pending');
  });

  it("refuses a revoked manager's decision and changes nothing (S-3 actor half)", async () => {
    h.state.users = [{ id: 'mgr-1', name: 'Jack McCorkle', access_revoked_at: '2026-08-01T00:00:00Z' }];
    const r = await post(BASE_BODY);
    expect(r.status).toBe(403);
    expect(String(r.json?.message)).toMatch(/no longer has manager access/);
    expect(h.state.tor!.status).toBe('pending');
    expect(h.sendSms).not.toHaveBeenCalled();
  });
});

describe('the decision lands in the shared core', () => {
  it('approve: writes the status once, attributes decided_by, notifies the employee, answers in one voice', async () => {
    const r = await post(BASE_BODY);
    expect(r.status).toBe(200);
    expect(r.json?.outcome).toBe('applied');
    expect(String(r.json?.message)).toMatch(/Mia.*approved and they've been told/);
    expect(h.state.tor!.status).toBe('approved');
    expect((h.state.tor as unknown as { decided_by: string }).decided_by).toBe('mgr-1');
    // The employee heard, SMS-first.
    expect(h.sendSms).toHaveBeenCalledTimes(1);
    expect((h.sendSms.mock.calls[0][0] as { body: string }).body).toMatch(/approved/);
    // The OTHER door's state was retired: every decision token and parked
    // text-reply row for this request was deleted (F13 mutual retirement).
    const likes = h.state.memoryDeletes.map(d => `${d['like:source']}|${d['like:content'] ?? ''}`);
    expect(likes.some(l => l.startsWith('decision_token:%') && l.includes('req-1'))).toBe(true);
    expect(likes.some(l => l.startsWith('callout_decision:%') && l.includes('req-1'))).toBe(true);
  });

  it('deny: the employee is told, in time-off words (not call-out words)', async () => {
    const r = await post({ ...BASE_BODY, action: 'deny' });
    expect(r.json?.outcome).toBe('applied');
    expect(String(r.json?.message)).toMatch(/time off .* is denied/);
    expect(h.state.tor!.status).toBe('denied');
  });

  it('a SECOND decision through this door answers already_decided truthfully — text-then-link can never double-decide', async () => {
    // First door (a texted reply, another manager, anyone): request decided.
    const first = await post(BASE_BODY);
    expect(first.json?.outcome).toBe('applied');
    h.sendSms.mockClear();

    // Second arrival through the link door.
    const second = await post({ ...BASE_BODY, action: 'deny' });
    expect(second.status).toBe(200);
    expect(second.json?.outcome).toBe('already_decided');
    expect(String(second.json?.message)).toMatch(/Already handled/);
    // Still approved — the loser changed nothing and nobody was re-notified.
    expect(h.state.tor!.status).toBe('approved');
    expect(h.sendSms).not.toHaveBeenCalled();
  });

  it('a call-out approve_and_cover marks the schedule and starts coverage through the same core', async () => {
    const callOut = [{ date: '2026-09-02', shift_name: 'Afternoon', start_time: '15:00:00', end_time: '20:15:00' }];
    const r = await post({ ...BASE_BODY, action: 'approve_and_cover', call_out: callOut });
    expect(r.json?.outcome).toBe('applied');
    expect(h.markCalledOut).toHaveBeenCalledTimes(1);
    expect(h.startCoverage).toHaveBeenCalledTimes(1);
    expect(String(r.json?.message)).toMatch(/texting 1 qualified teammate/);
  });

  it('unknown request → not_found with a pointer at Homebase, never a crash', async () => {
    h.state.tor = null;
    const r = await post(BASE_BODY);
    expect(r.status).toBe(200);
    expect(r.json?.outcome).toBe('not_found');
    expect(String(r.json?.message)).toMatch(/Time Off tab in Homebase/);
  });
});
