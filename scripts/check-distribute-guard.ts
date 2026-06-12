// Automated check for the re-distribution guard (src/lib/distribute-guard.ts).
// No test runner is configured in this repo, so this is a standalone assertion
// script in the same style as scripts/check-greeting.ts. Pure function, no DB,
// no network, no send.
//
// Run:  npx tsx scripts/check-distribute-guard.ts
//
// Exits 0 if every case passes, 1 on any failure.

import { isAlreadyDistributed } from '../src/lib/distribute-guard';

const SENT_AT = '2026-06-15T14:30:00.000Z';

type Case = {
  label: string;
  row: { distributed_at: string | null };
  force: boolean;
  expected: boolean; // true = block (already distributed), false = proceed
};

const cases: Case[] = [
  { label: 'never sent, no force → proceed', row: { distributed_at: null }, force: false, expected: false },
  { label: 'already sent, no force → block', row: { distributed_at: SENT_AT }, force: false, expected: true },
  { label: 'already sent, force → proceed', row: { distributed_at: SENT_AT }, force: true, expected: false },
  { label: 'never sent, force → proceed', row: { distributed_at: null }, force: true, expected: false },
];

let failures = 0;
for (const c of cases) {
  const got = isAlreadyDistributed(c.row, c.force);
  const ok = got === c.expected;
  if (ok) {
    console.log(`PASS  ${c.label}  (isAlreadyDistributed → ${got})`);
  } else {
    failures++;
    console.error(`FAIL  ${c.label}  (isAlreadyDistributed → ${got}, expected ${c.expected})`);
  }
}

console.log('');
if (failures > 0) {
  console.error(`${failures} of ${cases.length} case(s) FAILED.`);
  process.exit(1);
}
console.log(`All ${cases.length} distribute-guard cases passed.`);
process.exit(0);
