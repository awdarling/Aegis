import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// ── N-3: /webhooks/decision confirms on GET, acts only on POST ───────────────
//
// The production failure this pins (J-3): a manager's approve link EXECUTED on
// a bare GET — mail scanners and link previewers fetch links without a human
// click — and the second fetch then told him nothing had happened. The rule
// now: GET = validate + render a confirm page (read-only); POST (the confirm
// button) = validate again + execute. Tokens are hashed at rest (N-2) with a
// legacy plaintext fallback so in-flight links keep working across the deploy.
//
// The time-off core (applyTimeOffDecision) is mocked here — its own behavior
// is pinned in w2-callout-text-decision + n3-apply-time-off-endpoint tests.
// This file is about the DOOR, not the decision.

const h = vi.hoisted(() => {
  const memoryStore = new Map<string, { id: string; content: string }>();
  let seq = 0;
  const state = {
    tor: null as Record<string, unknown> | null,
    writes: [] as Array<{ table: string; op: string; payload?: unknown; filters: Record<string, unknown> }>,
  };
  function makeBuilder(table: string) {
    const f: Record<string, unknown> = {};
    let op = 'select';
    let payload: unknown;
    const finish = () => {
      state.writes.push({ table, op, payload, filters: f });
      if (table === 'aegis_memory' && op === 'select' && typeof f.source === 'string') {
        const row = memoryStore.get(f.source as string);
        return { data: row ? { id: row.id, content: row.content } : null, error: null };
      }
      if (table === 'aegis_memory' && op === 'delete' && typeof f.source === 'string') {
        memoryStore.delete(f.source as string);
        return { data: null, error: null };
      }
      if (table === 'time_off_requests' && op === 'select') {
        return { data: state.tor, error: null };
      }
      return { data: null, error: null };
    };
    const b: Record<string, unknown> = {
      select() { op = 'select'; return b; },
      insert(p: unknown) { op = 'insert'; payload = p; return b; },
      update(p: unknown) { op = 'update'; payload = p; return b; },
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
    memoryStore, state, makeBuilder,
    nextId: () => `mem-${++seq}`,
    applyTimeOffDecision: vi.fn(),
    managerStillActive: vi.fn(async () => true),
    findCoverageSession: vi.fn(async () => null),
  };
});

vi.mock('../../config/env', () => ({ env: { NODE_ENV: 'test', EMAIL_ONLY: false, BASE_URL: 'http://aegis.test' } }));
vi.mock('../../db/client', () => ({ supabase: { from: (t: string) => h.makeBuilder(t) } }));
vi.mock('../../security/manager-active', () => ({ managerStillActive: h.managerStillActive }));
vi.mock('../../workflows/callout-decision', () => ({
  applyTimeOffDecision: h.applyTimeOffDecision,
  notifyEmployeeDecision: vi.fn(async () => true),
}));
vi.mock('../../workflows/emergency-coverage', () => ({
  processCoverageButtonDecision: vi.fn(async () => ({ outcome: 'accepted', shiftName: 'Afternoon' })),
  processCoverageBatchButton: vi.fn(async () => ({ outcome: 'sent', shiftName: 'Afternoon' })),
  startCoverageForCallOut: vi.fn(),
  markAssignmentsCalledOut: vi.fn(),
  findCoverageSessionForTimeOffRequest: h.findCoverageSession,
}));
vi.mock('../../workflows/shift-swap', () => ({
  executeScheduleSwap: vi.fn(async () => ({ ok: true, schedule_id: 'sched-1' })),
  executeScheduleTrade: vi.fn(async () => ({ ok: true, schedule_id: 'sched-1' })),
}));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn(async () => true) }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn(async () => true) }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock('../../messaging/manager-directory', () => ({ resolveManagers: vi.fn(async () => ({ managers: [], unreachableBySms: [], smsChannel: null })) }));

import express from 'express';
import type { AddressInfo } from 'node:net';
import { decisionWebhook } from '../decision';
import { mintTokenSource, hashDecisionToken } from '../../security/decision-token-store';

const app = express();
app.use('/webhooks/decision', decisionWebhook);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
afterAll(() => server.close());

const url = (action: string, requestId: string, token: string) =>
  `http://127.0.0.1:${port}/webhooks/decision?action=${action}&requestId=${requestId}&token=${token}`;

const FUTURE = new Date(Date.now() + 86400000).toISOString();

function seedTimeOffToken(token: string, opts: { hashed?: boolean; action?: string } = {}) {
  const source = opts.hashed === false ? `decision_token:${token}` : mintTokenSource('decision_token', token);
  h.memoryStore.set(source, {
    id: h.nextId(),
    content: JSON.stringify({
      decision_type: 'time_off',
      action: opts.action ?? 'approve',
      request_id: 'req-1',
      company_id: 'co-1',
      employee_id: 'emp-1',
      employee_name: 'Mia Shaffer',
      employee_channel: 'sms',
      employee_contact: '+15550001111',
      aegis_sms_channel: '+15559990000',
      manager_user_id: 'mgr-1',
      manager_name: 'Jack',
      expires_at: FUTURE,
    }),
  });
}

function seedSwapToken(token: string) {
  h.memoryStore.set(mintTokenSource('decision_token', token), {
    id: h.nextId(),
    content: JSON.stringify({
      decision_type: 'swap',
      action: 'approve',
      request_id: 'swap-1',
      company_id: 'co-1',
      requester_id: 'emp-1',
      requester_name: 'Mia Shaffer',
      requester_channel: 'sms',
      requester_contact: '+15550001111',
      aegis_sms_channel: '+15559990000',
      receiver_id: 'emp-2',
      receiver_name: 'Rosa Alvarez',
      shift_date: '2026-09-02',
      shift_name: 'Afternoon',
      role: 'Lifeguard',
      manager_user_id: 'mgr-1',
      expires_at: FUTURE,
    }),
  });
}

beforeEach(() => {
  h.memoryStore.clear();
  h.state.writes.length = 0;
  h.state.tor = null;
  h.applyTimeOffDecision.mockReset();
  h.managerStillActive.mockReset();
  h.managerStillActive.mockResolvedValue(true);
});

describe('GET — validates and confirms, never acts', () => {
  it('a GET on a valid time-off approve link renders the confirm page and changes NOTHING', async () => {
    seedTimeOffToken('tok-1');
    const res = await fetch(url('approve', 'req-1', 'tok-1'));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toMatch(/Nothing happens until you press the button/);
    expect(html).toMatch(/Approve this time off\?/);
    expect(html).toMatch(/method="POST"/);
    // The decision core was never touched, no row was written or deleted.
    expect(h.applyTimeOffDecision).not.toHaveBeenCalled();
    expect(h.state.writes.filter(w => w.op !== 'select')).toHaveLength(0);
    // Token still there for the real click.
    expect(h.memoryStore.size).toBe(1);
  });

  it('a GET on a swap link renders a confirm naming both people — no schedule write, no token burn', async () => {
    seedSwapToken('tok-s');
    const res = await fetch(url('approve', 'swap-1', 'tok-s'));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toMatch(/Mia Shaffer/);
    expect(html).toMatch(/Rosa Alvarez/);
    expect(html).toMatch(/Nothing happens until you press the button/);
    expect(h.state.writes.filter(w => w.op !== 'select')).toHaveLength(0);
    expect(h.memoryStore.size).toBe(1);
  });

  it('a legacy PLAINTEXT token (minted pre-deploy) still resolves — in-flight links survive', async () => {
    seedTimeOffToken('tok-legacy', { hashed: false });
    const res = await fetch(url('approve', 'req-1', 'tok-legacy'));
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Approve this time off\?/);
  });

  it('the raw token value appears NOWHERE in the store — hashed at rest (N-2)', () => {
    seedTimeOffToken('tok-secret');
    for (const source of h.memoryStore.keys()) {
      expect(source).not.toContain('tok-secret');
      expect(source).toBe(`decision_token:${hashDecisionToken('tok-secret')}`);
    }
  });
});

describe('POST — the confirm button acts', () => {
  it('a POST with a valid token lands in the shared decision core (F13) and renders the outcome', async () => {
    seedTimeOffToken('tok-1');
    h.applyTimeOffDecision.mockResolvedValue({
      outcome: 'applied', action: 'approve', coverage: null, startDate: '2026-09-02', endDate: '2026-09-02',
    });
    const res = await fetch(url('approve', 'req-1', 'tok-1'), { method: 'POST' });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toMatch(/Decision Recorded/);
    expect(h.applyTimeOffDecision).toHaveBeenCalledTimes(1);
    const [ctx, action, via] = h.applyTimeOffDecision.mock.calls[0];
    expect(action).toBe('approve');
    expect(via).toBe('email_link');
    expect((ctx as { manager_user_id: string }).manager_user_id).toBe('mgr-1');
  });

  it('a second POST is refused TRUTHFULLY — the core answers already_decided and the page says so', async () => {
    seedTimeOffToken('tok-1');
    h.applyTimeOffDecision.mockResolvedValue({ outcome: 'already_decided', status: 'approved', coverageOpen: null });
    const res = await fetch(url('approve', 'req-1', 'tok-1'), { method: 'POST' });
    const html = await res.text();

    expect(res.status).toBe(409);
    expect(html).toMatch(/already been approved/);
    expect(html).not.toMatch(/Decision Recorded/);
  });

  it("a revoked manager's POST is refused (S-3 actor half survives N-3)", async () => {
    seedTimeOffToken('tok-1');
    h.managerStillActive.mockResolvedValue(false);
    const res = await fetch(url('approve', 'req-1', 'tok-1'), { method: 'POST' });

    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no longer has manager access/);
    expect(h.applyTimeOffDecision).not.toHaveBeenCalled();
  });

  it('a revoked manager is refused at the GET too — the confirm page never renders', async () => {
    seedTimeOffToken('tok-1');
    h.managerStillActive.mockResolvedValue(false);
    const res = await fetch(url('approve', 'req-1', 'tok-1'));
    expect(res.status).toBe(403);
  });
});

describe('missing-token truth (the J-3 fix survives)', () => {
  it('a link whose token is gone reports the request\'s REAL state, not "nothing changed"', async () => {
    h.state.tor = { id: 'req-1', status: 'approved', company_id: 'co-1', employee_id: 'emp-1' };
    const res = await fetch(url('approve', 'req-1', 'gone-token'));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toMatch(/Already Approved/);
    expect(html).toMatch(/that decision stands and the employee has been told/);
  });

  it('an expired token is deleted on read and reported as expired — GET and POST alike', async () => {
    const source = mintTokenSource('decision_token', 'tok-old');
    h.memoryStore.set(source, {
      id: h.nextId(),
      content: JSON.stringify({
        decision_type: 'time_off', action: 'approve', request_id: 'req-1', company_id: 'co-1',
        employee_id: 'emp-1', employee_name: 'Mia Shaffer', employee_channel: 'sms',
        employee_contact: '+1555', aegis_sms_channel: null,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
    });
    const res = await fetch(url('approve', 'req-1', 'tok-old'), { method: 'POST' });
    expect(res.status).toBe(410);
    expect(h.memoryStore.has(source)).toBe(false);
    expect(h.applyTimeOffDecision).not.toHaveBeenCalled();
  });
});
