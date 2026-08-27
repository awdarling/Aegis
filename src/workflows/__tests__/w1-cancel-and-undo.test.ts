import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── W-1 branch 4 (C-6, J-1c, J-5): cancel handles pending rows + referents; the
//    free-form answer never promises; blocked-swap copy speaks to "you" ─────────
//
// Named after the transcripts they fix (audits of 2026-08-26):
//   • Mia Shaffer, Aug 11 — "Cancel the pending one" (thirty seconds after Aegis
//     listed it) was told "I don't have any pending time-off requests on file".
//   • Maisey Pell, Aug 17 — "Undo all of my requests for today": two pending
//     time-offs and a pending swap made that hour; Aegis read "today" as ABOUT
//     Aug 17 and found nothing. (Swaps are W-2; the two time-offs are here.)
//   • Mya Vanderzwaag, Aug 14 — "you just told me you would pull back the
//     approved time off request for August 21" → the free-form answer promised
//     "just confirm and I'll get it handled" with no workflow behind it. Now it
//     routes to the cancel intent, and the free-form prompt forbids promises.
//   • Mya, same thread — "Mya Vanderzwaag has approved time off on that date"
//     said TO Mya → "you have approved time off that day".

vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local', SUPABASE_SERVICE_ROLE_KEY: 'test',
    BASE_URL: 'https://test.local', ANTHROPIC_API_KEY: 'test',
    SENDGRID_API_KEY: 'test', SENDGRID_FROM_EMAIL: 'a@test.local',
    EMAIL_ONLY: true,
  },
}));

const h = vi.hoisted(() => ({
  reads: {} as Record<string, unknown[]>,
  writes: [] as Array<{ table: string; op: string; payload?: Record<string, unknown>; filters: Record<string, unknown> }>,
  replies: [] as string[],
  notices: [] as Array<Record<string, unknown>>,
  activity: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../db/client', () => ({
  supabase: {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'order', 'limit', 'in', 'not', 'is', 'like', 'gte', 'lte', 'gt', 'lt', 'neq']) {
        chain[m] = (a?: unknown, b?: unknown) => { if (typeof a === 'string') filters[`${m}:${a}`] = b; return chain; };
      }
      chain.eq = (col: string, val: unknown) => { filters[col] = val; return chain; };
      chain.insert = (payload: Record<string, unknown>) => { h.writes.push({ table, op: 'insert', payload, filters: { ...filters } }); return chain; };
      chain.update = (payload: Record<string, unknown>) => { h.writes.push({ table, op: 'update', payload, filters }); return chain; };
      chain.delete = () => { h.writes.push({ table, op: 'delete', filters }); return chain; };
      const rowById = () => {
        const rows = (h.reads[table] ?? []) as Array<Record<string, unknown>>;
        if (filters.id) return rows.find(r => r.id === filters.id) ?? null;
        if (table === 'companies') return { timezone: 'America/Detroit' };
        return rows[0] ?? null;
      };
      chain.maybeSingle = async () => ({ data: rowById(), error: null });
      chain.single = async () => ({ data: rowById(), error: null });
      chain.then = (res: (v: unknown) => unknown) => Promise.resolve(res({ data: h.reads[table] ?? [], error: null }));
      return chain;
    },
  },
}));
vi.mock('../../messaging/reply', () => ({
  reply: vi.fn(async (_c: unknown, _m: unknown, text: string) => { h.replies.push(text); }),
  normalizeReSubject: (s: string) => s,
}));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn(async () => true) }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn(async () => true) }));
vi.mock('../../messaging/manager-resolution-notice', () => ({
  sendManagerResolutionNotice: vi.fn(async (o: Record<string, unknown>) => { h.notices.push(o); return { texted: 1, emailed: 0, skipped: 0 }; }),
}));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn(async (o: Record<string, unknown>) => { h.activity.push(o); }) }));
vi.mock('../../lib/schedule-simulator', () => ({ runSimulation: vi.fn(), getWeekBounds: vi.fn(), loadTimeOffPolicies: vi.fn(async () => []), computeWageEstimate: vi.fn() }));
vi.mock('../../lib/time-off-policies', () => ({ computeTimeOffViolations: vi.fn() }));
vi.mock('../../router/interrupt', () => ({ employeeInterruptIntent: vi.fn(async () => null) }));
vi.mock('../../router/intent-router', () => ({ routeIntent: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));

import {
  handleCancelTimeOff,
  handleTimeOffCancelConfirmation,
  getPendingTimeOffCancel,
  parseCancelReferent,
  resolveCancelTargets,
} from '../time-off';
import { applyCancelTimeOffBackstop, looksLikeTimeOffCancel, type ClassifyResult } from '../../ai/claude';
import { reasonAddressedToYou } from '../shift-swap';
import { buildOperationalAnswerSystem } from '../operational-query';
import { todayInTimezone } from '../../lib/tenant-date';
import type { InboundMessage, VerifiedContact } from '../../security/types';

const COMPANY = 'co-wm';
const contactFor = (id: string, name: string): VerifiedContact =>
  ({ role: 'employee', company_id: COMPANY, employee_id: id, user_id: null, name, matched_identifier: '+16165551212', channel: 'sms' });
const msg = (body: string): InboundMessage => ({ sender: '+16165551212', recipient: '+16166164898', body, channel: 'sms', raw_subject: null, thread_id: null });
const last = () => h.replies[h.replies.length - 1];
const TODAY = todayInTimezone('America/Detroit');
const nowIso = () => new Date().toISOString();
const daysAgoIso = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const future = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function parked(employeeId: string) {
  const ins = [...h.writes].reverse().find(w => w.table === 'aegis_memory' && w.op === 'insert' && String(w.payload!.source) === `to_cancel_pending:${employeeId}`);
  return ins ? (JSON.parse(ins.payload!.content as string) as Record<string, unknown> & { targets: Array<{ id: string }> }) : null;
}

beforeEach(() => {
  h.reads = {};
  h.writes.length = 0;
  h.replies.length = 0;
  h.notices.length = 0;
  h.activity.length = 0;
});

describe('Mia Shaffer, Aug 11 — "Cancel the pending one"', () => {
  const PENDING = { id: 'to-pending', status: 'pending', start_date: future(6), end_date: future(10), requested_at: nowIso() };
  const contact = contactFor('mia', 'Mia Shaffer');

  it('finds the pending request and asks to withdraw it — never "nothing on file"', async () => {
    h.reads['time_off_requests'] = [PENDING];
    await handleCancelTimeOff(msg('Cancel the pending one'), contact, { date: null });
    expect(last()).toMatch(/withdraw your time-off request/i);
    expect(last()).toMatch(/still waiting on your manager/i);
    expect(last()).not.toMatch(/don't have any/i);
    const p = await parked('mia');
    expect(p!.targets.map(t => t.id)).toEqual(['to-pending']);
  });

  it('"yes" withdraws it (guarded on status = pending), retires the approve links, tells the manager once', async () => {
    h.reads['time_off_requests'] = [PENDING];
    await handleCancelTimeOff(msg('Cancel the pending one'), contact, { date: null });
    const p = (await parked('mia'))!;
    await handleTimeOffCancelConfirmation(msg('yes'), contact, { ...(p as never), _memory_id: 'm1' });
    const upd = h.writes.find(w => w.table === 'time_off_requests' && w.op === 'update')!;
    expect(upd.payload!.status).toBe('cancelled');
    expect(upd.filters.status).toBe('pending');
    expect(h.writes.some(w => w.table === 'aegis_memory' && w.op === 'delete' && String(w.filters['like:source']).startsWith('decision_token'))).toBe(true);
    expect(last()).toMatch(/^Done — /);
    expect(last()).not.toMatch(/back on the schedule/); // it was never approved
    expect(h.notices.length).toBe(1);
    expect(String(h.notices[0].summary)).toMatch(/Mia Shaffer withdrew their pending request/);
  });
});

describe('Maisey Pell, Aug 17 — "Undo all of my requests for today"', () => {
  const contact = contactFor('maisey', 'Maisey Pell');
  const A = { id: 'to-a', status: 'pending', start_date: future(1), end_date: future(1), requested_at: nowIso() };
  const B = { id: 'to-b', status: 'pending', start_date: future(3), end_date: future(4), requested_at: nowIso() };
  const OLD = { id: 'to-old', status: 'approved', start_date: future(20), end_date: future(22), requested_at: daysAgoIso(9) };

  it('"today" means MADE today: both of today\'s requests are offered, the older approved one is not', async () => {
    h.reads['time_off_requests'] = [A, B, OLD];
    await handleCancelTimeOff(msg('Undo all of my requests for today'), contact, { date: null });
    const p = (await parked('maisey'))!;
    expect(p.targets.map(t => t.id).sort()).toEqual(['to-a', 'to-b']);
    expect(last()).toMatch(/cancel all 2 of these/i);
  });

  it('"yes" cancels both and the manager hears about it once', async () => {
    h.reads['time_off_requests'] = [A, B, OLD];
    await handleCancelTimeOff(msg('Undo all of my requests for today'), contact, { date: null });
    const p = (await parked('maisey'))!;
    await handleTimeOffCancelConfirmation(msg('yes please'), contact, { ...(p as never), _memory_id: 'm1' });
    const updates = h.writes.filter(w => w.table === 'time_off_requests' && w.op === 'update');
    expect(updates.map(u => u.filters.id).sort()).toEqual(['to-a', 'to-b']);
    expect(h.notices.length).toBe(1);
    expect(last()).toMatch(/are cancelled/);
  });

  it('with nothing made today, says so and lists what exists instead of "none"', async () => {
    h.reads['time_off_requests'] = [OLD];
    await handleCancelTimeOff(msg('undo everything from today'), contact, { date: null });
    expect(last()).toMatch(/didn't put in any time-off requests today/i);
    expect(last()).toMatch(/What you have coming up/);
  });
});

describe('referents', () => {
  it('parseCancelReferent reads the phrases', () => {
    expect(parseCancelReferent('Cancel the pending one')).toMatchObject({ pendingOnly: true, all: false });
    expect(parseCancelReferent('Undo all of my requests for today')).toMatchObject({ all: true, madeToday: true });
    expect(parseCancelReferent('cancel that one')).toMatchObject({ latest: true });
    expect(parseCancelReferent('cancel both')).toMatchObject({ all: true });
  });
  it('"that one" with several on file → the most recently made; nothing said with several → ask', () => {
    const rows = [
      { id: 'x', status: 'approved' as const, start_date: future(2), end_date: future(2), requested_at: daysAgoIso(3) },
      { id: 'y', status: 'pending' as const, start_date: future(5), end_date: future(5), requested_at: nowIso() },
    ];
    expect(resolveCancelTargets({ candidates: rows, date: null, referent: parseCancelReferent('cancel that one'), today: TODAY, timezone: 'America/Detroit' })).toMatchObject({ kind: 'targets', rows: [rows[1]] });
    expect(resolveCancelTargets({ candidates: rows, date: null, referent: parseCancelReferent('cancel my time off'), today: TODAY, timezone: 'America/Detroit' }).kind).toBe('ask');
    expect(resolveCancelTargets({ candidates: rows, date: rows[0].start_date, referent: parseCancelReferent('cancel my time off on that date'), today: TODAY, timezone: 'America/Detroit' })).toMatchObject({ kind: 'targets', rows: [rows[0]] });
  });
});

describe('Mya Vanderzwaag, Aug 14 — "you just told me you would pull back the approved time off request for August 21"', () => {
  it('routes to cancel_time_off, not the free-form answer', () => {
    const general: ClassifyResult = { intent: 'general_question', confidence: 'medium', extracted: {} };
    const out = applyCancelTimeOffBackstop(general, 'you just told me you would pull back the approved time off request for August 21');
    expect(out.intent).toBe('cancel_time_off');
  });
  it('a bare "cancel that" (backing out mid-flow) and "never mind" stay where they were', () => {
    expect(looksLikeTimeOffCancel('cancel that')).toBe(false);
    expect(looksLikeTimeOffCancel('never mind')).toBe(false);
    expect(looksLikeTimeOffCancel('can you undo my time off request?')).toBe(true);
    expect(looksLikeTimeOffCancel('withdraw that one')).toBe(true);
  });
  it('a confident specific intent is never overridden', () => {
    const swap: ClassifyResult = { intent: 'initiate_swap', confidence: 'high', extracted: {} };
    expect(applyCancelTimeOffBackstop(swap, 'cancel my time off request').intent).toBe('initiate_swap');
  });
  it('the free-form answer prompt forbids promising a state change and points at the right message to send', () => {
    const sys = buildOperationalAnswerSystem('employee', 'You are Aegis.', TODAY, 'Mya');
    expect(sys).toMatch(/cannot take ANY action/);
    expect(sys).toMatch(/NEVER say you will do something/);
    expect(sys).toMatch(/cancel my time off on Aug 21/);
  });
  it('a blocked swap speaks to the employee as "you", never their own name in the third person', () => {
    expect(reasonAddressedToYou('Mya Vanderzwaag has approved time off on that date.', 'Mya Vanderzwaag')).toBe('you have approved time off that day.');
    expect(reasonAddressedToYou('Mya Vanderzwaag would exceed their maximum weekly hours (currently at 30.0h, max 32h, shift adds 4h).', 'Mya Vanderzwaag')).toMatch(/^you would exceed your maximum weekly hours/);
    // Someone else's reason keeps their name.
    expect(reasonAddressedToYou('Jenna Stibitz has approved time off on that date.', 'Mya Vanderzwaag')).toBe('Jenna Stibitz has approved time off on that date.');
  });
});
