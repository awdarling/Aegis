import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── W-2 branch 3 (C-2): cancelling a swap actually withdraws it ──────────────
//
// Named after Maisey's Aug 17 thread (competition audit, 2026-08-26):
//   15:40 broadcast to 3 teammates → 15:41 "ok i don't need to swap it anymore"
//   → the outreach stayed LIVE → 15:44 Margaret's texted "i can take it" wasn't
//   understood, her "nevermind" was ignored, and 45 seconds later her tap on
//   the still-working pickup LINK committed her anyway → 15:46 her retraction
//   was told "no active swap request" while one sat in Jack's inbox → Jack
//   cleaned all of it up by hand at 16:28.
// And her 15:54 "undo all of my requests for today": two pending time-offs and
// one pending swap — one yes must cancel all three with ONE manager notice.

const h = vi.hoisted(() => {
  const inserts: Array<{ table: string; rows: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; values: Record<string, unknown>; filters: Record<string, unknown> }> = [];
  const deletes: Array<{ table: string; filters: Record<string, unknown> }> = [];
  const memoryStore = new Map<string, { id: string; content: string }>();
  let memSeq = 0;
  const state = {
    employees: [] as Array<Record<string, unknown>>,
    swapRows: [] as Array<Record<string, unknown>>,
    torRows: [] as Array<Record<string, unknown>>,
  };
  function makeBuilder(table: string) {
    const f: Record<string, unknown> = {};
    const likes: Array<[string, string]> = [];
    const memEntries = () => [...memoryStore.entries()].map(([source, row]) => ({ source, id: row.id, content: row.content }));
    const filteredMem = () => {
      let rows = memEntries();
      for (const [col, pat] of likes) {
        if (col === 'source') { const p = pat.replace(/%$/, ''); rows = rows.filter(r => r.source.startsWith(p)); }
        if (col === 'content') { const n = pat.replace(/^%|%$/g, ''); rows = rows.filter(r => r.content.includes(n)); }
      }
      if (f.source) rows = rows.filter(r => r.source === f.source);
      return rows;
    };
    const filteredSwapRows = () => {
      let rows = state.swapRows;
      if (f.id) rows = rows.filter(r => r.id === f.id);
      if (f.requesting_employee_id) rows = rows.filter(r => r.requesting_employee_id === f.requesting_employee_id);
      if (f.receiving_employee_id) rows = rows.filter(r => r.receiving_employee_id === f.receiving_employee_id);
      if (f.in_status) rows = rows.filter(r => (f.in_status as string[]).includes(String(r.status)));
      if (f.gte_created_at) rows = rows.filter(r => String(r.created_at ?? '') >= String(f.gte_created_at));
      return rows;
    };
    const filteredTorRows = () => {
      let rows = state.torRows;
      if (f.id) rows = rows.filter(r => r.id === f.id);
      if (f.employee_id) rows = rows.filter(r => r.employee_id === f.employee_id);
      if (f.in_status) rows = rows.filter(r => (f.in_status as string[]).includes(String(r.status)));
      return rows;
    };
    const one = () => {
      if (table === 'employees') return (f.id ? state.employees.find(e => e.id === f.id) : state.employees[0]) ?? null;
      if (table === 'companies') return { name: 'Watermark', timezone: 'America/Detroit' };
      if (table === 'company_channels') return { channel_value: '+16166164898' };
      if (table === 'aegis_memory') return filteredMem()[0] ?? null;
      if (table === 'swap_requests') return filteredSwapRows()[0] ?? null;
      if (table === 'time_off_requests') return filteredTorRows()[0] ?? null;
      return null;
    };
    const list = () => {
      if (table === 'employees') return state.employees;
      if (table === 'aegis_memory') return filteredMem();
      if (table === 'swap_requests') return filteredSwapRows();
      if (table === 'time_off_requests') return filteredTorRows();
      return [];
    };
    const b: Record<string, unknown> = {
      select() { return b; },
      eq(col: string, val: unknown) { f[col] = val; return b; },
      neq() { return b; }, or() { return b; }, ilike() { return b; },
      like(col: string, pat: string) { likes.push([col, pat]); return b; },
      in(col: string, vals: unknown) { f[`in_${col}`] = vals; return b; },
      is() { return b; },
      lte() { return b; },
      gte(col: string, val: unknown) { f[`gte_${col}`] = val; return b; },
      lt() { return b; }, gt() { return b; },
      order() { return b; }, limit() { return b; },
      insert(rows: Record<string, unknown>) {
        inserts.push({ table, rows });
        if (table === 'aegis_memory') memoryStore.set(String(rows.source), { id: `mem-${++memSeq}`, content: String(rows.content) });
        return b;
      },
      update(values: Record<string, unknown>) {
        return {
          eq(col: string, val: unknown) { f[col] = val; return this; },
          then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
            updates.push({ table, values, filters: { ...f } });
            // Apply to in-memory rows so later reads see the change.
            if (table === 'swap_requests') {
              for (const r of state.swapRows) if (r.id === f.id) Object.assign(r, values);
            }
            if (table === 'time_off_requests') {
              for (const r of state.torRows) if (r.id === f.id) Object.assign(r, values);
            }
            return Promise.resolve({ data: null, error: null }).then(onF, onR);
          },
        };
      },
      delete() {
        const d = {
          eq(col: string, val: unknown) {
            f[col] = val;
            if (table === 'aegis_memory' && col === 'source') memoryStore.delete(String(val));
            if (table === 'aegis_memory' && col === 'id') {
              for (const [src, row] of memoryStore.entries()) if (row.id === val) memoryStore.delete(src);
            }
            return d;
          },
          like(col: string, pat: string) { likes.push([col, pat]); return d; },
          in() { return d; },
          then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
            deletes.push({ table, filters: { ...f, likes: likes.map(l => l.join('~')) } as Record<string, unknown> });
            if (table === 'aegis_memory' && likes.length > 0) {
              for (const r of filteredMem()) memoryStore.delete(r.source);
            }
            return Promise.resolve({ data: null, error: null }).then(onF, onR);
          },
        };
        return d;
      },
      maybeSingle() { return Promise.resolve({ data: one(), error: null }); },
      single() { return Promise.resolve({ data: one(), error: null }); },
      then(onF: (v: { data: unknown; error: null }) => unknown, onR?: (e: unknown) => unknown) {
        return Promise.resolve({ data: list(), error: null }).then(onF, onR);
      },
    };
    return b;
  }
  return {
    inserts, updates, deletes, state, memoryStore, makeBuilder,
    createMock: vi.fn(),
    classifyMock: vi.fn(async () => ({ intent: 'unknown', confidence: 'low', extracted: {} })),
    generateMock: vi.fn(async () => '{}'),
    replyMock: vi.fn(async () => {}),
    sendSmsMock: vi.fn(async () => true),
    sendEmailMock: vi.fn(async () => {}),
    resolutionNoticeMock: vi.fn(async () => ({ texted: 1, emailed: 0, skipped: 0 })),
  };
});

vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: h.createMock }; } }));
vi.mock('../../ai/claude', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ai/claude')>();
  return { ...actual, withAnthropicRetry: (fn: () => unknown) => fn(), classifyIntent: h.classifyMock, generateReply: h.generateMock };
});
vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: false, ANTHROPIC_API_KEY: 'x', SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', SENDGRID_FROM_EMAIL: 'a@b.c', SENDGRID_FROM_NAME: 'Aegis', BASE_URL: 'http://x', NODE_ENV: 'test' } }));
vi.mock('../../db/client', () => ({ supabase: { from: (t: string) => h.makeBuilder(t) } }));
vi.mock('../../messaging/reply', () => ({ reply: h.replyMock, sendInThreadAck: vi.fn(async () => {}), normalizeReSubject: (s: string) => s }));
vi.mock('../../messaging/sms', () => ({ sendSms: h.sendSmsMock, getTenantSmsNumber: vi.fn(async () => null) }));
vi.mock('../../messaging/email', () => ({ sendEmail: h.sendEmailMock }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock('../../messaging/manager-resolution-notice', () => ({ sendManagerResolutionNotice: h.resolutionNoticeMock }));

import { handleCancelSwap, handleRespondSwap, commitSwapPickup, withdrawSwap, type SwapBroadcast } from '../shift-swap';
import { handleCancelTimeOff, handleTimeOffCancelConfirmation, handlePendingTimeOffConfirmation } from '../time-off';
import { looksLikeSwapCancel, applyCancelSwapBackstop } from '../../ai/claude';
import { todayInTimezone, addDays } from '../../lib/tenant-date';
import type { InboundMessage, VerifiedContact } from '../../security/types';

const COMPANY = 'c-wm';
const AEGIS = '+16166164898';
const TODAY = todayInTimezone('America/Detroit');

const MAISEY = { id: 'maisey', name: 'Maisey Pell', contact_phone: '+16165550104', contact_email: null, company_id: COMPANY, primary_role: 'Lifeguard', active: true, qualified_roles: ['Lifeguard'], max_weekly_hours: 40 };
const MARGARET = { id: 'margaret', name: 'Margaret Holt', contact_phone: '+16165550105', contact_email: null, company_id: COMPANY, primary_role: 'Lifeguard', active: true, qualified_roles: ['Lifeguard'], max_weekly_hours: 40 };
const ROSA = { id: 'rosa', name: 'Rosa Alvarez', contact_phone: '+16165550106', contact_email: null, company_id: COMPANY, primary_role: 'Lifeguard', active: true, qualified_roles: ['Lifeguard'], max_weekly_hours: 40 };

const contactFor = (e: { id: string; name: string; contact_phone: string }): VerifiedContact =>
  ({ role: 'employee', company_id: COMPANY, employee_id: e.id, user_id: null, name: e.name, matched_identifier: e.contact_phone, channel: 'sms' });
const msgFrom = (e: { contact_phone: string }, body: string): InboundMessage =>
  ({ sender: e.contact_phone, recipient: AEGIS, body, channel: 'sms' });

const replies = () => h.replyMock.mock.calls.map(c => c[2] as string);
const texts = () => h.sendSmsMock.mock.calls.map(c => (c[0] as { body: string; to: string }));

function seedBroadcast(overrides?: Partial<SwapBroadcast>): void {
  const b: SwapBroadcast = {
    requester_id: 'maisey', requester_name: 'Maisey Pell', company_id: COMPANY,
    requester_channel: 'sms', requester_sender: MAISEY.contact_phone, requester_recipient: AEGIS,
    shift_date: addDays(TODAY, 2), shift_name: 'AM Weekday', role: 'Lifeguard',
    shift_start: '11:00:00', shift_end: '15:30:00', schedule_id: 'sched-1',
    willing_dates: [], status: 'open', contacted_ids: ['margaret', 'rosa'],
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
  h.memoryStore.set('swap_broadcast:maisey', { id: 'mem-b1', content: JSON.stringify(b) });
}

beforeEach(() => {
  h.inserts.length = 0;
  h.updates.length = 0;
  h.deletes.length = 0;
  h.memoryStore.clear();
  h.replyMock.mockClear();
  h.sendSmsMock.mockClear();
  h.sendEmailMock.mockClear();
  h.resolutionNoticeMock.mockClear();
  h.classifyMock.mockReset();
  h.classifyMock.mockResolvedValue({ intent: 'unknown', confidence: 'low', extracted: {} });
  h.state.employees = [MAISEY, MARGARET, ROSA];
  h.state.swapRows = [];
  h.state.torRows = [];
});

describe("Maisey's Aug 17 thread, step by step (C-2)", () => {
  it('"ok i don\'t need to swap it anymore" closes the broadcast and tells every contacted teammate', async () => {
    seedBroadcast();
    await handleCancelSwap(msgFrom(MAISEY, "ok i don't need to swap it anymore"), contactFor(MAISEY), {});

    const stored = JSON.parse(h.memoryStore.get('swap_broadcast:maisey')!.content) as SwapBroadcast;
    expect(stored.status).toBe('withdrawn');
    const tos = texts().filter(t => t.to !== MAISEY.contact_phone).map(t => t.to).sort();
    expect(tos).toEqual([MARGARET.contact_phone, ROSA.contact_phone].sort());
    expect(texts().find(t => t.to === MARGARET.contact_phone)!.body).toMatch(/no longer needs the AM Weekday shift/i);
    expect(replies().join('\n')).toMatch(/called off/i);
    // Nothing was pending with the manager, so no manager notice fires.
    expect(h.resolutionNoticeMock).not.toHaveBeenCalled();
  });

  it("Margaret's LINK tap after the withdrawal is refused kindly — no swap_requests row, no manager email", async () => {
    seedBroadcast({ status: 'withdrawn' });
    const result = await commitSwapPickup({ company_id: COMPANY, requester_id: 'maisey', receiver_id: 'margaret' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/doesn't need that shift covered anymore/i);
    expect(h.inserts.some(i => i.table === 'swap_requests')).toBe(false);
    expect(h.sendEmailMock).not.toHaveBeenCalled();
  });

  it('Margaret\'s texted "i can take it" is UNDERSTOOD: commits while open, refused kindly after withdrawal', async () => {
    // After the withdrawal:
    seedBroadcast({ status: 'withdrawn' });
    await handleRespondSwap(msgFrom(MARGARET, 'i can take it'), contactFor(MARGARET), {}, 'accept');
    expect(replies()[0]).toMatch(/doesn't need that shift covered anymore/i);
    expect(h.inserts.some(i => i.table === 'swap_requests')).toBe(false);

    // While still open, the same text COMMITS (first-commit-wins, same guarded path as the link):
    h.replyMock.mockClear();
    seedBroadcast({ status: 'open' });
    await handleRespondSwap(msgFrom(MARGARET, 'i can take it'), contactFor(MARGARET), {}, 'accept');
    expect(h.inserts.some(i => i.table === 'swap_requests')).toBe(true);
    const locked = JSON.parse(h.memoryStore.get('swap_broadcast:maisey')!.content) as SwapBroadcast;
    expect(locked.status).toBe('locked');
  });

  it('"i can\'t actually swap maiseys shift" AFTER accepting cancels the pending row and tells the manager + Maisey', async () => {
    h.state.swapRows = [{
      id: 'swap-1', company_id: COMPANY, requesting_employee_id: 'maisey', receiving_employee_id: 'margaret',
      shift_date: addDays(TODAY, 2), shift_name: 'AM Weekday', status: 'pending_manager', created_at: new Date().toISOString(),
    }];
    await handleRespondSwap(msgFrom(MARGARET, "i can't actually swap maiseys shift"), contactFor(MARGARET), {}, 'decline');
    const upd = h.updates.find(u => u.table === 'swap_requests');
    expect(upd).toBeDefined();
    expect(upd!.values.status).toBe('cancelled');
    expect(h.resolutionNoticeMock).toHaveBeenCalledTimes(1);
    // Maisey is told the shift still needs covering; Margaret gets a warm receipt.
    expect(texts().some(t => t.to === MAISEY.contact_phone && /can't take your AM Weekday shift/.test(t.body))).toBe(true);
    expect(replies().join('\n')).toMatch(/taken you off/i);
    // The manager's live approve/deny tokens for that row are retired.
    expect(h.deletes.some(d => d.table === 'aegis_memory' && String(d.filters.likes).includes('swap-1'))).toBe(true);
  });
});

describe('"undo all of my requests for today" — 2 time-offs + 1 swap, one yes, ONE notice (C-2/C-6)', () => {
  it('sweeps the swaps into the same confirm and cancels everything on the one yes', async () => {
    const now = new Date().toISOString();
    h.state.torRows = [
      { id: 'tor-1', employee_id: 'maisey', company_id: COMPANY, start_date: addDays(TODAY, 4), end_date: addDays(TODAY, 4), status: 'pending', requested_at: now },
      { id: 'tor-2', employee_id: 'maisey', company_id: COMPANY, start_date: addDays(TODAY, 6), end_date: addDays(TODAY, 6), status: 'pending', requested_at: now },
    ];
    h.state.swapRows = [{
      id: 'swap-9', company_id: COMPANY, requesting_employee_id: 'maisey', receiving_employee_id: 'margaret',
      shift_date: addDays(TODAY, 2), shift_name: 'AM Weekday', status: 'pending_manager', created_at: now,
    }];

    await handleCancelTimeOff(msgFrom(MAISEY, 'undo all of my requests for today'), contactFor(MAISEY), { date: null });
    const ask = replies()[0];
    expect(ask).toMatch(/are you sure/i);
    expect(ask).toMatch(/all 3 of these/i);
    expect(ask).toMatch(/AM Weekday/);

    // The parked confirmation:
    const pendingCancel = h.inserts
      .filter(i => i.table === 'aegis_memory' && String(i.rows.source).startsWith('to_cancel_pending:'))
      .map(i => JSON.parse(String(i.rows.content)) as Record<string, unknown>)[0];
    expect(pendingCancel).toBeDefined();
    expect(pendingCancel.swap_sweep).toBeDefined();
    expect((pendingCancel.targets as unknown[]).length).toBe(2);

    h.replyMock.mockClear();
    await handleTimeOffCancelConfirmation(
      msgFrom(MAISEY, 'yes'),
      contactFor(MAISEY),
      { ...(pendingCancel as never), _memory_id: 'mem-x' } as never,
    );

    // Both time-off rows and the swap row are cancelled.
    const torUpdates = h.updates.filter(u => u.table === 'time_off_requests' && u.values.status === 'cancelled');
    expect(torUpdates.length).toBe(2);
    const swapUpdates = h.updates.filter(u => u.table === 'swap_requests' && u.values.status === 'cancelled');
    expect(swapUpdates.length).toBe(1);
    // ONE manager notice for the whole sweep.
    expect(h.resolutionNoticeMock).toHaveBeenCalledTimes(1);
    const notice = h.resolutionNoticeMock.mock.calls[0][0] as { summary: string };
    expect(notice.summary).toMatch(/withdrew/i);
    expect(replies().join('\n')).toMatch(/Done —/);
  });
});

describe('routing (C-2 step 3 cancelled the wrong thing)', () => {
  it('looksLikeSwapCancel + backstop send swap language to cancel_swap, never cancel_time_off', () => {
    expect(looksLikeSwapCancel("ok i don't need to swap it anymore")).toBe(true);
    expect(looksLikeSwapCancel("i don't need it covered anymore")).toBe(true);
    expect(looksLikeSwapCancel('scrap the swap')).toBe(true);
    expect(looksLikeSwapCancel('cancel the swap request')).toBe(true);
    expect(looksLikeSwapCancel('cancel my time off on Aug 1')).toBe(false);
    expect(looksLikeSwapCancel('undo all of my requests for today')).toBe(false);

    const out = applyCancelSwapBackstop({ intent: 'general_question', confidence: 'high', extracted: {} }, "i don't need it covered anymore");
    expect(out.intent).toBe('cancel_swap');
    const stays = applyCancelSwapBackstop({ intent: 'cancel_time_off', confidence: 'high', extracted: { date: null } }, 'undo all of my requests for today');
    expect(stays.intent).toBe('cancel_time_off');
  });

  it('at the time-off confirm gate, "i don\'t need it covered anymore" withdraws the SWAP and keeps the time-off draft', async () => {
    seedBroadcast();
    const gate = {
      employee_id: 'maisey', start_date: addDays(TODAY, 5), end_date: addDays(TODAY, 5),
      reason: null, channel: 'sms', sender: MAISEY.contact_phone, recipient: AEGIS,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      time_off_type: 'full_day', partial_days: null,
    };
    await handlePendingTimeOffConfirmation(msgFrom(MAISEY, "i don't need it covered anymore"), contactFor(MAISEY), gate as never);
    const stored = JSON.parse(h.memoryStore.get('swap_broadcast:maisey')!.content) as SwapBroadcast;
    expect(stored.status).toBe('withdrawn');
    expect(replies().join('\n')).toMatch(/called off/i);
    expect(replies().join('\n')).not.toMatch(/scrapped that time-off request/i);
    // The time-off draft's gate row was never deleted.
    expect(h.deletes.some(d => String(d.filters.source ?? '').startsWith('pending_to:'))).toBe(false);
  });
});

describe('withdrawSwap directly', () => {
  it('returns empty when nothing is in flight, and handleCancelSwap says so honestly', async () => {
    const { items } = await withdrawSwap({ companyId: COMPANY, requesterId: 'maisey', requesterName: 'Maisey Pell' });
    expect(items.length).toBe(0);
    await handleCancelSwap(msgFrom(MAISEY, 'cancel the swap'), contactFor(MAISEY), {});
    expect(replies()[0]).toMatch(/don't see a swap of yours in flight/i);
  });
});
