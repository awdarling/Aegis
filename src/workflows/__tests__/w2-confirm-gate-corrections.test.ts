import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── W-2 branch 2 (C-5, J-4): the confirm gates treat a non-yes/no reply as an
// EDIT, and an open question keeps its state ─────────────────────────────────
//
// Named after the transcripts they fix (audits of 2026-08-26):
//   • Katie, Aug 21 (video 13-43-16) — "Jenna and I r switching shifts on
//     Sunday" → "Which shift did you want to swap?" → "Sunday" was re-classified
//     as a SCHEDULE QUERY; "Ask Jenna" looped; a 6-person broadcast was offered
//     though she'd named Jenna three times.
//   • Maisey — "make sure to say it's due to the watermark entry" at the
//     confirm → nagged "should I send that?"; "ask mia" → broadcast to 3
//     people, not Mia; post-send "make sure to say it's for the competition"
//     → the scope wall.
//   • Katie — "THIS IS FOR COMPETITION" → same prompt, reason unchanged;
//     re-sending the identical request instead of "yes" → the same prompt again.

const h = vi.hoisted(() => {
  const inserts: Array<{ table: string; rows: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; values: Record<string, unknown>; filters: Record<string, unknown> }> = [];
  const memoryStore = new Map<string, { id: string; content: string }>();
  let memSeq = 0;
  const state = {
    employees: [] as Array<Record<string, unknown>>,
    assignments: [] as Array<Record<string, unknown>>,
    torPending: null as Record<string, unknown> | null,
  };
  function makeBuilder(table: string) {
    const f: Record<string, unknown> = {};
    function memEntries() {
      return [...memoryStore.entries()].map(([source, row]) => ({ source, ...row }));
    }
    const one = () => {
      if (table === 'employees') {
        if (f.id) return state.employees.find(e => e.id === f.id) ?? null;
        if (f.ilike_name) {
          const pat = String(f.ilike_name).toLowerCase();
          if (pat.endsWith('%')) {
            const prefix = pat.slice(0, -1);
            return state.employees.find(e => String(e.name).toLowerCase().startsWith(prefix)) ?? null;
          }
          return state.employees.find(e => String(e.name).toLowerCase() === pat) ?? null;
        }
        return state.employees[0] ?? null;
      }
      if (table === 'companies') return { name: 'Watermark', timezone: 'America/Detroit' };
      if (table === 'schedules') return { id: 'sched-1', data: { assignments: state.assignments }, staffing_report: {} };
      if (table === 'company_channels') return { channel_value: '+16166164898' };
      if (table === 'time_off_requests') {
        if (f.status === 'pending') return state.torPending;
        return { id: 'req-1' };
      }
      if (table === 'aegis_memory') {
        const row = memEntries().find(r => r.source === f.source);
        return row ? { id: row.id, content: row.content } : null;
      }
      return null;
    };
    const list = () => {
      if (table === 'employees') return state.employees;
      if (table === 'shift_types') return [];
      if (table === 'availability') return [];
      if (table === 'time_off_requests') return [];
      if (table === 'policies') return [];
      if (table === 'employee_conflicts') return [];
      if (table === 'wage_rates') return [];
      return [];
    };
    const b: Record<string, unknown> = {
      select() { return b; },
      eq(col: string, val: unknown) { f[col] = val; return b; },
      neq() { return b; }, or() { return b; },
      ilike(col: string, val: unknown) { f[`ilike_${col}`] = val; return b; },
      like() { return b; }, in() { return b; }, is() { return b; },
      lte() { return b; }, gte() { return b; }, lt() { return b; }, gt() { return b; },
      order() { return b; }, limit() { return b; },
      insert(rows: Record<string, unknown>) {
        inserts.push({ table, rows });
        if (table === 'aegis_memory') {
          memoryStore.set(String(rows.source), { id: `mem-${++memSeq}`, content: String(rows.content) });
        }
        return b;
      },
      update(values: Record<string, unknown>) {
        updates.push({ table, values, filters: f });
        return {
          eq(col: string, val: unknown) { f[col] = val; return this; },
          then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
            return Promise.resolve({ data: null, error: null }).then(onF, onR);
          },
        };
      },
      delete() {
        return {
          eq(col: string, val: unknown) {
            if (table === 'aegis_memory' && col === 'source') memoryStore.delete(String(val));
            if (table === 'aegis_memory' && col === 'id') {
              for (const [src, row] of memoryStore.entries()) if (row.id === val) memoryStore.delete(src);
            }
            f[col] = val; return this;
          },
          like() { return this; },
          then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
            return Promise.resolve({ data: null, error: null }).then(onF, onR);
          },
        };
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
    inserts, updates, state, memoryStore, makeBuilder,
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

import { handleInitiateSwap, handleSwapConfirmation, getPendingSwap, type PendingSwap } from '../shift-swap';
import { handlePendingTimeOffConfirmation, handleTimeOffReasonEdit, samePendingRequest } from '../time-off';
import { applyReasonEditBackstop } from '../../ai/claude';
import { parseReasonEdit, parseNamedDirective, parseWillingDaysReply, parseShiftAnswer } from '../../lib/confirm-edits';
import { todayInTimezone, addDays } from '../../lib/tenant-date';
import type { InboundMessage, VerifiedContact } from '../../security/types';

const COMPANY = 'c-wm';
const AEGIS = '+16166164898';
const TZ = 'America/Detroit';
const TODAY = todayInTimezone(TZ);
// The next Sunday ON OR AFTER tomorrow (so "Sunday" in a test message and the
// fixture agree even when today IS Sunday).
function nextSunday(): string {
  let d = addDays(TODAY, 1);
  while (new Date(d + 'T12:00:00Z').getUTCDay() !== 0) d = addDays(d, 1);
  return d;
}
const SUNDAY = nextSunday();

const KATIE = { id: 'katie', name: 'Katie Schillaci', contact_phone: '+16165550101', contact_email: null, company_id: COMPANY, primary_role: 'Lifeguard', active: true, qualified_roles: ['Lifeguard'], max_weekly_hours: 40 };
const JENNA = { id: 'jenna', name: 'Jenna Stibitz', contact_phone: '+16165550102', contact_email: null, company_id: COMPANY, primary_role: 'Lifeguard', active: true, qualified_roles: ['Lifeguard'], max_weekly_hours: 40 };
const MIA = { id: 'mia', name: 'Mia Shaffer', contact_phone: '+16165550103', contact_email: null, company_id: COMPANY, primary_role: 'Lifeguard', active: true, qualified_roles: ['Lifeguard'], max_weekly_hours: 40 };
const MAISEY = { id: 'maisey', name: 'Maisey Pell', contact_phone: '+16165550104', contact_email: null, company_id: COMPANY, primary_role: 'Lifeguard', active: true, qualified_roles: ['Lifeguard'], max_weekly_hours: 40 };

const contactFor = (e: { id: string; name: string; contact_phone: string }): VerifiedContact =>
  ({ role: 'employee', company_id: COMPANY, employee_id: e.id, user_id: null, name: e.name, matched_identifier: e.contact_phone, channel: 'sms' });
const msgFrom = (e: { contact_phone: string }, body: string): InboundMessage =>
  ({ sender: e.contact_phone, recipient: AEGIS, body, channel: 'sms' });

const replies = () => h.replyMock.mock.calls.map(c => c[2] as string);
const texts = () => h.sendSmsMock.mock.calls.map(c => (c[0] as { body: string; to: string }));
const memory = (prefix: string) =>
  h.inserts.filter(i => i.table === 'aegis_memory' && String(i.rows.source).startsWith(prefix)).map(i => JSON.parse(String(i.rows.content)) as Record<string, unknown>);

beforeEach(() => {
  h.inserts.length = 0;
  h.updates.length = 0;
  h.memoryStore.clear();
  h.replyMock.mockClear();
  h.sendSmsMock.mockClear();
  h.sendEmailMock.mockClear();
  h.resolutionNoticeMock.mockClear();
  h.createMock.mockReset();
  h.generateMock.mockReset();
  h.classifyMock.mockReset();
  h.classifyMock.mockResolvedValue({ intent: 'unknown', confidence: 'low', extracted: {} });
  h.state.employees = [KATIE, JENNA, MIA, MAISEY];
  h.state.assignments = [];
  h.state.torPending = null;
});

describe('Katie, Aug 21 (J-4) — the trade that looped', () => {
  it('"which shift?" keeps its state; "Sunday" ANSWERS it (no re-classification, no second extraction); "Ask Jenna" = yes, never a broadcast', async () => {
    // Katie works two upcoming shifts, so the initial ask is ambiguous.
    h.state.assignments = [
      { date: SUNDAY, employee_id: 'katie', employee_name: 'Katie Schillaci', shift_name: 'Flex', role: 'Lifeguard', start_time: '10:00:00', end_time: '14:00:00', hours: 4 },
      { date: addDays(SUNDAY, 2), employee_id: 'katie', employee_name: 'Katie Schillaci', shift_name: 'AM Weekday', role: 'Lifeguard', start_time: '11:00:00', end_time: '15:30:00', hours: 4.5 },
      { date: addDays(SUNDAY, 1), employee_id: 'jenna', employee_name: 'Jenna Stibitz', shift_name: 'AM Weekday', role: 'Lifeguard', start_time: '11:00:00', end_time: '15:30:00', hours: 4.5 },
    ];
    // The ONE extraction call for the whole flow.
    h.generateMock.mockResolvedValueOnce(JSON.stringify({
      direction: 'trade', shift_date: null, shift_name: null,
      target_employee_name: 'Jenna', target_shift_date: null, target_shift_name: null, willing_days: [],
    }));

    // 1 — "Jenna and I r switching shifts" → ambiguous → asks which, KEEPS state.
    await handleInitiateSwap(msgFrom(KATIE, 'Jenna and I r switching shifts'), contactFor(KATIE), {});
    expect(replies()[0]).toMatch(/Which shift did you want to swap/i);
    const ask = await getPendingSwap(COMPANY, 'katie');
    expect(ask).not.toBeNull();
    expect(ask!.awaiting).toBe('which_shift');

    // 2 — "Sunday" answers the open question. No new extraction, no classifier.
    h.generateMock.mockClear();
    h.replyMock.mockClear();
    await handleSwapConfirmation(msgFrom(KATIE, 'Sunday'), contactFor(KATIE), ask!);
    expect(h.generateMock).not.toHaveBeenCalled();   // the stored extraction was reused
    expect(h.classifyMock).not.toHaveBeenCalled();   // never re-classified as a schedule query
    const confirm = replies().join('\n');
    expect(confirm).toMatch(/give up your Flex shift/i);
    expect(confirm).toMatch(/Jenna/);
    const pending2 = await getPendingSwap(COMPANY, 'katie');
    expect(pending2).not.toBeNull();
    expect(pending2!.awaiting ?? undefined).toBeUndefined();
    expect(pending2!.mode).toBe('directed');
    expect(pending2!.target_employee_id).toBe('jenna');

    // 3 — "Ask Jenna" names the person it's already set up with → that's a yes:
    // outreach goes to Jenna and ONLY Jenna.
    h.replyMock.mockClear();
    await handleSwapConfirmation(msgFrom(KATIE, 'Ask Jenna'), contactFor(KATIE), pending2!);
    const outTos = texts().map(t => t.to);
    expect(outTos).toEqual([JENNA.contact_phone]);
    expect(memory('swap_outreach:').length).toBe(1);
    expect(memory('swap_broadcast:').length).toBe(0);
  });
});

describe('Maisey — "ask mia" at the facilitated gate (C-5)', () => {
  it('directs the swap to Mia — never a broadcast; an unknown name keeps the gate and offers the broadcast', async () => {
    h.state.assignments = [
      { date: SUNDAY, employee_id: 'maisey', employee_name: 'Maisey Pell', shift_name: 'AM Weekend', role: 'Lifeguard', start_time: '09:00:00', end_time: '15:30:00', hours: 6.5 },
    ];
    const gate: PendingSwap & { _memory_id?: string } = {
      mode: 'facilitated', company_id: COMPANY, requester_id: 'maisey', requester_name: 'Maisey Pell',
      channel: 'sms', sender: MAISEY.contact_phone, recipient: AEGIS,
      shift_date: SUNDAY, shift_name: 'AM Weekend', role: 'Lifeguard',
      shift_start: '09:00:00', shift_end: '15:30:00', schedule_id: 'sched-1',
      willing_days: [], expires_at: new Date(Date.now() + 3600_000).toISOString(),
    };

    // Unknown name first: gate survives, broadcast offered.
    await handleSwapConfirmation(msgFrom(MAISEY, 'ask brenda'), contactFor(MAISEY), gate);
    expect(replies()[0]).toMatch(/don't see anyone named "brenda"/i);
    expect(texts().length).toBe(0);

    // "ask mia" → the swap re-runs DIRECTED at Mia, confirm names her.
    h.replyMock.mockClear();
    await handleSwapConfirmation(msgFrom(MAISEY, 'ask mia'), contactFor(MAISEY), gate);
    const confirm = replies().join('\n');
    expect(confirm).toMatch(/Mia/);
    expect(confirm).toMatch(/take your AM Weekend shift/i);
    const redirected = await getPendingSwap(COMPANY, 'maisey');
    expect(redirected!.mode).toBe('directed');
    expect(redirected!.target_employee_id).toBe('mia');
    expect(memory('swap_broadcast:').length).toBe(0);
  });

  it('"I can work Mondays and Tuesdays" updates the trade days — the gate SURVIVES (J-4 root cause)', async () => {
    const gate: PendingSwap & { _memory_id?: string } = {
      mode: 'facilitated', company_id: COMPANY, requester_id: 'maisey', requester_name: 'Maisey Pell',
      channel: 'sms', sender: MAISEY.contact_phone, recipient: AEGIS,
      shift_date: SUNDAY, shift_name: 'AM Weekend', role: 'Lifeguard',
      shift_start: '09:00:00', shift_end: '15:30:00', schedule_id: 'sched-1',
      willing_days: [], expires_at: new Date(Date.now() + 3600_000).toISOString(),
    };
    await handleSwapConfirmation(msgFrom(MAISEY, 'I can work mondays and tuesdays'), contactFor(MAISEY), gate);
    expect(h.classifyMock).not.toHaveBeenCalled();   // never treated as an availability change
    const updated = await getPendingSwap(COMPANY, 'maisey');
    expect(updated).not.toBeNull();                  // the pending swap was NOT cleared
    expect(updated!.willing_days).toEqual([1, 2]);
    expect(replies().join('\n')).toMatch(/Monday or Tuesday/);
  });
});

describe('reason corrections at the time-off confirm gate (C-5)', () => {
  const gate = () => ({
    employee_id: 'maisey', start_date: addDays(TODAY, 7), end_date: addDays(TODAY, 7),
    reason: null, channel: 'sms' as const, sender: MAISEY.contact_phone, recipient: AEGIS,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    time_off_type: 'full_day' as const, partial_days: null,
  });

  it('Maisey: "make sure to say it\'s due to the watermark entry" → reason updated, confirm re-rendered, zero model calls', async () => {
    await handlePendingTimeOffConfirmation(msgFrom(MAISEY, "make sure to say it's due to the watermark entry"), contactFor(MAISEY), gate() as never);
    expect(h.classifyMock).not.toHaveBeenCalled();
    const updated = memory('pending_to:')[0];
    expect(updated.reason).toBe('the watermark entry');
    expect(replies()[0]).toMatch(/updated/i);
    expect(replies()[0]).toMatch(/for the watermark entry/);
    expect(replies()[0]).toMatch(/send that over to your manager\?/i);
  });

  it('Katie: "THIS IS FOR COMPETITION" → reason updated calmly', async () => {
    await handlePendingTimeOffConfirmation(msgFrom(KATIE, 'THIS IS FOR COMPETITION'), contactFor(KATIE), { ...gate(), employee_id: 'katie' } as never);
    const updated = memory('pending_to:')[0];
    expect(updated.reason).toBe('competition');
  });

  it('re-sending the IDENTICAL request instead of "yes" submits it (Katie, IMG_5411)', async () => {
    const pending = { ...gate(), employee_id: 'katie', reason: 'competition' };
    h.classifyMock.mockResolvedValueOnce({
      intent: 'submit_time_off', confidence: 'high',
      extracted: { dates: [{ start_date: pending.start_date, end_date: pending.end_date, time_off_type: 'full_day' }], reason: 'competition' },
    });
    await handlePendingTimeOffConfirmation(msgFrom(KATIE, 'I cannot work August 18th. This is for competition.'), contactFor(KATIE), pending as never);
    expect(h.inserts.some(i => i.table === 'time_off_requests')).toBe(true);
    expect(replies().join('\n')).toMatch(/passed your time off .* along to your manager/i);
  });

  it('a correction the extractor cannot ground keeps the gate — never a restart', async () => {
    h.classifyMock.mockResolvedValueOnce({ intent: 'submit_time_off', confidence: 'medium', extracted: {} });
    await handlePendingTimeOffConfirmation(msgFrom(MAISEY, 'hmm can you make it look right'), contactFor(MAISEY), gate() as never);
    expect(replies()[0]).toMatch(/tell me what to change/i);
    expect(h.inserts.some(i => i.table === 'time_off_requests')).toBe(false);
  });
});

describe('post-send reason edit (C-5) — no scope wall', () => {
  it('the backstop upgrades general_question to edit_time_off_reason', () => {
    const out = applyReasonEditBackstop(
      { intent: 'general_question', confidence: 'high', extracted: {} },
      "make sure to say it's for the competition",
      'employee',
    );
    expect(out.intent).toBe('edit_time_off_reason');
    // A cancel stays a cancel; a plain question stays a question.
    expect(applyReasonEditBackstop({ intent: 'general_question', confidence: 'high', extracted: {} }, 'when do I work friday', 'employee').intent).toBe('general_question');
  });

  it('updates the pending row and sends ONE manager FYI — not a fresh approval email', async () => {
    h.state.torPending = { id: 'tor-9', start_date: addDays(TODAY, 3), end_date: addDays(TODAY, 3), reason: null };
    await handleTimeOffReasonEdit(msgFrom(MAISEY, "make sure to say it's for the competition"), contactFor(MAISEY), {});
    const upd = h.updates.find(u => u.table === 'time_off_requests');
    expect(upd).toBeDefined();
    expect(upd!.values.reason).toBe('the competition');
    expect(h.resolutionNoticeMock).toHaveBeenCalledTimes(1);
    expect(h.sendEmailMock).not.toHaveBeenCalled();   // no second approval email from this path
    expect(replies()[0]).toMatch(/now says it's for the competition/i);
  });

  it('with nothing pending, says so honestly', async () => {
    h.state.torPending = null;
    await handleTimeOffReasonEdit(msgFrom(MAISEY, "say it's for the competition"), contactFor(MAISEY), {});
    expect(replies()[0]).toMatch(/don't see a request of yours still waiting/i);
    expect(h.updates.some(u => u.table === 'time_off_requests')).toBe(false);
  });
});

describe('the deterministic readings themselves', () => {
  it('parseReasonEdit', () => {
    expect(parseReasonEdit("make sure to say it's due to the watermark entry")).toBe('the watermark entry');
    expect(parseReasonEdit('THIS IS FOR COMPETITION')).toBe('competition');
    expect(parseReasonEdit("it's for my sister's wedding")).toBe("my sister's wedding");
    expect(parseReasonEdit('reason: doctor appointment')).toBe('doctor appointment');
    expect(parseReasonEdit('yes')).toBeNull();
    expect(parseReasonEdit('can I get friday off')).toBeNull();
    expect(parseReasonEdit('actually the 19th')).toBeNull();   // a date correction is not a reason
  });
  it('parseNamedDirective', () => {
    expect(parseNamedDirective('ask mia')).toBe('mia');
    expect(parseNamedDirective('Ask Jenna')).toBe('Jenna');
    expect(parseNamedDirective('Can u send the shift request by Jenna')).toBe('Jenna');
    expect(parseNamedDirective('send it to Margaret Holt')).toBe('Margaret Holt');
    expect(parseNamedDirective('ask the team')).toBeNull();
    expect(parseNamedDirective('yes')).toBeNull();
  });
  it('parseWillingDaysReply', () => {
    expect(parseWillingDaysReply('I can work mondays and tuesdays')).toEqual([1, 2]);
    expect(parseWillingDaysReply('i could take friday')).toEqual([5]);
    expect(parseWillingDaysReply('I can only work sundays going forward')).toBeNull();  // availability change
    expect(parseWillingDaysReply('sure')).toBeNull();
  });
  it('parseShiftAnswer', () => {
    const sunday = parseShiftAnswer('Sunday', TODAY);
    expect(sunday?.shift_date).toBeDefined();
    expect(new Date(sunday!.shift_date! + 'T12:00:00Z').getUTCDay()).toBe(0);
    expect(parseShiftAnswer('the flex shift', TODAY)).toEqual({ shift_name_hint: 'flex' });
    expect(parseShiftAnswer('yes', TODAY)).toBeNull();
    expect(parseShiftAnswer('what shifts do I have next week and also', TODAY)).toBeNull();
  });
  it('samePendingRequest compares substance, not the reason', () => {
    const pending = { start_date: '2026-08-18', end_date: '2026-08-18', time_off_type: 'full_day' as const, partial_days: null };
    expect(samePendingRequest(pending, { start_date: '2026-08-18', end_date: '2026-08-18', time_off_type: 'full_day', partial_days: null, unscheduled_dates: [] })).toBe(true);
    expect(samePendingRequest(pending, { start_date: '2026-08-19', end_date: '2026-08-19', time_off_type: 'full_day', partial_days: null, unscheduled_dates: [] })).toBe(false);
  });
});
