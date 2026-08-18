// The manager directory — ONE answer to "who are this company's managers and
// how do we reach them" (Rule 0b).
//
// Before this module there were ten answers, four of which hand-rolled the same
// case-sensitive email string-match. Every test below pins a specific way that
// arrangement failed silently in production.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state: {
    users: unknown;
    usersError: { message: string } | null;
    employees: unknown;
    employeesError: { message: string } | null;
    channel: unknown;
    queries: Array<{ table: string; filters: Record<string, unknown> }>;
  } = {
    users: [], usersError: null,
    employees: [], employeesError: null,
    channel: { channel_value: '+16166164898' },
    queries: [],
  };

  function makeBuilder(table: string) {
    const filters: Record<string, unknown> = {};
    state.queries.push({ table, filters });
    const settle = () => {
      if (table === 'users') return Promise.resolve({ data: state.users, error: state.usersError });
      if (table === 'employees') return Promise.resolve({ data: state.employees, error: state.employeesError });
      if (table === 'company_channels') return Promise.resolve({ data: state.channel, error: null });
      return Promise.resolve({ data: null, error: null });
    };
    const b: Record<string, unknown> = {
      select() { return b; },
      eq(col: string, val: unknown) { filters[col] = val; return b; },
      in(col: string, val: unknown) { filters[`in:${col}`] = val; return b; },
      is(col: string, val: unknown) { filters[`is:${col}`] = val; return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { return settle(); },
      single() { return settle(); },
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) { return settle().then(onF, onR); },
    };
    return b;
  }
  return { state, makeBuilder };
});

vi.mock('../../db/client', () => ({ supabase: { from: (t: string) => h.makeBuilder(t) } }));
vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: false } }));

import {
  resolveManagers, recipientsFor, primaryRecipient, wantsCategory, canSms,
  type ManagerContact,
} from '../manager-directory';

const CO = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

const login = (over: Record<string, unknown> = {}) => ({
  id: 'u1', email: 'jack@club.com', name: 'Jack', role: 'manager', employee_id: null, ...over,
});
const person = (over: Record<string, unknown> = {}) => ({
  id: 'e1', name: 'Jack McCorkle', contact_phone: '+16165551234',
  contact_email: 'jack@club.com', active: true, notification_prefs: {}, ...over,
});

beforeEach(() => {
  h.state.users = [];
  h.state.employees = [];
  h.state.usersError = null;
  h.state.employeesError = null;
  h.state.channel = { channel_value: '+16166164898' };
  h.state.queries.length = 0;
  vi.restoreAllMocks();
});

// ── The link is the design ───────────────────────────────────────────────────

describe('resolveManagers — the users.employee_id link', () => {
  it('reaches a manager through the link, not through their email address', async () => {
    h.state.users = [login({ employee_id: 'e1' })];
    // Deliberately a DIFFERENT email on the person record: a manager who changed
    // their login email, or signs in with a personal address. The old string
    // match would have found nobody and skipped the text in silence.
    h.state.employees = [person({ contact_email: 'j.mccorkle@personal.com' })];

    const dir = await resolveManagers(CO);
    expect(dir.managers).toHaveLength(1);
    expect(dir.managers[0].phone).toBe('+16165551234');
    expect(dir.managers[0].linkSource).toBe('employee_id');
    expect(dir.managers[0].employeeId).toBe('e1');
    expect(dir.unreachableBySms).toHaveLength(0);
  });

  it('falls back to matching on email while the backfill is incomplete, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.state.users = [login({ employee_id: null })];
    h.state.employees = [person()];

    const dir = await resolveManagers(CO);
    expect(dir.managers[0].phone).toBe('+16165551234');
    expect(dir.managers[0].linkSource).toBe('email_match');
    expect(warn.mock.calls.flat().join(' ')).toMatch(/Link them properly/);
  });

  it('matches email case- and whitespace-insensitively', async () => {
    // The four hand-rolled copies used .eq(), which is case-SENSITIVE. A manager
    // who signed up as "Jack@Club.com" was simply unreachable.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.state.users = [login({ email: 'Jack@Club.com' })];
    h.state.employees = [person({ contact_email: '  jack@club.com ' })];

    const dir = await resolveManagers(CO);
    expect(dir.managers[0].phone).toBe('+16165551234');
  });
});

// ── The silent failures, now loud ────────────────────────────────────────────

describe('resolveManagers — failures are loud, never silent', () => {
  it('shouts when a manager has no person record at all', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.state.users = [login()];
    h.state.employees = [];

    const dir = await resolveManagers(CO);
    expect(dir.managers[0].phone).toBeNull();
    expect(dir.unreachableBySms).toHaveLength(1);
    expect(err.mock.calls.flat().join(' ')).toMatch(/no person record.*cannot text them/s);
  });

  it('shouts when two people share the email — the old code returned null here', async () => {
    // .maybeSingle() resolves to null on multiple rows, and the error was never
    // checked, so a duplicate looked exactly like "no phone on file". Two
    // sandbox employees share one address in the live database today.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.state.users = [login()];
    h.state.employees = [person({ id: 'e1' }), person({ id: 'e2', name: 'Robin Vale' })];

    const dir = await resolveManagers(CO);
    expect(dir.managers[0].phone).toBeNull();
    expect(err.mock.calls.flat().join(' ')).toMatch(/2 people .* share that email/);
  });

  it('shouts when a company has no manager or owner login at all', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.state.users = [];
    const dir = await resolveManagers(CO);
    expect(dir.managers).toHaveLength(0);
    expect(err.mock.calls.flat().join(' ')).toMatch(/NO active manager or owner login/);
  });

  it('distinguishes a lookup FAILURE from "no managers"', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.state.usersError = { message: 'connection reset' };
    const dir = await resolveManagers(CO);
    expect(dir.managers).toHaveLength(0);
    expect(err.mock.calls.flat().join(' ')).toMatch(/FAILED to load managers.*connection reset/s);
  });

  it('still returns managers by email when the people lookup fails outright', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.state.users = [login()];
    h.state.employeesError = { message: 'db down' };
    h.state.employees = null;

    const dir = await resolveManagers(CO);
    // Degraded, not dead: they lose the text, they keep the email.
    expect(dir.managers).toHaveLength(1);
    expect(dir.managers[0].phone).toBeNull();
    expect(dir.managers[0].email).toBe('jack@club.com');
  });
});

// ── Revoked logins ───────────────────────────────────────────────────────────

describe('resolveManagers — revoked logins', () => {
  it('filters on access_revoked_at at the database', async () => {
    // Aegis checked this NOWHERE. A revoked test manager received 410 emails
    // over two months, the last one the day before this test was written.
    h.state.users = [login()];
    await resolveManagers(CO);
    const q = h.state.queries.find((x) => x.table === 'users');
    expect(q!.filters['is:access_revoked_at']).toBeNull();
  });

  it('asks only for manager and owner roles — never quria', async () => {
    // Platform admins hold a users row for company-scoped access, not to receive
    // a client's operational traffic. Their contact details live in quria_staff.
    h.state.users = [login()];
    await resolveManagers(CO);
    const q = h.state.queries.find((x) => x.table === 'users');
    expect(q!.filters['in:role']).toEqual(['manager', 'owner']);
    expect(q!.filters['company_id']).toBe(CO);
  });
});

// ── Ordering ─────────────────────────────────────────────────────────────────

describe('resolveManagers — who is "the" manager', () => {
  it('puts the owner first', async () => {
    // The old query said .order('role', { ascending: true }) and its comment
    // claimed it picked the owner. Alphabetically, 'manager' < 'owner' — so it
    // picked a manager. Every time.
    h.state.users = [
      login({ id: 'u1', email: 'jack@club.com', name: 'Jack', role: 'manager', employee_id: 'e1' }),
      login({ id: 'u2', email: 'ann@club.com', name: 'Ann', role: 'owner', employee_id: 'e2' }),
    ];
    h.state.employees = [
      person({ id: 'e1', name: 'Jack', notification_prefs: {} }),
      person({ id: 'e2', name: 'Ann', contact_email: 'ann@club.com', notification_prefs: { approvals: true } }),
    ];

    const dir = await resolveManagers(CO);
    expect(dir.managers.map((m) => m.name)).toEqual(['Ann', 'Jack']);
  });

  it('prefers a manager we can actually text as the single recipient', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.state.users = [
      login({ id: 'u2', email: 'ann@club.com', name: 'Ann', role: 'owner', employee_id: 'e2' }),
      login({ id: 'u1', email: 'jack@club.com', name: 'Jack', role: 'manager', employee_id: 'e1' }),
    ];
    h.state.employees = [
      person({ id: 'e2', name: 'Ann', contact_phone: null, contact_email: 'ann@club.com', notification_prefs: { approvals: true } }),
      person({ id: 'e1', name: 'Jack' }),
    ];

    const dir = await resolveManagers(CO);
    // Ann sorts first but has no phone, so the one-recipient path picks Jack.
    expect(primaryRecipient(dir, 'approvals', CO)!.name).toBe('Jack');
  });
});

// ── Inactive people ──────────────────────────────────────────────────────────

describe('resolveManagers — active means "here right now"', () => {
  it('treats a manager linked to an inactive person as uncontactable', async () => {
    // active=false is the seasonal / on-leave flag: not here right now,
    // uncontactable and unschedulable, and reversible when they come back.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.state.users = [login({ employee_id: 'e1' })];
    h.state.employees = [person({ active: false })];

    const dir = await resolveManagers(CO);
    expect(dir.managers[0].phone).toBeNull();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/marked inactive/);
  });
});

// ── Notification preferences ─────────────────────────────────────────────────

const mk = (over: Partial<ManagerContact>): ManagerContact => ({
  userId: 'u', employeeId: 'e', name: 'X', role: 'manager',
  email: 'x@club.com', phone: '+1555', linkSource: 'employee_id', prefs: {}, ...over,
});

describe('notification preferences', () => {
  it('an owner defaults to off for everything; everyone else defaults to on', async () => {
    const owner = mk({ role: 'owner' });
    const manager = mk({ role: 'manager' });
    for (const c of ['approvals', 'trades', 'schedule_posts', 'reports'] as const) {
      expect(wantsCategory(owner, c)).toBe(false);
      expect(wantsCategory(manager, c)).toBe(true);
    }
  });

  it('an owner can switch a single category on to see what Aegis feels like', async () => {
    const owner = mk({ role: 'owner', prefs: { reports: true } });
    expect(wantsCategory(owner, 'reports')).toBe(true);
    expect(wantsCategory(owner, 'trades')).toBe(false);
  });

  it('a working manager can switch a category off', async () => {
    expect(wantsCategory(mk({ prefs: { trades: false } }), 'trades')).toBe(false);
  });

  it('ignores junk in the preferences column rather than trusting it', async () => {
    h.state.users = [login({ employee_id: 'e1' })];
    h.state.employees = [person({ notification_prefs: { approvals: 'yes please', nonsense: 1 } })];
    const dir = await resolveManagers(CO);
    // A non-boolean is not a preference, so the role default applies.
    expect(dir.managers[0].prefs.approvals).toBeUndefined();
    expect(wantsCategory(dir.managers[0], 'approvals')).toBe(true);
  });
});

describe('recipientsFor — the safety valve', () => {
  const dirOf = (managers: ManagerContact[]) =>
    ({ managers, smsChannel: '+16166164898', unreachableBySms: [] });

  it('routes a category only to the people who want it', async () => {
    const dir = dirOf([mk({ name: 'Ann', role: 'owner' }), mk({ name: 'Jack' })]);
    expect(recipientsFor(dir, 'trades', CO).map((m) => m.name)).toEqual(['Jack']);
  });

  it('sends an ACTION ITEM to everyone rather than to nobody', async () => {
    // An owner-only company where the owner has opted out. A time-off request
    // must never silently reach no one — no orphan outputs.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = dirOf([mk({ name: 'Ann', role: 'owner' })]);
    expect(recipientsFor(dir, 'approvals', CO).map((m) => m.name)).toEqual(['Ann']);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/needs a decision. Sending to all managers anyway/);
  });

  it('genuinely skips a non-action category nobody wants', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = dirOf([mk({ name: 'Ann', role: 'owner' })]);
    expect(recipientsFor(dir, 'reports', CO)).toEqual([]);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/not an action item/);
  });

  it('returns nobody, and invents nobody, when the company has no managers', async () => {
    expect(recipientsFor(dirOf([]), 'approvals', CO)).toEqual([]);
    expect(primaryRecipient(dirOf([]), 'approvals', CO)).toBeNull();
  });
});

describe('canSms', () => {
  const dir = { managers: [], smsChannel: '+16166164898', unreachableBySms: [] };
  it('needs all three: not email-only, a phone, and a tenant number', async () => {
    expect(canSms(dir, mk({ phone: '+1555' }), false)).toBe(true);
    expect(canSms(dir, mk({ phone: '+1555' }), true)).toBe(false);
    expect(canSms(dir, mk({ phone: null }), false)).toBe(false);
    expect(canSms({ ...dir, smsChannel: null }, mk({ phone: '+1555' }), false)).toBe(false);
  });
});
