import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── ITEM 2 (2026-08-16) — EVERY manager is told about a time-off request ─────
//
// Alexander: "I want all managers to get notified of time off."
//
// THE DEFECT these tests pin. `notifyManager` — the path taken when an employee
// submits time off over SMS — looked up its recipient with:
//
//     .in('role', ['manager', 'owner']).order('role').limit(1).maybeSingle()
//
// literally "find first manager/owner for this company". So the SAME request
// notified a different set of people depending on how it arrived: every manager
// for an EMAILED request (notifyManagersByEmail already fanned out), exactly one
// arbitrary manager for a TEXTED one. As this build moves employees onto SMS,
// the one-manager path becomes the majority path.
//
// The subtle half is the TOKENS. Each manager must get their OWN approve/deny
// pair, because the token payload carries manager_user_id / manager_name and
// that is what attributes the decision on time_off_requests.decided_by and in
// the activity feed. Reusing one pair across recipients would credit whoever we
// minted it for rather than whoever clicked — a silent attribution bug that
// would only ever be noticed by a manager accused of a decision they didn't make.

vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local', SUPABASE_SERVICE_ROLE_KEY: 'test',
    BASE_URL: 'https://test.local', ANTHROPIC_API_KEY: 'test',
    SENDGRID_API_KEY: 'test', SENDGRID_FROM_EMAIL: 'a@test.local',
    EMAIL_ONLY: false,
  },
}));

const h = vi.hoisted(() => ({
  reads: {} as Record<string, unknown[]>,
  writes: [] as Array<{ table: string; op: string; payload?: Record<string, unknown> }>,
  emails: [] as Array<{ to: string; subject: string; html: string }>,
  smses: [] as Array<{ to: string; body: string }>,
  emailFailFor: null as string | null,
}));

vi.mock('../../db/client', () => ({
  supabase: {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'order', 'limit', 'in', 'not', 'is', 'like', 'gte', 'lte', 'gt', 'lt', 'neq', 'eq']) {
        chain[m] = () => chain;
      }
      chain.insert = (payload: Record<string, unknown>) => {
        h.writes.push({ table, op: 'insert', payload });
        return chain;
      };
      chain.update = (payload: Record<string, unknown>) => {
        h.writes.push({ table, op: 'update', payload });
        return chain;
      };
      chain.maybeSingle = async () => ({ data: (h.reads[table] ?? [])[0] ?? null, error: null });
      chain.single = async () => ({ data: (h.reads[table] ?? [])[0] ?? null, error: null });
      chain.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(res({ data: h.reads[table] ?? [], error: null }));
      return chain;
    },
  },
}));

vi.mock('../../messaging/email', () => ({
  sendEmail: vi.fn(async (m: { to: string; subject: string; html: string }) => {
    if (h.emailFailFor && m.to === h.emailFailFor) throw new Error('550 mailbox unavailable');
    h.emails.push(m);
  }),
}));

vi.mock('../../messaging/sms', () => ({
  sendSms: vi.fn(async (m: { to: string; body: string }) => { h.smses.push(m); }),
}));

// The LLM is never reached in these tests (stage1 = null), but the module must
// still import cleanly.
vi.mock('../../ai/claude', () => ({
  classifyIntent: vi.fn(), generateReply: vi.fn(),
}));

import { notifyManager } from '../time-off';

const EMPLOYEE = {
  id: 'emp-1', company_id: 'co-1', name: 'Bennet Ruiz',
  contact_phone: '+15550000001', contact_email: null, active: true,
} as never;

const PENDING = {
  employee_id: 'emp-1',
  start_date: '2026-09-02',
  end_date: '2026-09-04',
  reason: 'a wedding',
  channel: 'sms',
  sender: '+15550000001',
  time_off_type: 'full_day',
} as never;

function seedManagers(n: number, withPhones = false) {
  // Phase 2 (2026-08-18): a manager IS an employee. users.employee_id points at
  // the person record, and that record is the one place a phone number lives.
  h.reads['users'] = Array.from({ length: n }, (_, i) => ({
    id: `mgr-${i + 1}`,
    email: `mgr${i + 1}@club.test`,
    name: `Manager ${i + 1}`,
    role: i === 0 ? 'owner' : 'manager',
    employee_id: withPhones ? `mgr-emp-${i + 1}` : null,
  }));
  h.reads['employees'] = withPhones
    ? Array.from({ length: n }, (_, i) => ({
        id: `mgr-emp-${i + 1}`,
        name: `Manager ${i + 1}`,
        contact_email: `mgr${i + 1}@club.test`,
        contact_phone: `+1555000900${i + 1}`,
        active: true,
        notification_prefs: {},
      }))
    : [];
  h.reads['company_channels'] = [{ channel_value: '+15559999999' }];
}

const memoryTokens = () =>
  h.writes.filter(w => w.table === 'aegis_memory' && w.op === 'insert')
    .map(w => JSON.parse(String(w.payload!.content)) as { manager_user_id: string; action: string });

beforeEach(() => {
  h.reads = {};
  h.writes = [];
  h.emails = [];
  h.smses = [];
  h.emailFailFor = null;
});

describe('time-off request → manager notification fan-out', () => {
  it('THE FIX: emails EVERY manager/owner, not just the first', async () => {
    seedManagers(3);
    await notifyManager('co-1', EMPLOYEE, PENDING, 'req-1', null, null, null);

    expect(h.emails).toHaveLength(3);
    expect(h.emails.map(e => e.to).sort()).toEqual([
      'mgr1@club.test', 'mgr2@club.test', 'mgr3@club.test',
    ]);
  });

  it('gives each manager their OWN approve/deny token pair', async () => {
    seedManagers(3);
    await notifyManager('co-1', EMPLOYEE, PENDING, 'req-1', null, null, null);

    const tokens = memoryTokens();
    // 3 managers × (approve + deny)
    expect(tokens).toHaveLength(6);
    for (const id of ['mgr-1', 'mgr-2', 'mgr-3']) {
      const mine = tokens.filter(t => t.manager_user_id === id);
      expect(mine.map(t => t.action).sort()).toEqual(['approve', 'deny']);
    }
  });

  it('every token value is distinct, so a click identifies ONE manager', async () => {
    seedManagers(3);
    await notifyManager('co-1', EMPLOYEE, PENDING, 'req-1', null, null, null);

    const sources = h.writes
      .filter(w => w.table === 'aegis_memory' && w.op === 'insert')
      .map(w => String(w.payload!.source));
    expect(new Set(sources).size).toBe(sources.length);
  });

  it("the magic links in a manager's email carry that manager's own tokens", async () => {
    seedManagers(2);
    await notifyManager('co-1', EMPLOYEE, PENDING, 'req-1', null, null, null);

    // `&` may be rendered as `&amp;` in the HTML, so don't pin the separator.
    const tokenOf = (html: string, action: string) =>
      new RegExp(`action=${action}[^"'\\s]*?token=([0-9a-f-]+)`).exec(html)?.[1];

    const first = h.emails.find(e => e.to === 'mgr1@club.test')!;
    const second = h.emails.find(e => e.to === 'mgr2@club.test')!;

    const firstApprove = tokenOf(first.html, 'approve');
    const secondApprove = tokenOf(second.html, 'approve');
    expect(firstApprove).toBeTruthy();
    expect(secondApprove).toBeTruthy();
    // Two managers, two different links. Same link in both = attribution is a lie.
    expect(firstApprove).not.toBe(secondApprove);
    expect(tokenOf(first.html, 'deny')).not.toBe(firstApprove);
  });

  it('texts every manager who has a phone on file', async () => {
    seedManagers(3, true);
    await notifyManager('co-1', EMPLOYEE, PENDING, 'req-1', null, null, null);

    expect(h.smses.map(s => s.to).sort()).toEqual([
      '+15550009001', '+15550009002', '+15550009003',
    ]);
    expect(h.smses.every(s => /Bennet Ruiz/.test(s.body))).toBe(true);
  });

  it('a manager with no phone still gets the email — the SMS is additive', async () => {
    seedManagers(2);           // no employee rows → no phones
    await notifyManager('co-1', EMPLOYEE, PENDING, 'req-1', null, null, null);

    expect(h.emails).toHaveLength(2);
    expect(h.smses).toHaveLength(0);
  });

  it('one failed send does not silence the others', async () => {
    seedManagers(3);
    h.emailFailFor = 'mgr2@club.test';
    await notifyManager('co-1', EMPLOYEE, PENDING, 'req-1', null, null, null);

    // The bad address used to be the difference between "a manager was told" and
    // "nobody was told", because there was only ever one recipient.
    expect(h.emails.map(e => e.to).sort()).toEqual(['mgr1@club.test', 'mgr3@club.test']);
  });

  it('managers with no email on file are skipped, not crashed on', async () => {
    h.reads['users'] = [
      { id: 'mgr-1', email: null, name: 'No Email', role: 'manager', employee_id: null },
      { id: 'mgr-2', email: 'mgr2@club.test', name: 'Manager 2', role: 'owner', employee_id: null },
    ];
    h.reads['employees'] = [];
    h.reads['company_channels'] = [{ channel_value: '+15559999999' }];

    await notifyManager('co-1', EMPLOYEE, PENDING, 'req-1', null, null, null);
    expect(h.emails.map(e => e.to)).toEqual(['mgr2@club.test']);
  });

  it('no managers at all → no sends, no throw', async () => {
    h.reads['users'] = [];
    h.reads['employees'] = [];
    h.reads['company_channels'] = [];

    await expect(
      notifyManager('co-1', EMPLOYEE, PENDING, 'req-1', null, null, null),
    ).resolves.toBeUndefined();
    expect(h.emails).toHaveLength(0);
    expect(h.writes.filter(w => w.table === 'aegis_memory')).toHaveLength(0);
  });
});
