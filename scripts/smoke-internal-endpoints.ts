/**
 * Safety-only smoke for /internal/notify-to-decision and
 * /internal/distribute-schedule.
 *
 * Happy-path tests are deferred until a sandbox company with synthetic
 * employees is set up. This smoke validates only auth and input validation
 * — not workflow side effects. Do NOT add tests here that call
 * distributeScheduleCore, sendDecisionNotification, or sendEmail directly
 * or indirectly.
 *
 * Background: an earlier version of this smoke seeded a fake schedule
 * against a real company_id and exercised the happy path, which fanned
 * out distribution emails to every active employee at that company. Every
 * test in this file must use randomUUID() for any id parameter and must
 * NOT seed rows in production tables.
 *
 * Run: npx tsx scripts/smoke-internal-endpoints.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });

import crypto from 'crypto';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

// Set the test secret BEFORE importing the router so requireInternalAuth
// captures it via process.env at request time.
const TEST_SECRET = crypto.randomBytes(32).toString('hex');
process.env.AEGIS_INTERNAL_SECRET = TEST_SECRET;

import { internalRouter } from '../src/webhooks/internal';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function postJson(
  url: string,
  body: unknown,
  bearer: string | null
): Promise<JsonResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (bearer !== null) headers['authorization'] = `Bearer ${bearer}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { _raw: text };
  }
  return { status: res.status, body: parsed };
}

async function bootEphemeralServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use('/internal', internalRouter);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function main(): Promise<void> {
  const { baseUrl, close } = await bootEphemeralServer();

  // Fresh random UUIDs per run — guaranteed-not-found in any real table.
  const FAKE_TOR_ID = crypto.randomUUID();
  const FAKE_SCHEDULE_ID = crypto.randomUUID();

  try {
    // ── /internal/notify-to-decision ───────────────────────────────────────

    // 1) Missing auth → 401
    {
      const r = await postJson(
        `${baseUrl}/internal/notify-to-decision`,
        { time_off_request_id: FAKE_TOR_ID, decision: 'approved' },
        null
      );
      assert(r.status === 401, `[notify] no-auth expected 401, got ${r.status}`);
      assert(r.body.error === 'Unauthorized', `[notify] no-auth body: ${JSON.stringify(r.body)}`);
    }

    // 2) Wrong bearer → 401
    {
      const r = await postJson(
        `${baseUrl}/internal/notify-to-decision`,
        { time_off_request_id: FAKE_TOR_ID, decision: 'approved' },
        'definitely-not-the-right-secret'
      );
      assert(r.status === 401, `[notify] wrong-secret expected 401, got ${r.status}`);
      assert(r.body.error === 'Unauthorized', `[notify] wrong-secret body: ${JSON.stringify(r.body)}`);
    }

    // 3) Valid auth, missing time_off_request_id → 400
    {
      const r = await postJson(
        `${baseUrl}/internal/notify-to-decision`,
        { decision: 'approved' },
        TEST_SECRET
      );
      assert(r.status === 400, `[notify] missing-id expected 400, got ${r.status}`);
      assert(
        typeof r.body.error === 'string' && (r.body.error as string).includes('time_off_request_id'),
        `[notify] missing-id error should mention field: ${JSON.stringify(r.body)}`
      );
    }

    // 4) Valid auth, missing decision → 400
    {
      const r = await postJson(
        `${baseUrl}/internal/notify-to-decision`,
        { time_off_request_id: FAKE_TOR_ID },
        TEST_SECRET
      );
      assert(r.status === 400, `[notify] missing-decision expected 400, got ${r.status}`);
      assert(
        typeof r.body.error === 'string' && (r.body.error as string).includes('decision'),
        `[notify] missing-decision error should mention field: ${JSON.stringify(r.body)}`
      );
    }

    // 5) Valid auth, invalid decision value → 400
    {
      const r = await postJson(
        `${baseUrl}/internal/notify-to-decision`,
        { time_off_request_id: FAKE_TOR_ID, decision: 'maybe' },
        TEST_SECRET
      );
      assert(r.status === 400, `[notify] bad-decision expected 400, got ${r.status}`);
      assert(typeof r.body.error === 'string', `[notify] bad-decision missing error: ${JSON.stringify(r.body)}`);
    }

    // 6) Valid auth, guaranteed-not-found id → 500 with "not found"
    //    Side-effect safety: sendDecisionNotification's first DB call is a
    //    SELECT on time_off_requests, which throws if no row matches. The
    //    throw aborts the workflow before any sendEmail/sendSms is reached.
    {
      const r = await postJson(
        `${baseUrl}/internal/notify-to-decision`,
        { time_off_request_id: FAKE_TOR_ID, decision: 'approved' },
        TEST_SECRET
      );
      assert(r.status === 500, `[notify] unknown-id expected 500, got ${r.status}`);
      assert(
        typeof r.body.error === 'string' && (r.body.error as string).includes('not found'),
        `[notify] unknown-id error should mention "not found": ${JSON.stringify(r.body)}`
      );
    }

    // ── /internal/distribute-schedule ──────────────────────────────────────

    // 7) Missing auth → 401
    {
      const r = await postJson(
        `${baseUrl}/internal/distribute-schedule`,
        { schedule_id: FAKE_SCHEDULE_ID },
        null
      );
      assert(r.status === 401, `[distribute] no-auth expected 401, got ${r.status}`);
      assert(r.body.error === 'Unauthorized', `[distribute] no-auth body: ${JSON.stringify(r.body)}`);
    }

    // 8) Wrong bearer → 401
    {
      const r = await postJson(
        `${baseUrl}/internal/distribute-schedule`,
        { schedule_id: FAKE_SCHEDULE_ID },
        'wrong'
      );
      assert(r.status === 401, `[distribute] wrong-secret expected 401, got ${r.status}`);
      assert(r.body.error === 'Unauthorized', `[distribute] wrong-secret body: ${JSON.stringify(r.body)}`);
    }

    // 9) Valid auth, missing schedule_id → 400
    {
      const r = await postJson(
        `${baseUrl}/internal/distribute-schedule`,
        {},
        TEST_SECRET
      );
      assert(r.status === 400, `[distribute] missing-id expected 400, got ${r.status}`);
      assert(
        typeof r.body.error === 'string' && (r.body.error as string).includes('schedule_id'),
        `[distribute] missing-id error should mention field: ${JSON.stringify(r.body)}`
      );
    }

    // 10) Valid auth, guaranteed-not-found id → 500 with "not found"
    //     Side-effect safety: the route looks up the schedule row before
    //     calling distributeScheduleCore. A missing row returns 500 before
    //     any fan-out, so no employees are emailed/SMSed.
    {
      const r = await postJson(
        `${baseUrl}/internal/distribute-schedule`,
        { schedule_id: FAKE_SCHEDULE_ID },
        TEST_SECRET
      );
      assert(r.status === 500, `[distribute] unknown-id expected 500, got ${r.status}`);
      assert(
        typeof r.body.error === 'string' && (r.body.error as string).includes('not found'),
        `[distribute] unknown-id error should mention "not found": ${JSON.stringify(r.body)}`
      );
    }

    console.log('✓ All smoke-internal-endpoints safety assertions passed (10/10)');
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error('[smoke-internal-endpoints] failed:', err);
  process.exit(1);
});
