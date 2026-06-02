/**
 * Mint a single aegis_action_tokens row + magic-link URL for wiring checks
 * against Homebase's /api/aegis-action dispatcher.
 *
 * This script writes ONE row to aegis_action_tokens against the sandbox
 * company (SANDBOX_COMPANY_ID, default sentinel
 * '00000000-0000-0000-0000-000000000001'). The sandbox company row must
 * already exist; it is a permanent fixture seeded by the operator, not
 * created here.
 *
 * Safety modes
 * ────────────
 *
 * Defaults (no PAYLOAD_* env vars set): the payload's schedule_id /
 * time_off_request_id / employee_id are fresh random UUIDs, so when the
 * link is clicked the Homebase dispatcher will look the token up, decode
 * the payload, fail to resolve those ids to any real row, and return a
 * graceful "not found" page. No email is sent; no schedule is
 * distributed; no decision notification fires. Use this mode to verify
 * token lookup + signature handling end-to-end without side effects.
 *
 * Overridden (one or more PAYLOAD_* env vars set to real sandbox row
 * ids): the dispatcher will resolve the referenced row(s) and actually
 * execute the wired-up workflow. Only point these at sandbox rows whose
 * downstream fan-out (emails / SMS / schedule distribution) is safe to
 * trigger. Never point them at production rows.
 *
 * Env
 * ───
 *   SANDBOX_COMPANY_ID      (default: '00000000-0000-0000-0000-000000000001')
 *   ACTION_TYPE             (default: 'confirm_distribution')
 *   HOMEBASE_URL            (default: 'https://homebase-nine-phi.vercel.app')
 *
 *   PAYLOAD_SCHEDULE_ID     (default: randomUUID())
 *   PAYLOAD_TOR_ID          (default: randomUUID())
 *   PAYLOAD_EMPLOYEE_ID     (default: randomUUID())
 *   PAYLOAD_EMPLOYEE_NAME   (default: 'Wiring Test')
 *
 * Run (defaults, safe):
 *   npx tsx scripts/generate-test-token.ts
 *
 * Run (real sandbox schedule, exercises distribution fan-out):
 *   PAYLOAD_SCHEDULE_ID=<sandbox-schedule-uuid> \
 *   ACTION_TYPE=confirm_distribution \
 *   npx tsx scripts/generate-test-token.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });

import crypto from 'crypto';
import { supabase } from '../src/db/client';
import { generateRawToken, hashToken } from '../src/lib/aegis-actions/tokens';

const DEFAULT_HOMEBASE_URL = 'https://homebase-nine-phi.vercel.app';
const DEFAULT_SANDBOX_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const DEFAULT_EMPLOYEE_NAME = 'Wiring Test';

async function main(): Promise<void> {
  const actionType = process.env.ACTION_TYPE ?? 'confirm_distribution';
  const homebaseUrl = process.env.HOMEBASE_URL ?? DEFAULT_HOMEBASE_URL;
  const companyId = process.env.SANDBOX_COMPANY_ID ?? DEFAULT_SANDBOX_COMPANY_ID;

  const scheduleId = process.env.PAYLOAD_SCHEDULE_ID ?? crypto.randomUUID();
  const torId = process.env.PAYLOAD_TOR_ID ?? crypto.randomUUID();
  const employeeId = process.env.PAYLOAD_EMPLOYEE_ID ?? crypto.randomUUID();
  const employeeName = process.env.PAYLOAD_EMPLOYEE_NAME ?? DEFAULT_EMPLOYEE_NAME;

  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const nowIso = new Date().toISOString();
  const expiresAtIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const payload = {
    time_off_request_id: torId,
    schedule_id: scheduleId,
    employee_id: employeeId,
    employee_name: employeeName,
    company_name: 'Sandbox',
    start_date: '2026-07-01',
    end_date: '2026-07-01',
    week_start: '2026-07-06',
    week_end: '2026-07-12',
  };

  const { data, error } = await supabase
    .from('aegis_action_tokens')
    .insert({
      company_id: companyId,
      token_hash: tokenHash,
      action_type: actionType,
      payload,
      issued_to_email: 'wiring-test@example.com',
      issued_to_user_id: null,
      issued_to_employee_id: null,
      issued_at: nowIso,
      expires_at: expiresAtIso,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`Failed to insert aegis_action_tokens row: ${error?.message ?? 'no row returned'}`);
  }

  const rowId = (data as { id: string }).id;
  const url = `${homebaseUrl}/api/aegis-action?token=${rawToken}`;

  const usingRealScheduleId = !!process.env.PAYLOAD_SCHEDULE_ID;
  const usingRealTorId = !!process.env.PAYLOAD_TOR_ID;
  const usingRealEmployeeId = !!process.env.PAYLOAD_EMPLOYEE_ID;
  const anyRealId = usingRealScheduleId || usingRealTorId || usingRealEmployeeId;

  console.log('✓ aegis_action_tokens row inserted');
  console.log(`  row id:       ${rowId}`);
  console.log(`  company_id:   ${companyId}`);
  console.log(`  action_type:  ${actionType}`);
  console.log(`  expires_at:   ${expiresAtIso}`);
  console.log('');
  console.log('Payload:');
  console.log(`  schedule_id:         ${payload.schedule_id}${usingRealScheduleId ? '  (overridden)' : '  (random)'}`);
  console.log(`  time_off_request_id: ${payload.time_off_request_id}${usingRealTorId ? '  (overridden)' : '  (random)'}`);
  console.log(`  employee_id:         ${payload.employee_id}${usingRealEmployeeId ? '  (overridden)' : '  (random)'}`);
  console.log(`  employee_name:       ${payload.employee_name}`);
  console.log(`  company_name:        ${payload.company_name}`);
  console.log(`  start_date:          ${payload.start_date}`);
  console.log(`  end_date:            ${payload.end_date}`);
  console.log(`  week_start:          ${payload.week_start}`);
  console.log(`  week_end:            ${payload.week_end}`);
  console.log('');
  if (anyRealId) {
    console.log('⚠ One or more payload ids are real overrides — clicking will execute the wired-up workflow.');
  } else {
    console.log('✓ All payload ids are random — clicking is safe; dispatcher will return "not found".');
  }
  console.log('');
  console.log('Magic-link URL:');
  console.log(`  ${url}`);
}

main().catch((err) => {
  console.error('[generate-test-token] failed:', err);
  process.exit(1);
});
