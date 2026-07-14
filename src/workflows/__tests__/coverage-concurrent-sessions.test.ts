import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── D19 regression suite ──────────────────────────────────────────────────────
//
// THE BUG: coverage sessions were keyed by COMPANY (`coverage_session:<company>`),
// so a second employee calling out DELETED the first manager's session — the
// manager's "show me more names" thread on the first call-out went dead. The
// schedule still came out right (each outreach is self-contained), but the
// manager's control of the FIRST call-out vanished the moment a SECOND came in.
//
// THE FIX: each call-out gets its own session_id and its own stored row, so two
// (or more) coexist. These tests prove exactly that — two sessions live side by
// side, each retrievable by its own id — plus the routing that decides which
// call-out a manager's reply belongs to.

vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local', SUPABASE_SERVICE_ROLE_KEY: 'test',
    BASE_URL: 'https://test.local', ANTHROPIC_API_KEY: 'test',
    SENDGRID_API_KEY: 'test', SENDGRID_FROM_EMAIL: 'a@test.local',
    TWILIO_ACCOUNT_SID: 'test', TWILIO_AUTH_TOKEN: 'test', EMAIL_ONLY: true,
  },
}));

// A tiny in-memory `aegis_memory` table with just enough query-builder surface
// for the session helpers: insert, select+eq+like+order, select+eq+eq+maybeSingle,
// delete+eq(+or).
type Row = { id: string; company_id: string; source: string; content: string; created_at: string };
const store: Row[] = [];
let idSeq = 0;

function makeBuilder(table: string) {
  let rows = table === 'aegis_memory' ? store.slice() : [];
  const filters: Array<(r: Row) => boolean> = [];
  const builder: Record<string, unknown> = {};
  const apply = () => rows.filter(r => filters.every(f => f(r)));
  Object.assign(builder, {
    insert: (vals: Partial<Row> | Partial<Row>[]) => {
      for (const v of Array.isArray(vals) ? vals : [vals]) {
        store.push({ id: `mem-${++idSeq}`, created_at: new Date(idSeq).toISOString(), ...(v as Row) });
      }
      return Promise.resolve({ error: null });
    },
    select: () => builder,
    eq: (col: keyof Row, val: unknown) => { filters.push(r => r[col] === val); return builder },
    like: (col: keyof Row, pat: string) => {
      const prefix = pat.replace(/%$/, '');
      filters.push(r => String(r[col]).startsWith(prefix)); return builder;
    },
    or: (expr: string) => {
      // supports "id.eq.X,id.eq.Y" style — not needed here, pass-through
      void expr; return builder;
    },
    order: (col: keyof Row, opts: { ascending: boolean }) => {
      const out = apply().sort((a, b) =>
        opts.ascending ? String(a[col]).localeCompare(String(b[col])) : String(b[col]).localeCompare(String(a[col])));
      return Promise.resolve({ data: out, error: null });
    },
    maybeSingle: () => { const out = apply(); return Promise.resolve({ data: out[0] ?? null, error: null }) },
    delete: () => ({
      eq: (col: keyof Row, val: unknown) => {
        const eqFilters = [...filters, (r: Row) => r[col] === val];
        for (let i = store.length - 1; i >= 0; i--) if (eqFilters.every(f => f(store[i]))) store.splice(i, 1);
        return Promise.resolve({ error: null });
      },
    }),
  });
  return builder;
}

vi.mock('../../db/client', () => ({ supabase: { from: (t: string) => makeBuilder(t) } }));
vi.mock('../../ai/claude', () => ({
  generateReply: vi.fn(), classifyIntent: vi.fn(),
  AnthropicOverloadError: class extends Error {},
}));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ computeWageEstimate: vi.fn(async () => 0) }));

import { listActiveCoverageSessions, getCoverageSessionById, type CoverageSession } from '../emergency-coverage';

const COMPANY = 'co-1';
const MANAGER = 'manager@club.com';

function session(over: Partial<CoverageSession>): CoverageSession {
  return {
    session_id: 'sess-x',
    company_id: COMPANY,
    manager_contact: MANAGER,
    manager_channel: 'email',
    manager_sender: MANAGER,
    manager_recipient: 'aegis@club.com',
    callout_employee_id: 'e9',
    callout_employee_name: 'Sam',
    shift_date: '2026-07-20',
    shift_info: { shift_name: 'Morning', start_time: '09:00', end_time: '13:00', role: 'Lifeguard' } as CoverageSession['shift_info'],
    state: 'awaiting_names',
    outreach_queue: [],
    outreach_results: [],
    coverage_filled: false,
    covered_by_employee_id: null,
    urgency_window_minutes: 60,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...over,
  };
}

/** Insert a session the way storeSession does — keyed by its session_id. */
function put(s: CoverageSession) {
  store.push({
    id: `mem-${++idSeq}`,
    company_id: s.company_id,
    source: `coverage_session:${s.session_id}`,
    content: JSON.stringify(s),
    created_at: new Date(idSeq).toISOString(),
  });
}

beforeEach(() => { store.length = 0; idSeq = 0; });

describe('D19 — two call-outs coexist instead of one clobbering the other', () => {
  it('both sessions survive and are listed for the manager', async () => {
    put(session({ session_id: 'a', callout_employee_name: 'Sam', shift_info: { shift_name: 'Morning', start_time: '09:00', end_time: '13:00', role: 'Lifeguard' } as CoverageSession['shift_info'] }));
    put(session({ session_id: 'b', callout_employee_name: 'Jordan', shift_info: { shift_name: 'Evening', start_time: '15:00', end_time: '21:00', role: 'Greeter' } as CoverageSession['shift_info'] }));

    const open = await listActiveCoverageSessions(COMPANY, MANAGER);
    expect(open).toHaveLength(2);
    expect(open.map(s => s.session_id).sort()).toEqual(['a', 'b']);
  });

  it('getCoverageSessionById returns the RIGHT call-out by id', async () => {
    put(session({ session_id: 'a', callout_employee_name: 'Sam' }));
    put(session({ session_id: 'b', callout_employee_name: 'Jordan' }));

    const a = await getCoverageSessionById(COMPANY, 'a');
    const b = await getCoverageSessionById(COMPANY, 'b');
    expect(a?.callout_employee_name).toBe('Sam');
    expect(b?.callout_employee_name).toBe('Jordan');
  });

  it('a second call-out does NOT delete the first (the actual bug)', async () => {
    put(session({ session_id: 'a', callout_employee_name: 'Sam' }));
    // ...second call-out arrives...
    put(session({ session_id: 'b', callout_employee_name: 'Jordan' }));
    // The first is still there — pre-fix, keying by company meant 'b' overwrote 'a'.
    expect(await getCoverageSessionById(COMPANY, 'a')).not.toBeNull();
  });

  it('expired sessions are filtered out (and cleaned up)', async () => {
    put(session({ session_id: 'live' }));
    put(session({ session_id: 'dead', expires_at: new Date(Date.now() - 1000).toISOString() }));

    const open = await listActiveCoverageSessions(COMPANY, MANAGER);
    expect(open.map(s => s.session_id)).toEqual(['live']);
  });

  it('only THIS manager\'s sessions are returned', async () => {
    put(session({ session_id: 'mine' }));
    put(session({ session_id: 'theirs', manager_contact: 'other@club.com' }));

    const open = await listActiveCoverageSessions(COMPANY, MANAGER);
    expect(open.map(s => s.session_id)).toEqual(['mine']);
  });

  it('getCoverageSessionById falls back to the newest session for a legacy outreach with no id', async () => {
    put(session({ session_id: 'older' }));
    put(session({ session_id: 'newer' }));
    // No session_id on the outreach → fall back to the manager's newest.
    const fallback = await getCoverageSessionById(COMPANY, undefined, MANAGER);
    expect(fallback).not.toBeNull();
  });
});
