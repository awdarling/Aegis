import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// ── S-4: POST /internal/notify-assignment — assignment texts go through the
// consent gate ────────────────────────────────────────────────────────────────
//
// Homebase's /api/notify-assignment used to send SMS itself via its own Telnyx
// client — the one door that skipped Aegis's "may we text this person?" check.
// It is now a thin proxy to this endpoint. Pinned here:
//   • the employee lookup is BOUND to company_id (a foreign employee_id is a
//     4xx and nothing is sent),
//   • the send goes through notifyEmployeeSmsFirst → sendSms, so a
//     non-consented employee falls back to EMAIL (legal) instead of being
//     texted,
//   • times are humanized (never a raw HH:MM:SS in employee-facing copy, §N2),
//   • the outcome is logged and reported honestly.
//
// notifyEmployeeSmsFirst runs REAL here; only the transport (sendSms/sendEmail)
// is mocked — sendSms returning false is exactly what the consent gate does.

const h = vi.hoisted(() => {
  const state = {
    employees: [] as Array<Record<string, unknown>>,
    activity: [] as Array<Record<string, unknown>>,
  };
  function makeBuilder(table: string) {
    const f: Record<string, unknown> = {};
    const finish = () => {
      if (table === 'employees') {
        const row = state.employees.find(e => e.id === f.id && e.company_id === f.company_id) ?? null;
        return { data: row, error: null };
      }
      if (table === 'company_channels') {
        return { data: { channel_value: '+15559990000' }, error: null };
      }
      return { data: null, error: null };
    };
    const b: Record<string, unknown> = {
      select() { return b; },
      insert() { return b; },
      update() { return b; },
      delete() { return b; },
      eq(col: string, val: unknown) { f[col] = val; return b; },
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
vi.mock('../../logger/activity-log', () => ({ logActivity: h.logActivity }));

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
  const res = await fetch(`http://127.0.0.1:${port}/internal/notify-assignment`, {
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
  company_id: 'co-1',
  employee_id: 'emp-1',
  shift_name: 'Afternoon',
  role: 'Lifeguard',
  date: '2026-09-02',
  start_time: '15:00:00',
  end_time: '20:15:00',
  approved_by: 'mgr-1',
  approved_by_email: 'jack@wm.test',
};

beforeEach(() => {
  h.state.employees = [{ id: 'emp-1', company_id: 'co-1', name: 'Mia Shaffer', contact_phone: '+15550001111', contact_email: 'mia@x.test' }];
  h.state.activity = [];
  h.sendSms.mockReset();
  h.sendSms.mockResolvedValue(true);
  h.sendEmail.mockReset();
  h.sendEmail.mockResolvedValue(true);
  h.logActivity.mockClear();
});

describe('auth + company binding', () => {
  it('refuses without the internal bearer secret', async () => {
    const r = await post(BASE_BODY, false);
    expect(r.status).toBe(401);
    expect(h.sendSms).not.toHaveBeenCalled();
  });

  it("a FOREIGN employee_id (another company's employee) is a 404 and nothing is sent", async () => {
    const r = await post({ ...BASE_BODY, company_id: 'co-2' });
    expect(r.status).toBe(404);
    expect(h.sendSms).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('missing fields are a 400', async () => {
    const r = await post({ company_id: 'co-1', employee_id: 'emp-1' });
    expect(r.status).toBe(400);
  });
});

describe('the send goes through the consent-gated notifier', () => {
  it('happy path: texted, with human clock times — never raw HH:MM:SS (§N2)', async () => {
    const r = await post(BASE_BODY);
    expect(r.status).toBe(200);
    expect(r.json?.ok).toBe(true);
    expect(r.json?.channel).toBe('sms');

    expect(h.sendSms).toHaveBeenCalledTimes(1);
    const sms = h.sendSms.mock.calls[0][0] as { body: string; employee_id?: string };
    // The consent gate needs the recipient's identity.
    expect(sms.employee_id).toBe('emp-1');
    expect(sms.body).toMatch(/Hi Mia — you've been added to the Afternoon shift/);
    expect(sms.body).toMatch(/3pm–8:15pm/);
    expect(sms.body).not.toMatch(/15:00:00|20:15:00/);
    expect(sms.body).toMatch(/Wednesday, September 2/);

    const log = h.logActivity.mock.calls[0][0] as { action: string; metadata: Record<string, unknown> };
    expect(log.action).toBe('assignment_notification_sent');
    expect(log.metadata.channel).toBe('sms');
    expect(log.metadata.approved_by).toBe('mgr-1');
  });

  it('a consent-blocked employee is EMAILED instead — the gate refusal becomes the fallback, not a silent text', async () => {
    // sendSms returning false is exactly what the N3 consent gate does for a
    // declined/opted-out/unknown-consent employee.
    h.sendSms.mockResolvedValue(false);
    const r = await post(BASE_BODY);

    expect(r.json?.ok).toBe(true);
    expect(r.json?.channel).toBe('email');
    expect(String(r.json?.message)).toMatch(/emailed instead/);
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    expect((h.sendEmail.mock.calls[0][0] as { to: string }).to).toBe('mia@x.test');
  });

  it('an unreachable employee (no phone, no email) is reported honestly, never silently dropped', async () => {
    h.state.employees = [{ id: 'emp-1', company_id: 'co-1', name: 'Mia Shaffer', contact_phone: null, contact_email: null }];
    const r = await post(BASE_BODY);

    expect(r.json?.ok).toBe(false);
    expect(r.json?.channel).toBe('none');
    expect(String(r.json?.message)).toMatch(/no phone or email on file/);
    const log = h.logActivity.mock.calls[0][0] as { action: string };
    expect(log.action).toBe('assignment_notification_failed');
  });
});
