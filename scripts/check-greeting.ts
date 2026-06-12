// Automated check for the shared greeting helper (src/messaging/greeting.ts).
// No test runner is configured in this repo (no vitest/jest), so this is a
// standalone assertion script in the same style as the other scripts/ checks.
//
// Run:  npx tsx scripts/check-greeting.ts
//   (matches the other scripts/ smoke checks in this repo)
//
// Exits 0 if every case passes, 1 on any failure.

import { firstName, greeting } from '../src/messaging/greeting';

type Case = {
  label: string;
  input: string | null | undefined;
  expectedFirst: string;
};

const cases: Case[] = [
  { label: "'Jane Smith' → 'Jane'", input: 'Jane Smith', expectedFirst: 'Jane' },
  { label: "'Jane' → 'Jane'", input: 'Jane', expectedFirst: 'Jane' },
  { label: "'  Mary  Jane Watson ' → 'Mary'", input: '  Mary  Jane Watson ', expectedFirst: 'Mary' },
  { label: "'' → 'there'", input: '', expectedFirst: 'there' },
  { label: 'null → \'there\'', input: null, expectedFirst: 'there' },
  { label: 'undefined → \'there\'', input: undefined, expectedFirst: 'there' },
];

let failures = 0;

for (const c of cases) {
  const gotFirst = firstName(c.input);
  const gotGreeting = greeting(c.input);
  const expectedGreeting = `Hi ${c.expectedFirst},`;
  const ok = gotFirst === c.expectedFirst && gotGreeting === expectedGreeting;
  if (ok) {
    console.log(`PASS  ${c.label}  (greeting: "${gotGreeting}")`);
  } else {
    failures++;
    console.error(
      `FAIL  ${c.label}\n      firstName → "${gotFirst}" (expected "${c.expectedFirst}")` +
      `\n      greeting  → "${gotGreeting}" (expected "${expectedGreeting}")`
    );
  }
}

console.log('');
if (failures > 0) {
  console.error(`${failures} of ${cases.length} case(s) FAILED.`);
  process.exit(1);
}
console.log(`All ${cases.length} greeting cases passed.`);
process.exit(0);
