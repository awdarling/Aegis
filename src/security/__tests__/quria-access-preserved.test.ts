// Quria platform-admin access — a standing guard, not a one-off check.
//
// Alexander, 2026-08-18: "What's important is that I don't lose my query admin
// permissions across all products."
//
// The Phase 2 work rewires how Aegis decides who a company's managers are. That
// touches role handling, so this file exists to fail loudly if any future change
// quietly narrows what a `quria` account can do. It is deliberately about the
// SHAPE of the permission model rather than any one workflow — a change that
// breaks quria access almost always breaks one of these.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const root = resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

describe('quria stays a first-class role', () => {
  it("'quria' is still a users.role value", () => {
    const types = read('src/db/types.ts');
    expect(types).toMatch(/role:\s*'quria'\s*\|\s*'owner'\s*\|\s*'manager'/);
  });

  it('quria staff have their own identity table, separate from any client roster', () => {
    // A platform admin is NOT an employee of a client. Their name, email and
    // phone live in quria_staff — which is exactly why the manager directory
    // must not go looking for them in a client's employees table.
    const v = read('src/security/quria-verification.ts');
    expect(v).toMatch(/from\('quria_staff'\)/);
    expect(v).toMatch(/contact_phone/);
    expect(v).toMatch(/eq\('active', true\)/);
  });

  it('an inbound message from quria staff is still verified as quria', () => {
    const sv = read('src/security/sender-verification.ts');
    expect(sv).toMatch(/checkQuriaStaff/);
    expect(sv).toMatch(/quria_staff_email/);
  });

  it('replies to quria staff still route to their own address', () => {
    expect(read('src/messaging/reply.ts')).toMatch(/quria_staff_email/);
  });

  it('quria-only intents still exist and are still gated', () => {
    const router = read('src/router/intent-router.ts');
    expect(router).toMatch(/QURIA_ONLY_INTENTS/);
    expect(router).toMatch(/quria_diagnostic/);
  });
});

describe('quria is deliberately excluded from a CLIENT’s operational traffic', () => {
  it('the manager directory asks only for manager and owner', () => {
    // This is not a loss of permission — it is the long-standing rule that a
    // platform admin does not receive every client's time-off approvals. Their
    // access to the client's DATA is unchanged; only the notification list is
    // scoped. Pinned here so nobody "fixes" it in either direction by accident.
    const dir = read('src/messaging/manager-directory.ts');
    expect(dir).toMatch(/\.in\('role', \['manager', 'owner'\]\)/);
    expect(dir).toMatch(/quria_staff/); // the comment explaining why
  });

  it('the manager directory never filters on quria and never writes to users', () => {
    const dir = read('src/messaging/manager-directory.ts');
    expect(dir).not.toMatch(/\.update\(/);
    expect(dir).not.toMatch(/\.delete\(/);
    expect(dir).not.toMatch(/\.insert\(/);
  });
});

describe('Phase 2 changed no role or permission logic', () => {
  it('nothing in the manager directory revokes, downgrades or reassigns a role', () => {
    const dir = read('src/messaging/manager-directory.ts');
    expect(dir).not.toMatch(/access_revoked_at\s*[:=]\s*(?!null)/);
    expect(dir).not.toMatch(/role\s*=\s*['"]/);
  });

  it('the users.employee_id link is additive — it grants and removes nothing', () => {
    // The link answers "which person is this login?", never "what may this
    // login do?". If a future change starts reading employee data to make an
    // authorisation decision, this test is the place that should stop it.
    const migration = read('migrations/025_link_users_to_employees.sql');
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS employee_id uuid/);
    expect(migration).not.toMatch(/DROP\s+(COLUMN|TABLE|CONSTRAINT)/i);
    expect(migration).not.toMatch(/ALTER\s+COLUMN\s+role/i);
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
    expect(migration).not.toMatch(/UPDATE\s+public\.users/i);
  });
});
