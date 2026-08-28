import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── W-2 branch 5 (Alexander, 2026-08-28): the manager answers the call-out
// nudge BY TEXT — "find coverage", "approve — I've got it", "deny" — and it
// does exactly what the matching email button does (one shared decision core,
// applyTimeOffDecision). A bare yes/no earns one clarifying question, never a
// guess; a second decision through either door reports "already handled";
// an unrelated manager message is never swallowed.

const h = vi.hoisted(() => {
  const inserts: Array<{ table: string; rows: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; values: Record<string, unknown>; filters: Record<string, unknown> }> = [];
  const memoryStore = new Map<string, { id: string; content: string }>();
  let memSeq = 0;
  const state = {
    employees: [] as Array<Record<string, unknown>>,
    torRows: [] as Array<Record<string, unknown>>,
    assignments: [] as Array<Record<string, unknown>>,
    availability: [] as Array<Record<string, unknown>>,
  };
  function makeBuilder(table: string) {
    const f: Record<string, unknown> = {};
    const likes: Array<[string, string]> = [];
    const memEntries = () => [...memoryStore.entries()].map(([source, row]) => ({ source, id: row.id, content: row.content }));
    const filteredMem = () => {
      let rows = memEntries();
      for (const [col, pat] of likes) {
        if (col === 'source') { const p = pat.replace(/%$/, '').replace(/^%/, ''); rows = rows.filter(r => pat.startsWith('%') ? r.source.includes(p) : r.source.startsWith(p)); }
        if (col === 'content') { const n = pat.replace(/^%|%$/g, ''); rows = rows.filter(r => r.content.includes(n)); }
      }
      if (f.source) rows = rows.filter(r => r.source === f.source);
      return rows;
    };
    const filteredTor = () => {
      let rows = state.torRows;
      if (f.id) rows = rows.filter(r => r.id === f.id);
      return rows;
    };
    const one = () => {
      if (table === 'employees') return (f.id ? state.employees.find(e => e.id === f.id) : state.employees[0]) ?? null;
      if (table === 'companies') return { name: 'Watermark', timezone: 'America/Detroit' };
      if (table === 'company_channels') return { channel_value: '+16166164898' };
      if (table === 'schedules') return f.status === 'published' ? { id: 'sched-1', data: { assignments: state.assignments }, staffing_report: {} } : null;
      if (table === 'time_off_requests') return filteredTor()[0] ?? null;
      if (table === 'aegis_memory') return filteredMem()[0] ?? null;
      return null;
    };
    const list = () => {
      if (table === 'employees') return state.employees;
      if (table === 'availability') return state.availability;
      if (table === 'time_off_requests') return filteredTor();
      if (table === 'policies') return [];
      if (table === 'wage_rates') return [];
      if (table === 'shift_types') return [];
      if (table === 'aegis_memory') return filteredMem();
      return [];
    };
    const b: Record<string, unknown> = {
      select() { return b; },
      eq(col: string, val: unknown) { f[col] = val; return b; },
      neq() { return b; }, or() { return b; }, ilike() { return b; },
      like(col: string, pat: string) { likes.push([col, pat]); return b; },
      in() { return b; }, is() { return b; },
      lte() { return b; }, gte() { return b; }, lt() { return b; }, gt() { return b; },
      order() { return b; }, limit() { return b; },
      insert(rows: Record<string, unknown>) {
        inserts.push({ table, rows });
        if (table === 'aegis_memory') memoryStore.set(String(rows.source), { id: `mem-${++memSeq}`, content: String(rows.content) });
        return b;
      },
      update(values: Record<string, unknown>) {
        return {
          eq(col: string, val: unknown) {
            f[col] = val;
            if (table === 'aegis_memory' && col === 'id') {
              for (const [src, row] of memoryStore.entries()) if (row.id === val) memoryStore.set(src, { ...row, content: String(values.content) });
            }
            return this;
          },
          then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
            updates.push({ table, values, filters: { ...f } });
            if (table === 'time_off_requests') {
              for (const r of state.torRows) {
                if (r.id === f.id && (!('status' in f) || f.status !== 'pending' || r.status === 'pending')) {
                  if (f.status === 'pending' && r.status !== 'pending') continue;
                  Object.assign(r, values);
                }
              }
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
    inserts, updates, state, memoryStore, makeBuilder,
    createMock: vi.fn(),
    replyMock: vi.fn(async () => {}),
    sendSmsMock: vi.fn(async () => true),
    sendEmailMock: vi.fn(async () => {}),
    JACK: { userId: 'u-jack', employeeId: 'e-jack', name: 'Jack McCorkle', role: 'manager' as const, email: 'jack@wm.test', phone: '+16165550999', linkSource: 'employee_id' },
  };
});

vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: h.createMock }; } }));
vi.mock('../../ai/claude', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ai/claude')>();
  return { ...actual, withAnthropicRetry: (fn: () => unknown) => fn(), classifyIntent: vi.fn(), generateReply: vi.fn() };
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

import {
  parseCallOutDecisionReply,
  storeCallOutDecisionPending,
  getPendingCallOutDecisions,
  handleCallOutDecisionReply,
  type TimeOffDecisionContext,
} from '../callout-decision';
import { todayInTimezone, addDays } from '../../lib/tenant-date';
import type { InboundMessage, VerifiedContact } from '../../security/types';

const COMPANY = 'c-wm';
const AEGIS = '+16166164898';
const TODAY = todayInTimezone('America/Detroit');

const MIA = { id: 'mia', name: 'Mia Shaffer', contact_phone: '+16165550123', contact_email: null, company_id: COMPANY, primary_role: 'Lifeguard', active: true, qualified_roles: ['Lifeguard'], max_weekly_hours: 40 };
const MARGARET = { id: 'margaret', name: 'Margaret Holt', contact_phone: '+16165550124', contact_email: null, company_id: COMPANY, primary_role: 'Lifeguard', active: true, qualified_roles: ['Lifeguard'], max_weekly_hours: 40 };
const ROSA = { id: 'rosa', name: 'Rosa Alvarez', contact_phone: '+16165550125', contact_email: null, company_id: COMPANY, primary_role: 'Lifeguard', active: true, qualified_roles: ['Lifeguard'], max_weekly_hours: 40 };
const KATIE = { id: 'katie', name: 'Katie Schillaci', contact_phone: '+16165550126', contact_email: null, company_id: COMPANY, primary_role: 'Lifeguard', active: true, qualified_roles: ['Lifeguard'], max_weekly_hours: 40 };

const jackContact: VerifiedContact = { role: 'manager', company_id: COMPANY, employee_id: 'e-jack', user_id: 'u-jack', name: 'Jack McCorkle', matched_identifier: h.JACK.phone, channel: 'sms' };
const jackMsg = (body: string): InboundMessage => ({ sender: h.JACK.phone, recipient: AEGIS, body, channel: 'sms' });

const replies = () => h.replyMock.mock.calls.map(c => c[2] as string);
const texts = () => h.sendSmsMock.mock.calls.map(c => (c[0] as { body: string; to: string }));

function ctxFor(requestId: string, employee: { id: string; name: string; contact_phone: string }, shiftName = 'Afternoon'): TimeOffDecisionContext {
  return {
    request_id: requestId,
    company_id: COMPANY,
    employee_id: employee.id,
    employee_name: employee.name,
    employee_channel: 'sms',
    employee_contact: employee.contact_phone,
    aegis_sms_channel: AEGIS,
    manager_user_id: 'u-jack',
    manager_name: 'Jack McCorkle',
    call_out: [{ date: TODAY, shift_name: shiftName, role: 'Lifeguard', start_time: '15:00:00', end_time: '20:15:00' }],
  };
}

async function seedCallOut(requestId: string, employee: { id: string; name: string; contact_phone: string }, shiftName = 'Afternoon'): Promise<void> {
  h.state.torRows.push({ id: requestId, company_id: COMPANY, employee_id: employee.id, status: 'pending', start_date: TODAY, end_date: TODAY, reason: 'sick' });
  await storeCallOutDecisionPending('u-jack', ctxFor(requestId, employee, shiftName));
  // A live email token that must die the moment the text decides.
  h.memoryStore.set(`decision_token:tok-${requestId}`, { id: `mem-tok-${requestId}`, content: JSON.stringify({ request_id: requestId, action: 'approve' }) });
}

beforeEach(() => {
  h.inserts.length = 0;
  h.updates.length = 0;
  h.memoryStore.clear();
  h.replyMock.mockClear();
  h.sendSmsMock.mockClear();
  h.sendEmailMock.mockClear();
  h.state.employees = [MIA, MARGARET, ROSA, KATIE];
  h.state.torRows = [];
  h.state.assignments = [
    { date: TODAY, employee_id: 'mia', employee_name: 'Mia Shaffer', shift_name: 'Afternoon', role: 'Lifeguard', start_time: '15:00:00', end_time: '20:15:00', hours: 5.25 },
  ];
  h.state.availability = ['margaret', 'rosa', 'mia', 'katie'].flatMap(id =>
    [0, 1, 2, 3, 4, 5, 6].map(d => ({ employee_id: id, day_of_week: d, start_time: '00:00', end_time: '23:59' })));
});

describe('parseCallOutDecisionReply', () => {
  it('reads the three answers in a manager\'s own words', () => {
    expect(parseCallOutDecisionReply('find coverage')).toEqual({ kind: 'action', action: 'approve_and_cover' });
    expect(parseCallOutDecisionReply('approve and cover it')).toEqual({ kind: 'action', action: 'approve_and_cover' });
    expect(parseCallOutDecisionReply('ask the team')).toEqual({ kind: 'action', action: 'approve_and_cover' });
    expect(parseCallOutDecisionReply("approve — I've got it")).toEqual({ kind: 'action', action: 'approve' });
    expect(parseCallOutDecisionReply("i'll handle it")).toEqual({ kind: 'action', action: 'approve' });
    expect(parseCallOutDecisionReply('deny')).toEqual({ kind: 'action', action: 'deny' });
    expect(parseCallOutDecisionReply('she has to come in')).toEqual({ kind: 'action', action: 'deny' });
    expect(parseCallOutDecisionReply('approve')).toEqual({ kind: 'yes' });   // who covers? → clarify
    expect(parseCallOutDecisionReply('yes')).toEqual({ kind: 'yes' });
    expect(parseCallOutDecisionReply('no')).toEqual({ kind: 'no' });
    expect(parseCallOutDecisionReply('build the schedule for next week')).toEqual({ kind: 'none' });
  });
});

describe('Jack answers the nudge by text', () => {
  it('"find coverage" approves AND blasts the pool (never Mia), retires the email tokens, tells Jack', async () => {
    await seedCallOut('req-1', MIA);
    const handled = await handleCallOutDecisionReply(jackMsg('find coverage'), jackContact);
    expect(handled).toBe(true);

    const tor = h.state.torRows[0];
    expect(tor.status).toBe('approved');
    // Coverage went out to teammates, never the caller (Mia's only text is her
    // decision notice — she is never asked to cover her own shift).
    const outreach = texts().filter(t => /can you come in/i.test(t.body));
    expect(outreach.map(t => t.to)).toContain(MARGARET.contact_phone);
    expect(outreach.map(t => t.to)).not.toContain(MIA.contact_phone);
    // Mia is told she's off and covered-for.
    const miaTexts = texts().filter(t => t.to === MIA.contact_phone).map(t => t.body).join('\n');
    expect(miaTexts).toMatch(/approved your call-out/i);
    expect(miaTexts).toMatch(/reaching out to teammates/i);
    expect(miaTexts).not.toMatch(/can you come in/i); // never outreached to cover her own shift
    // Jack's receipt.
    expect(replies().join('\n')).toMatch(/texting \d+ qualified teammate/i);
    // The stale email button token is gone; so is the pending reply state.
    expect(h.memoryStore.has('decision_token:tok-req-1')).toBe(false);
    expect((await getPendingCallOutDecisions(COMPANY, 'u-jack')).length).toBe(0);
  });

  it('"approve — I\'ve got it" approves WITHOUT coverage and marks the shift greyed', async () => {
    await seedCallOut('req-2', MIA);
    await handleCallOutDecisionReply(jackMsg("approve — I've got it"), jackContact);
    expect(h.state.torRows[0].status).toBe('approved');
    // No coverage outreach went out.
    expect(h.memoryStore.size === 0 || ![...h.memoryStore.keys()].some(k => k.startsWith('coverage_session:'))).toBe(true);
    // The schedule write kept the assignment, marked called_out.
    const schedUpd = h.updates.find(u => u.table === 'schedules');
    expect(schedUpd).toBeDefined();
    const data = schedUpd!.values.data as { assignments: Array<Record<string, unknown>> };
    expect(data.assignments.find(a => a.employee_id === 'mia')!.called_out).toBe(true);
    expect(replies().join('\n')).toMatch(/stays on the schedule, greyed out/i);
  });

  it('"deny" denies and Mia is told she is still expected', async () => {
    await seedCallOut('req-3', MIA);
    await handleCallOutDecisionReply(jackMsg('deny'), jackContact);
    expect(h.state.torRows[0].status).toBe('denied');
    const miaTexts = texts().filter(t => t.to === MIA.contact_phone).map(t => t.body).join('\n');
    expect(miaTexts).toMatch(/still expected/i);
    expect(replies().join('\n')).toMatch(/denied/i);
  });

  it('a bare "yes" earns ONE clarifying question; "I\'ve got it" then approves without coverage', async () => {
    await seedCallOut('req-4', MIA);
    await handleCallOutDecisionReply(jackMsg('yes'), jackContact);
    expect(h.state.torRows[0].status).toBe('pending'); // nothing acted yet
    expect(replies()[0]).toMatch(/find coverage .* too, or have you got it\?/i);
    h.replyMock.mockClear();
    await handleCallOutDecisionReply(jackMsg("I've got it"), jackContact);
    expect(h.state.torRows[0].status).toBe('approved');
    expect(replies().join('\n')).toMatch(/stays on the schedule/i);
  });

  it('a bare "no" confirms before denying', async () => {
    await seedCallOut('req-5', MIA);
    await handleCallOutDecisionReply(jackMsg('no'), jackContact);
    expect(h.state.torRows[0].status).toBe('pending');
    expect(replies()[0]).toMatch(/Just to be sure — deny Mia's call-out\?/);
    h.replyMock.mockClear();
    await handleCallOutDecisionReply(jackMsg('yes'), jackContact);
    expect(h.state.torRows[0].status).toBe('denied');
  });

  it('a decision through the OTHER door already landed → "already handled", nothing changes', async () => {
    await seedCallOut('req-6', MIA);
    h.state.torRows[0].status = 'approved'; // the email button won the race
    const handled = await handleCallOutDecisionReply(jackMsg('deny'), jackContact);
    // The stale pending row is cleaned; with none left the gate declines the message…
    expect(handled).toBe(false);
    expect(h.state.torRows[0].status).toBe('approved');
  });

  it('two open call-outs → asks which; "find coverage for Mia" resolves by name', async () => {
    await seedCallOut('req-7', MIA, 'Afternoon');
    await seedCallOut('req-8', KATIE, 'AM Weekday');
    await handleCallOutDecisionReply(jackMsg('find coverage'), jackContact);
    expect(replies()[0]).toMatch(/2 call-outs waiting/i);
    expect(h.state.torRows.every(r => r.status === 'pending')).toBe(true);
    h.replyMock.mockClear();
    await handleCallOutDecisionReply(jackMsg('find coverage for Mia'), jackContact);
    expect(h.state.torRows.find(r => r.id === 'req-7')!.status).toBe('approved');
    expect(h.state.torRows.find(r => r.id === 'req-8')!.status).toBe('pending'); // Katie's untouched
  });

  it('an unrelated manager message falls through untouched', async () => {
    await seedCallOut('req-9', MIA);
    const handled = await handleCallOutDecisionReply(jackMsg('build the schedule for next week'), jackContact);
    expect(handled).toBe(false);
    expect(h.state.torRows[0].status).toBe('pending');
    expect(h.replyMock).not.toHaveBeenCalled();
  });
});
