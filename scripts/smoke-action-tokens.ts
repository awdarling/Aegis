/**
 * Smoke test for src/lib/aegis-actions token utility.
 *
 * Inserts a real row in aegis_action_tokens, validates the shape of the
 * returned URL/token/hash, looks the row up by hash, and deletes it.
 *
 * Run: npx tsx scripts/smoke-action-tokens.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });

import { supabase } from '../src/db/client';
import { generateActionToken, hashToken } from '../src/lib/aegis-actions/tokens';

const COMPANY_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function main(): Promise<void> {
  const result = await generateActionToken({
    action_type: 'approve_to',
    payload: { time_off_request_id: 'smoke-test-fake-id-xxx' },
    company_id: COMPANY_ID,
    issued_to_email: 'smoke@test.local',
    ttl_minutes: 5,
  });

  assert(result.url.startsWith('https://'), `url should start with https://, got ${result.url}`);
  assert(
    result.url.includes('/api/aegis-action?token='),
    `url should contain /api/aegis-action?token=, got ${result.url}`
  );

  const decoded = Buffer.from(result.raw_token, 'base64url');
  assert(
    decoded.length === 32,
    `raw_token should decode to 32 bytes via base64url, got ${decoded.length}`
  );

  assert(
    result.token_hash === hashToken(result.raw_token),
    'hashToken should be deterministic and match the returned token_hash'
  );

  const { data: row, error: lookupErr } = await supabase
    .from('aegis_action_tokens')
    .select('id, action_type, payload, company_id, issued_to_email, consumed_at')
    .eq('token_hash', result.token_hash)
    .single();

  assert(!lookupErr, `lookup by token_hash failed: ${lookupErr?.message}`);
  assert(row, 'row should exist for the inserted token_hash');
  assert(row!.action_type === 'approve_to', `action_type mismatch: ${row!.action_type}`);
  assert(
    (row!.payload as Record<string, unknown>)?.time_off_request_id === 'smoke-test-fake-id-xxx',
    `payload.time_off_request_id mismatch: ${JSON.stringify(row!.payload)}`
  );
  assert(row!.company_id === COMPANY_ID, `company_id mismatch: ${row!.company_id}`);
  assert(
    row!.issued_to_email === 'smoke@test.local',
    `issued_to_email mismatch: ${row!.issued_to_email}`
  );
  assert(row!.consumed_at === null, `consumed_at should be null on insert, got ${row!.consumed_at}`);

  const { error: delErr } = await supabase
    .from('aegis_action_tokens')
    .delete()
    .eq('id', row!.id);
  assert(!delErr, `cleanup delete failed: ${delErr?.message}`);

  console.log('✓ All smoke-action-tokens assertions passed');
}

main().catch((err) => {
  console.error('[smoke-action-tokens] failed:', err);
  process.exit(1);
});
