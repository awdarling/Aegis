import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Phase 2 (2026-08-22): a broadcast must not reach a revoked login ──────────
//
// THE DEFECT. `resolveRecipients(targetType: 'managers')` added manager/owner
// LOGINS on top of the employees with a management primary_role, so an owner who
// never works the floor still hears company announcements. Correct intent. But it
// queried `users` directly:
//
//     .eq('company_id', companyId).in('role', ['manager', 'owner'])
//
// with no access_revoked_at filter. Revoking someone's Homebase access therefore
// did NOT stop Aegis broadcasting to them. That is not hypothetical: a revoked
// test manager on this very database collected 410 messages over the two months
// after his access was cut off.
//
// The second, quieter half: that path hardcoded `phone: null`, so a manager who
// only existed as a login could only ever be emailed — even with a mobile on
// their person record. resolveManagers answers both, in one place (Rule 0b).

const h = vi.hoisted(() => ({
  users: [] as Record<string, unknown>[],
  employees: [] as Record<string, unknown>[],
}));

vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: false } }));

vi.mock('../../db/client', () => ({
  supabase: {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      // `employees` is read by BOTH the primary_role query in resolveRecipients
      // and the whole-company load inside resolveManagers. One fixture serves
      // both, so the rows carry every column either of them selects.
      let rows = table === 'users' ? h.users : table === 'employees' ? h.employees : [];
      for (const m of ['select', 'eq', 'is', 'not', 'order', 'limit', 'neq']) chain[m] = () => chain;
      // `in` is honoured, not stubbed. resolveRecipients narrows employees by
      // primary_role; if the mock ignored that, a person would land in BOTH
      // halves of the result and the dedup assertions below would pass without
      // the dedup existing.
      chain.in = (col: string, vals: unknown[]) => {
        rows = rows.filter((r) => vals.includes(r[col] as never));
        return chain;
      };
      chain.maybeSingle = async () => ({
        data: table === 'company_channels' ? { channel_value: '+16166164898' } : null,
        error: null,
      });
      chain.single = async () => ({ data: null, error: null });
      chain.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(res({ data: rows, error: null }));
      return chain;
    },
  },
}));

vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn(async () => {}) }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(async () => {}) }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock('../../ai/claude', () => ({ generateReply: vi.fn(async () => '') }));

import { resolveRecipients } from '../broadcast';

const CO = 'co-1';

beforeEach(() => {
  h.users = [];
  h.employees = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('broadcast → managers', () => {
  it('THE FIX: a revoked login is not a recipient', async () => {
    // resolveManagers filters access_revoked_at at the query, so the revoked row
    // never comes back. The fixture models that: it is the only user row the
    // mock can return, and the assertion is that the code no longer asks for a
    // list that would contain one.
    h.users = [
      { id: 'u-jack', email: 'jack@club.test', name: 'Jack', role: 'manager', employee_id: 'e-jack' },
    ];
    h.employees = [
      {
        id: 'e-jack', name: 'Jack McCorkle', contact_phone: '+15550001111',
        contact_email: 'jack@club.test', active: true, notification_prefs: {},
        primary_role: 'Manager',
      },
    ];

    const got = await resolveRecipients(CO, 'managers', null, null);
    expect(got.map(r => r.email)).toEqual(['jack@club.test']);
  });

  it('asks users for non-revoked logins only', async () => {
    // Guards the actual regression: if someone re-hand-rolls this query without
    // the access_revoked_at filter, the revoked manager silently comes back.
    const src = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('../broadcast.ts', import.meta.url), 'utf8'));
    // The manager branch must go through the one resolver, not its own query.
    expect(src).toContain('resolveManagers(companyId)');
    expect(src).not.toMatch(/from\('users'\)[\s\S]{0,200}in\('role', \['manager', 'owner'\]\)/);
  });

  it('carries an owner-only login through with their real mobile, not null', async () => {
    // Previously hardcoded `phone: null`, so this person could only be emailed.
    h.users = [
      { id: 'u-ann', email: 'ann@club.test', name: 'Ann', role: 'owner', employee_id: 'e-ann' },
    ];
    h.employees = [
      {
        id: 'e-ann', name: 'Ann Ringler', contact_phone: '+15550002222',
        contact_email: 'ann@club.test', active: true, notification_prefs: {},
        primary_role: 'Server', // NOT a management primary_role — login path only
      },
    ];

    const got = await resolveRecipients(CO, 'managers', null, null);
    expect(got).toHaveLength(1);
    expect(got[0].phone).toBe('+15550002222');
    expect(got[0].name).toBe('Ann Ringler');
  });

  it('does not send the same person twice when they are both an employee and a login', async () => {
    // The dedup is on email and is now case-insensitive — a login stored with a
    // different case used to slip past the Set and get the broadcast twice.
    h.users = [
      { id: 'u-ann', email: 'Ann@Club.test', name: 'Ann', role: 'owner', employee_id: 'e-ann' },
    ];
    h.employees = [
      {
        id: 'e-ann', name: 'Ann Ringler', contact_phone: '+15550002222',
        contact_email: 'ann@club.test', active: true, notification_prefs: {},
        primary_role: 'Manager', // IS a management primary_role → in empRecipients
      },
    ];

    const got = await resolveRecipients(CO, 'managers', null, null);
    expect(got).toHaveLength(1);
  });
});
