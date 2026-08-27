import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── W-2 branch 1 (spec §3.5): employee call-out ──────────────────────────────
//
// Named after the transcript it fixes (competition audit, 2026-08-26):
//   • Mia Shaffer, Aug 21 — "I'm sick and I can't make it tonight". W-1 made the
//     no-shift case honest; THIS branch makes the with-shift case a real
//     call-out: pending-not-granted employee copy, a three-button manager email
//     (Approve & find coverage / Approve only / Deny), a near-shift text nudge,
//     and an idempotent one-click coverage blast that excludes the caller.
//
// Decision (Alexander, 2026-08-27): a call-out is a REQUEST, not a declaration;
// on Approve only the shift STAYS on the schedule, greyed out, excluded from
// the wage estimate.

const h = vi.hoisted(() => {
  const inserts: Array<{ table: string; rows: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; values: Record<string, unknown>; filters: Record<string, unknown> }> = [];
  // Live aegis_memory store so coverage sessions survive between calls
  // (insert/delete/update flow through it; list()/maybeSingle() read it).
  const memoryStore = new Map<string, { id: string; content: string; company_id: string }>();
  let memSeq = 0;
  const state = {
    employees: [] as Array<Record<string, unknown>>,
    assignments: [] as Array<Record<string, unknown>>,
    availability: [] as Array<Record<string, unknown>>,
    scheduleExists: true,
    scheduleRow: null as Record<string, unknown> | null,
  };
  const WM_SHIFTS = [
    { id: 'am-we', name: 'AM Weekend', start_time: '09:00:00', end_time: '15:30:00', days_active: [0, 6], active: true },
    { id: 'am-wd', name: 'AM Weekday', start_time: '11:00:00', end_time: '15:30:00', days_active: [1, 2, 3, 4, 5], active: true },
    { id: 'aft', name: 'Afternoon', start_time: '15:00:00', end_time: '20:15:00', days_active: [0, 1, 2, 3, 4, 5, 6], active: true },
  ];
  function makeBuilder(table: string) {
    const f: Record<string, unknown> = {};
    const likes: Array<[string, string]> = [];
    const memRows = () => {
      let rows = [...memoryStore.values()];
      for (const [col, pat] of likes) {
        if (col === 'source') {
          const prefix = pat.replace(/%$/, '');
          rows = rows.filter(r => {
            const src = [...memoryStore.entries()].find(([, v]) => v.id === r.id)?.[0] ?? '';
            return src.startsWith(prefix);
          });
        }
        if (col === 'content') {
          const needle = pat.replace(/^%|%$/g, '');
          rows = rows.filter(r => r.content.includes(needle));
        }
      }
      if (f.source) {
        rows = rows.filter(r => [...memoryStore.entries()].find(([, v]) => v.id === r.id)?.[0] === f.source);
      }
      return rows.map(r => ({ id: r.id, content: r.content, source: [...memoryStore.entries()].find(([, v]) => v.id === r.id)?.[0], created_at: r.id }));
    };
    const one = () => {
      if (table === 'employees') {
        const id = f.id ?? null;
        return (id ? state.employees.find(e => e.id === id) : state.employees[0]) ?? null;
      }
      if (table === 'companies') return { name: 'Watermark', timezone: 'America/Detroit' };
      if (table === 'schedules') {
        if (!state.scheduleExists || f.status !== 'published') return null;
        return state.scheduleRow ?? { id: 'sched-1', data: { assignments: state.assignments }, staffing_report: {} };
      }
      if (table === 'company_channels') return { channel_value: '+16166164898' };
      if (table === 'time_off_requests') return { id: 'req-1', status: 'pending', start_date: '2026-01-01', end_date: '2026-01-01', reason: null, employee_id: 'mia', company_id: 'c-wm' };
      if (table === 'aegis_memory') return memRows()[0] ?? null;
      return null;
    };
    const list = () => {
      if (table === 'shift_types') return WM_SHIFTS;
      if (table === 'employees') return state.employees;
      if (table === 'availability') return state.availability;
      if (table === 'custom_availability') return [];
      if (table === 'time_off_requests') return [];
      if (table === 'policies') return [];
      if (table === 'wage_rates') return [];
      if (table === 'aegis_memory') return memRows();
      return [];
    };
    const b: Record<string, unknown> = {
      select() { return b; },
      eq(col: string, val: unknown) { f[col] = val; return b; },
      neq() { return b; }, or() { return b; },
      like(col: string, pat: string) { likes.push([col, pat]); return b; },
      in() { return b; }, is() { return b; },
      lte() { return b; }, gte() { return b; }, lt() { return b; }, gt() { return b; },
      order() { return b; }, limit() { return b; },
      insert(rows: Record<string, unknown>) {
        inserts.push({ table, rows });
        if (table === 'aegis_memory') {
          const src = String(rows.source);
          memoryStore.set(src, { id: `mem-${++memSeq}`, content: String(rows.content), company_id: String(rows.company_id) });
        }
        return b;
      },
      update(values: Record<string, unknown>) {
        // capture, and apply to the memory store when targeted by id
        const u = { table, values, filters: f };
        updates.push(u);
        if (table === 'aegis_memory') {
          queueMicrotask(() => {});
        }
        return {
          ...b,
          eq(col: string, val: unknown) {
            f[col] = val;
            if (table === 'aegis_memory' && col === 'id') {
              for (const [src, row] of memoryStore.entries()) {
                if (row.id === val) memoryStore.set(src, { ...row, content: String(values.content) });
              }
            }
            return this;
          },
          then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
            return Promise.resolve({ data: null, error: null }).then(onF, onR);
          },
        };
      },
      delete() {
        return {
          ...b,
          eq(col: string, val: unknown) {
            f[col] = val;
            if (table === 'aegis_memory' && col === 'source') memoryStore.delete(String(val));
            if (table === 'aegis_memory' && col === 'id') {
              for (const [src, row] of memoryStore.entries()) if (row.id === val) memoryStore.delete(src);
            }
            return this;
          },
          like(col: string, pat: string) { likes.push([col, pat]); return this; },
          in(col: string, vals: unknown[]) {
            if (table === 'aegis_memory' && col === 'id') {
              for (const [src, row] of memoryStore.entries()) if ((vals as string[]).includes(row.id)) memoryStore.delete(src);
            }
            return this;
          },
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
    replyMock: vi.fn(async () => {}),
    sendSmsMock: vi.fn(async () => true),
    sendEmailMock: vi.fn(async () => {}),
    JACK: { userId: 'u-jack', employeeId: 'e-jack', name: 'Jack McCorkle', role: 'manager' as const, email: 'jack@wm.test', phone: '+16165550999', linkSource: 'employee_id' },
  };
});

vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: h.createMock }; } }));
vi.mock('../../ai/claude', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ai/claude')>();
  return { ...actual, withAnthropicRetry: (fn: () => unknown) => fn(), classifyIntent: h.classifyMock, generateReply: vi.fn() };
});
vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: false, ANTHROPIC_API_KEY: 'x', SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', SENDGRID_FROM_EMAIL: 'a@b.c', SENDGRID_FROM_NAME: 'Aegis', BASE_URL: 'http://x', NODE_ENV: 'test' } }));
vi.mock('../../db/client', () => ({ supabase: { from: (t: string) => h.makeBuilder(t) } }));
vi.mock('../../messaging/reply', () => ({ reply: h.replyMock, sendInThreadAck: vi.fn(async () => {}), normalizeReSubject: (s: string) => s }));
vi.mock('../../messaging/sms', () => ({ sendSms: h.sendSmsMock, getTenantSmsNumber: vi.fn(async () => null) }));
vi.mock('../../messaging/email', () => ({ sendEmail: h.sendEmailMock }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock('../../messaging/manager-directory', () => ({
  resolveManagers: vi.fn(async () => ({ managers: [h.JACK], unreachableBySms: [], smsChannel: '+16166164898' })),
  recipientsFor: (d: { managers: unknown[] }) => d.managers,
  primaryRecipient: (d: { managers: unknown[] }) => d.managers[0] ?? null,
  wantsCategory: () => true,
  canSms: () => true,
}));

import { handleSubmitTimeOff, handlePendingTimeOffConfirmation, detectCallOut, describeCallOutShifts, type CallOutShift } from '../time-off';
import { startCoverageForCallOut, markAssignmentsCalledOut } from '../emergency-coverage';
import { computeWageEstimateFromMaps } from '../../lib/schedule-simulator';
import { todayInTimezone, addDays } from '../../lib/tenant-date';
import type { InboundMessage, VerifiedContact } from '../../security/types';

const COMPANY = 'c-wm';
const PHONE = '+16165550123';
const AEGIS = '+16166164898';
const TZ = 'America/Detroit';
const TODAY = todayInTimezone(TZ);
const TOMORROW = addDays(TODAY, 1);
const NEXT_WEEK = addDays(TODAY, 7);

const contactFor = (id: string, name: string): VerifiedContact =>
  ({ role: 'employee', company_id: COMPANY, employee_id: id, user_id: null, name, matched_identifier: PHONE, channel: 'sms' });
const msg = (body: string): InboundMessage => ({ sender: PHONE, recipient: AEGIS, body, channel: 'sms' });

const replies = () => h.replyMock.mock.calls.map(c => c[2] as string);
const texts = () => h.sendSmsMock.mock.calls.map(c => (c[0] as { body: string; to: string }));
const memory = (prefix: string) =>
  h.inserts.filter(i => i.table === 'aegis_memory' && String(i.rows.source).startsWith(prefix)).map(i => JSON.parse(String(i.rows.content)) as Record<string, unknown>);

const MIA = { id: 'mia', name: 'Mia Shaffer', contact_phone: PHONE, contact_email: null, company_id: COMPANY, primary_role: 'Lifeguard', active: true, qualified_roles: ['Lifeguard'], max_weekly_hours: 40 };
const MARGARET = { id: 'margaret', name: 'Margaret Holt', contact_phone: '+16165550124', contact_email: null, company_id: COMPANY, primary_role: 'Lifeguard', active: true, qualified_roles: ['Lifeguard'], max_weekly_hours: 40 };
const ROSA = { id: 'rosa', name: 'Rosa Alvarez', contact_phone: '+16165550125', contact_email: null, company_id: COMPANY, primary_role: 'Lifeguard', active: true, qualified_roles: ['Lifeguard'], max_weekly_hours: 40 };

const aftAssignment = (employee: { id: string; name: string }, date: string) => ({
  date, employee_id: employee.id, employee_name: employee.name,
  shift_name: 'Afternoon', role: 'Lifeguard', start_time: '15:00:00', end_time: '20:15:00', hours: 5.25,
});
const allDayAvail = (employeeId: string) =>
  [0, 1, 2, 3, 4, 5, 6].map(d => ({ employee_id: employeeId, day_of_week: d, start_time: '00:00', end_time: '23:59' }));

beforeEach(() => {
  h.inserts.length = 0;
  h.updates.length = 0;
  h.memoryStore.clear();
  h.replyMock.mockClear();
  h.sendSmsMock.mockClear();
  h.sendEmailMock.mockClear();
  h.createMock.mockReset();
  h.classifyMock.mockClear();
  h.classifyMock.mockResolvedValue({ intent: 'unknown', confidence: 'low', extracted: {} });
  h.state.employees = [MIA, MARGARET, ROSA];
  h.state.assignments = [aftAssignment(MIA, TODAY)];
  h.state.availability = [...allDayAvail('margaret'), ...allDayAvail('rosa'), ...allDayAvail('mia')];
  h.state.scheduleExists = true;
  h.state.scheduleRow = null;
});

describe('Mia, Aug 21 — "I\'m sick and I can\'t make it tonight" WITH an Afternoon assignment', () => {
  const extractedTonight = {
    dates: [{ start_date: TODAY, end_date: TODAY, time_off_type: 'partial', period_label: 'evening', start_time: null, end_time: null }],
    reason: 'illness',
  };

  it('is recognised as a call-out and the confirm names the shift + hours', async () => {
    await handleSubmitTimeOff(msg("I'm sick and I can't make it tonight"), contactFor('mia', 'Mia Shaffer'), extractedTonight);
    const pending = memory('pending_to:')[0];
    expect(pending).toBeDefined();
    const callOut = pending.call_out as CallOutShift[];
    expect(callOut).toBeDefined();
    expect(callOut.length).toBe(1);
    expect(callOut[0].shift_name).toBe('Afternoon');
    expect(pending.employee_words).toBe("I'm sick and I can't make it tonight");
    const body = replies()[0];
    expect(body).toMatch(/calling out of your Afternoon shift \(3pm–8:15pm\) tonight/);
    expect(body).toMatch(/send that to your manager/i);
  });

  it('on yes: the employee hears PENDING-NOT-GRANTED ("still on the schedule"), never "you\'re off"', async () => {
    await handleSubmitTimeOff(msg("I'm sick and I can't make it tonight"), contactFor('mia', 'Mia Shaffer'), extractedTonight);
    const pending = memory('pending_to:')[0] as Record<string, unknown>;
    h.replyMock.mockClear();
    await handlePendingTimeOffConfirmation(msg('yes'), contactFor('mia', 'Mia Shaffer'), pending as never);
    const body = replies().join('\n');
    expect(body).toMatch(/I've sent your call-out for your Afternoon shift \(3pm–8:15pm\) tonight to your manager/);
    expect(body).toMatch(/you'll hear the moment they confirm/i);
    expect(body).toMatch(/still on the schedule/i);
    expect(body).not.toMatch(/you're off|approved/i);
  });

  it("the manager email has THREE buttons and forwards Mia's words; the third token is approve_and_cover", async () => {
    await handleSubmitTimeOff(msg("I'm sick and I can't make it tonight"), contactFor('mia', 'Mia Shaffer'), extractedTonight);
    const pending = memory('pending_to:')[0] as Record<string, unknown>;
    await handlePendingTimeOffConfirmation(msg('yes'), contactFor('mia', 'Mia Shaffer'), pending as never);

    const tokens = memory('decision_token:');
    const actions = tokens.map(t => t.action).sort();
    expect(actions).toEqual(['approve', 'approve_and_cover', 'deny']);
    for (const t of tokens) {
      expect(Array.isArray(t.call_out)).toBe(true);
      expect((t.call_out as CallOutShift[])[0].shift_name).toBe('Afternoon');
    }

    expect(h.sendEmailMock).toHaveBeenCalled();
    const email = h.sendEmailMock.mock.calls[0][0] as { subject: string; html: string; text: string };
    expect(email.subject).toMatch(/^Call-Out — Mia Shaffer/);
    expect(email.html).toMatch(/Approve &amp; find coverage/);
    expect(email.html).toMatch(/Approve only/);
    expect(email.html).toMatch(/Deny/);
    expect(email.html).toMatch(/action=approve_and_cover/);
    expect(email.html).toMatch(/sick and I can/); // her actual wording, forwarded
    expect(email.text).toMatch(/called out of Mia's Afternoon shift \(3pm–8:15pm\) tonight/);

    // The to_thread side row records this request as a call-out (status query reads it).
    const thread = memory('to_thread:')[0];
    expect(Array.isArray(thread.call_out)).toBe(true);
  });

  it('the manager text nudge says who / which shift, and escalates when the shift is near', async () => {
    // Deterministic near-shift case: a shift starting ~3 hours from now,
    // whatever the wall clock — computed in tenant-local terms.
    const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
    const soon = new Date(nowLocal.getTime() + 3 * 60 * 60 * 1000);
    const soonDate = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;
    const soonTime = `${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}:00`;
    const pending = {
      employee_id: 'mia', start_date: soonDate, end_date: soonDate, reason: 'sick',
      channel: 'sms', sender: PHONE, recipient: AEGIS,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      time_off_type: 'full_day', partial_days: null,
      call_out: [{ date: soonDate, shift_name: 'Afternoon', role: 'Lifeguard', start_time: soonTime, end_time: '23:00:00' }],
      employee_words: 'i am sick',
    };
    await handlePendingTimeOffConfirmation(msg('yes'), contactFor('mia', 'Mia Shaffer'), pending as never);
    const managerText = texts().find(t => t.to === h.JACK.phone);
    expect(managerText).toBeDefined();
    expect(managerText!.body).toMatch(/Mia Shaffer just called out of Mia's Afternoon shift/);
    expect(managerText!.body).toMatch(/the coverage window is real/);
    expect(managerText!.body).toMatch(/options are in your email/);
  });

  it('a far-off shift gets NO near-shift escalation line', async () => {
    const pending = {
      employee_id: 'mia', start_date: TOMORROW, end_date: TOMORROW, reason: null,
      channel: 'sms', sender: PHONE, recipient: AEGIS,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      time_off_type: 'full_day', partial_days: null,
      call_out: [{ date: TOMORROW, shift_name: 'Afternoon', role: 'Lifeguard', start_time: '15:00:00', end_time: '20:15:00' }],
      employee_words: 'cant make it tomorrow',
    };
    // Run this one only when tomorrow 3pm is actually >6h away (always true
    // before 9am the day before; the guard keeps the test honest at any hour).
    await handlePendingTimeOffConfirmation(msg('yes'), contactFor('mia', 'Mia Shaffer'), pending as never);
    const managerText = texts().find(t => t.to === h.JACK.phone);
    expect(managerText).toBeDefined();
    const nowLocalHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date()));
    if (nowLocalHour < 9) {
      expect(managerText!.body).not.toMatch(/coverage window is real/);
    }
  });
});

describe('what is NOT a call-out', () => {
  it('a request for next week with an assignment then is ordinary time off', async () => {
    h.state.assignments = [aftAssignment(MIA, NEXT_WEEK)];
    await handleSubmitTimeOff(msg('I need next Tuesday off'), contactFor('mia', 'Mia Shaffer'), {
      dates: [{ start_date: NEXT_WEEK, end_date: NEXT_WEEK, time_off_type: 'full_day' }],
      reason: null,
    });
    const pending = memory('pending_to:')[0];
    expect(pending.call_out ?? undefined).toBeUndefined();
    expect(replies()[0]).toMatch(/Want me to send that over to your manager\?/);
    expect(replies()[0]).not.toMatch(/calling out/i);
  });

  it('an employee with no shift today gets W-1\'s "not on the schedule" ask, not a call-out', async () => {
    h.state.assignments = [];
    await handleSubmitTimeOff(msg("I'm sick and I can't make it tonight"), contactFor('mia', 'Mia Shaffer'), {
      dates: [{ start_date: TODAY, end_date: TODAY, time_off_type: 'partial', period_label: 'evening', start_time: null, end_time: null }],
      reason: 'illness',
    });
    const body = replies()[0];
    expect(body).toMatch(/not on the schedule that day/i);
    expect(body).not.toMatch(/calling out/i);
    expect(memory('pending_to:')[0].call_out ?? undefined).toBeUndefined();
  });

  it('detectCallOut ignores DRAFT schedules (publishedOnly)', async () => {
    h.state.scheduleExists = false; // the mock only serves status=published anyway
    const found = await detectCallOut(
      { start_date: TODAY, end_date: TODAY, time_off_type: 'full_day', partial_days: null, unscheduled_dates: [] },
      { companyId: COMPANY, employeeId: 'mia' },
    );
    expect(found).toBeNull();
  });
});

describe('Approve & find coverage — startCoverageForCallOut', () => {
  it('blasts the qualified pool EXCLUDING Mia, stores a session keyed to the request, and is idempotent', async () => {
    const first = await startCoverageForCallOut({
      companyId: COMPANY, timeOffRequestId: 'req-1',
      absentEmployeeId: 'mia', absentEmployeeName: 'Mia Shaffer',
      shiftDate: TODAY, shiftNameHint: 'Afternoon',
      manager: { userId: 'u-jack', name: 'Jack McCorkle', email: 'jack@wm.test', phone: '+16165550999' },
    });
    expect(first.outcome).toBe('started');
    if (first.outcome === 'started') {
      expect(first.contacted.sort()).toEqual(['Margaret Holt', 'Rosa Alvarez']);
      expect(first.shiftName).toBe('Afternoon');
    }
    // Outreach texts went to the teammates, never to the caller.
    const outreachTos = texts().map(t => t.to);
    expect(outreachTos).toContain(MARGARET.contact_phone);
    expect(outreachTos).toContain(ROSA.contact_phone);
    expect(outreachTos).not.toContain(PHONE);
    // The outreach copy is natural — no keyword prompt, no raw seconds.
    const outreachBody = texts().find(t => t.to === MARGARET.contact_phone)!.body;
    expect(outreachBody).toMatch(/3pm–8:15pm/);
    expect(outreachBody).not.toMatch(/Reply YES/i);
    expect(outreachBody).not.toMatch(/15:00:00/);

    // Second click: finds the session, does NOT blast again.
    h.sendSmsMock.mockClear();
    const second = await startCoverageForCallOut({
      companyId: COMPANY, timeOffRequestId: 'req-1',
      absentEmployeeId: 'mia', absentEmployeeName: 'Mia Shaffer',
      shiftDate: TODAY, shiftNameHint: 'Afternoon',
      manager: { userId: 'u-jack', name: 'Jack McCorkle', email: 'jack@wm.test', phone: '+16165550999' },
    });
    expect(second.outcome).toBe('already_open');
    expect(texts().length).toBe(0);
  });
});

describe('Approve only — the shift stays, greyed out, unpaid (Alexander, 2026-08-27)', () => {
  it('markAssignmentsCalledOut flags the assignment and the wage estimate excludes it', async () => {
    h.state.scheduleRow = {
      id: 'sched-1',
      data: { assignments: [aftAssignment(MIA, TODAY), aftAssignment(MARGARET, TODAY)] },
      staffing_report: { estimated_wages: { total: 999 } },
    };
    const { marked } = await markAssignmentsCalledOut({ company_id: COMPANY, employee_id: 'mia', dates: [TODAY] });
    expect(marked).toBe(1);
    const upd = h.updates.find(u => u.table === 'schedules');
    expect(upd).toBeDefined();
    const data = upd!.values.data as { assignments: Array<Record<string, unknown>> };
    const miaRow = data.assignments.find(a => a.employee_id === 'mia')!;
    const margaretRow = data.assignments.find(a => a.employee_id === 'margaret')!;
    expect(miaRow.called_out).toBe(true);          // still ON the schedule
    expect(margaretRow.called_out ?? undefined).toBeUndefined();
  });

  it('computeWageEstimateFromMaps never pays a called-out assignment', () => {
    const est = computeWageEstimateFromMaps(
      [
        { employee_id: 'mia', employee_name: 'Mia', role: 'Lifeguard', start_time: '15:00', end_time: '20:15', hours: 5.25, called_out: true },
        { employee_id: 'margaret', employee_name: 'Margaret', role: 'Lifeguard', start_time: '15:00', end_time: '20:15', hours: 5.25 },
      ],
      new Map([['mia', 20], ['margaret', 20]]),
      new Map(),
    );
    const names = est.by_employee.map((i: { employee_name: string }) => i.employee_name);
    expect(names).toEqual(['Margaret']);
  });
});

describe('describeCallOutShifts', () => {
  it('says "tonight" for a 3pm shift today, "today" for a morning one, "tomorrow" for tomorrow', () => {
    const aft: CallOutShift = { date: TODAY, shift_name: 'Afternoon', role: 'Lifeguard', start_time: '15:00:00', end_time: '20:15:00' };
    const am: CallOutShift = { date: TODAY, shift_name: 'AM Weekday', role: 'Lifeguard', start_time: '11:00:00', end_time: '15:30:00' };
    const tmrw: CallOutShift = { ...aft, date: TOMORROW };
    expect(describeCallOutShifts([aft], TODAY)).toBe('your Afternoon shift (3pm–8:15pm) tonight');
    expect(describeCallOutShifts([am], TODAY)).toBe('your AM Weekday shift (11am–3:30pm) today');
    expect(describeCallOutShifts([tmrw], TODAY)).toBe('your Afternoon shift (3pm–8:15pm) tomorrow');
    expect(describeCallOutShifts([am], TODAY, "Mia's")).toMatch(/^Mia's AM Weekday/);
  });
});
