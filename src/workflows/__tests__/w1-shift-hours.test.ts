import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── W-1 branch 2 (J-1a, C-4, J-1b): shift words mean the club's REAL shifts ───
//
// Named after the transcripts they fix (audits of 2026-08-26):
//   • Mia Shaffer, Aug 11 (onboarding) — "Next week I can only work pm shifts
//     Monday through Friday" → an AVAILABILITY change, not a time-off request.
//   • Mia, Aug 14 — "I want to work the am shifts next week" → an override that
//     COVERS the AM shifts (Mon–Fri 11:00–15:30, Sat/Sun 09:00–15:30), and the
//     confirm names them. (It was 09:00–12:00 → she got zero shifts.)
//   • Katie Schillaci — "I cannot work Friday August 21st in the morning" with an
//     11:00–15:30 AM Weekday assignment → THAT shift, hours in the confirm.
//   • Mia, Aug 21 — "I'm sick and I can't make it tonight" with NO shift that day
//     → asks ("you're not on the schedule"), never invents 17:00–21:00.

const h = vi.hoisted(() => {
  const inserts: Array<{ table: string; rows: Record<string, unknown> }> = [];
  const state = {
    employee: null as Record<string, unknown> | null,
    normal: [] as Array<Record<string, unknown>>,
    assignments: [] as Array<Record<string, unknown>>,
    scheduleExists: true,
  };
  const WM_SHIFTS = [
    { id: 'am-we', name: 'AM Weekend', start_time: '09:00:00', end_time: '15:30:00', days_active: [0, 6], active: true },
    { id: 'am-wd', name: 'AM Weekday', start_time: '11:00:00', end_time: '15:30:00', days_active: [1, 2, 3, 4, 5], active: true },
    { id: 'gr-we', name: 'Weekend Greeter', start_time: '11:00:00', end_time: '19:30:00', days_active: [0, 6], active: true },
    { id: 'gr-wd', name: 'Weekday Greeter', start_time: '12:00:00', end_time: '19:30:00', days_active: [1, 2, 3, 4, 5], active: true },
    { id: 'aft', name: 'Afternoon', start_time: '15:00:00', end_time: '20:15:00', days_active: [0, 1, 2, 3, 4, 5, 6], active: true },
  ];
  function makeBuilder(table: string) {
    const f: Record<string, unknown> = {};
    const one = () => {
      if (table === 'employees') return state.employee;
      if (table === 'companies') return { name: 'Watermark', timezone: 'America/Detroit' };
      if (table === 'schedules') return state.scheduleExists && f.status === 'published' ? { id: 'sched-1', data: { assignments: state.assignments } } : null;
      return null;
    };
    const list = () => {
      if (table === 'shift_types') return WM_SHIFTS;
      if (table === 'availability') return state.normal;
      if (table === 'custom_availability') return [];
      if (table === 'employees') return state.employee ? [state.employee] : [];
      return [];
    };
    const b: Record<string, unknown> = {
      select() { return b; },
      eq(col: string, val: unknown) { f[col] = val; return b; },
      neq() { return b; }, like() { return b; }, in() { return b; }, is() { return b; },
      lte() { return b; }, gte() { return b; }, lt() { return b; }, gt() { return b; },
      order() { return b; }, limit() { return b; },
      insert(rows: Record<string, unknown>) { inserts.push({ table, rows }); return b; },
      update() { return b; }, delete() { return b; },
      maybeSingle() { return Promise.resolve({ data: one(), error: null }); },
      single() { return Promise.resolve({ data: one(), error: null }); },
      then(onF: (v: { data: unknown; error: null }) => unknown, onR?: (e: unknown) => unknown) {
        return Promise.resolve({ data: list(), error: null }).then(onF, onR);
      },
    };
    return b;
  }
  return {
    inserts, state, makeBuilder,
    createMock: vi.fn(),
    replyMock: vi.fn(async () => {}),
    sendSmsMock: vi.fn(async () => true),
    sendEmailMock: vi.fn(async () => {}),
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

import { handleUpdateAvailability, handleOnboardingResponse, type OnboardingSession } from '../employee-onboarding';
import { handleSubmitTimeOff } from '../time-off';
import type { InboundMessage, VerifiedContact } from '../../security/types';

const COMPANY = 'c-wm';
const PHONE = '+16165550123';
const AEGIS = '+16166164898';
const contactFor = (id: string, name: string): VerifiedContact =>
  ({ role: 'employee', company_id: COMPANY, employee_id: id, user_id: null, name, matched_identifier: PHONE, channel: 'sms' });
const msg = (body: string): InboundMessage => ({ sender: PHONE, recipient: AEGIS, body, channel: 'sms' });
const txt = (t: string) => ({ content: [{ type: 'text', text: t }] });

const replies = () => h.replyMock.mock.calls.map(c => c[2] as string);
const texts = () => h.sendSmsMock.mock.calls.map(c => (c[0] as { body: string }).body);
const memory = (prefix: string) => h.inserts.filter(i => i.table === 'aegis_memory' && String(i.rows.source).startsWith(prefix)).map(i => JSON.parse(String(i.rows.content)) as Record<string, unknown>);

beforeEach(() => {
  h.inserts.length = 0;
  h.replyMock.mockClear();
  h.sendSmsMock.mockClear();
  h.sendEmailMock.mockClear();
  h.createMock.mockReset();
  h.state.employee = { id: 'mia', name: 'Mia Shaffer', contact_phone: PHONE, contact_email: null, company_id: COMPANY, primary_role: 'Lifeguard', active: true, qualified_roles: ['Lifeguard'] };
  h.state.normal = [{ day_of_week: 1, start_time: '09:00', end_time: '20:15' }];
  h.state.assignments = [];
  h.state.scheduleExists = true;
});

describe('Mia Shaffer, Aug 14 — "I want to work the am shifts next week"', () => {
  it('→ a temporary override that COVERS the AM shifts, per day, and the confirm names them', async () => {
    // The model's own (buggy) reading: 09:00–12:00 every day. The resolver must override it.
    h.createMock.mockResolvedValue(txt(JSON.stringify({
      mode: 'set', scope: 'exclusive',
      slots: [0, 1, 2, 3, 4, 5, 6].map(d => ({ day_of_week: d, start_time: '09:00', end_time: '12:00' })),
    })));
    await handleUpdateAvailability(msg('I want to work the am shifts next week'), contactFor('mia', 'Mia Shaffer'), { end_date: '2026-08-23' });

    const pending = memory('avail_pending_confirm:')[0];
    expect(pending).toBeDefined();
    const slots = pending.proposed_availability as Array<{ day_of_week: number; start_time: string; end_time: string }>;
    const byDay = Object.fromEntries(slots.map(s => [s.day_of_week, `${s.start_time}-${s.end_time}`]));
    expect(byDay[1]).toBe('11:00-15:30');   // AM Weekday
    expect(byDay[5]).toBe('11:00-15:30');
    expect(byDay[6]).toBe('09:00-15:30');   // AM Weekend
    expect(byDay[0]).toBe('09:00-15:30');
    expect(slots.some(s => s.end_time === '12:00')).toBe(false);
    expect(pending.custom_end_date).toBe('2026-08-23');

    const body = replies().join('\n');
    expect(body).toMatch(/AM Weekend \(9am–3:30pm\)/);
    expect(body).toMatch(/AM Weekday \(11am–3:30pm\)/);
    expect(body).not.toMatch(/12:00|noon/);
  });
});

describe('Mia Shaffer, Aug 11 (onboarding) — "Next week I can only work pm shifts Monday through Friday"', () => {
  function session(): OnboardingSession & { _memory_id: string } {
    return {
      company_id: COMPANY, employee_id: 'mia', employee_name: 'Mia Shaffer',
      employee_phone: PHONE, employee_email: null, employee_channel: 'sms', aegis_sms_channel: AEGIS,
      manager_contact: 'jack@wm.test', manager_channel: 'email', manager_sender: 'jack@wm.test', manager_recipient: 'aegis@x',
      step: 'time_off',
      collected: { name_confirmed: true, email: null, role: 'Lifeguard', availability_raw: 'any', availability_parsed: [{ day_of_week: 1, start_time: '09:00', end_time: '20:15' }], availability_confirmed: true, time_off_submitted: false },
      flagged_low_availability: false, invalid_email_attempts: 0, invalid_availability_attempts: 0,
      warned_24h: false, opt_in_confirmed: true, opt_in_sent_at: new Date().toISOString(),
      started_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(), _memory_id: 'm1',
    };
  }
  it('→ availability change (pm shifts Mon–Fri, through the end of that week), NO time-off request', async () => {
    h.createMock.mockImplementation(async (args: { system?: string }) => {
      const sys = args.system ?? '';
      if (sys.includes('Extract time-off dates')) {
        return txt(JSON.stringify({ dates: [{ start_date: '2026-08-17', end_date: '2026-08-21', time_off_type: 'partial', period_label: 'morning' }] }));
      }
      if (sys.includes('availability-change message')) {
        return txt(JSON.stringify({ mode: 'set', scope: 'exclusive', slots: [1, 2, 3, 4, 5].map(d => ({ day_of_week: d, start_time: '12:00', end_time: '20:15' })) }));
      }
      return txt('{}');
    });
    await handleOnboardingResponse(msg('Next week I can only work pm shifts Monday through Friday'), contactFor('mia', 'Mia Shaffer'), session());

    // No time-off request of any kind was created or staged.
    expect(h.inserts.some(i => i.table === 'time_off_requests')).toBe(false);
    expect(memory('pending_to:').length).toBe(0);
    expect(texts().join('\n')).not.toMatch(/time off I'll send|partial day/i);
    // The availability path ran with her words: a temporary change through Aug 21, pm hours Mon–Fri.
    const pending = memory('avail_pending_confirm:')[0];
    expect(pending).toBeDefined();
    expect(pending.custom_end_date).toBe('2026-08-21');
    const slots = pending.proposed_availability as Array<{ day_of_week: number; start_time: string; end_time: string }>;
    expect(slots.map(s => s.day_of_week).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(slots.every(s => s.start_time === '12:00' && s.end_time === '20:15')).toBe(true);
    expect(replies().join('\n')).toMatch(/Afternoon \(3pm–8:15pm\)/);
  });
});

describe('Katie Schillaci — "I cannot work Friday August 21st in the morning" with an 11:00–15:30 AM Weekday shift', () => {
  it('→ that shift, hours in the confirm, shift_name recorded', async () => {
    h.state.employee = { ...h.state.employee!, id: 'katie', name: 'Katie Schillaci' };
    h.state.assignments = [{ date: '2026-08-21', employee_id: 'katie', employee_name: 'Katie Schillaci', shift_name: 'AM Weekday', role: 'Lifeguard', start_time: '11:00:00', end_time: '15:30:00', hours: 4.5 }];
    await handleSubmitTimeOff(msg('I cannot work Friday August 21st in the morning. THIS IS FOR COMPETITION.'), contactFor('katie', 'Katie Schillaci'), {
      dates: [{ start_date: '2026-08-21', end_date: '2026-08-21', time_off_type: 'partial', period_label: 'morning', start_time: null, end_time: null }],
      reason: 'the competition',
    });
    const pending = memory('pending_to:')[0];
    expect(pending.time_off_type).toBe('partial');
    const pd = pending.partial_days as Array<Record<string, unknown>>;
    expect(pd[0].start_time).toBe('11:00');
    expect(pd[0].end_time).toBe('15:30');
    expect(pd[0].shift_name).toBe('AM Weekday');
    expect(pd[0].shift_id).toBe('am-wd');
    const body = replies()[0];
    expect(body).toMatch(/your AM Weekday shift \(11am–3:30pm\) on Friday, August 21/);
    expect(body).not.toMatch(/09:00|9am–1pm|13:00/);
  });
});

describe('Mia Shaffer, Aug 21 — "I\'m sick and I can\'t make it tonight" with NO shift that day', () => {
  it('→ asks (not on the schedule), never invents 17:00–21:00', async () => {
    h.state.assignments = [];
    await handleSubmitTimeOff(msg("I'm sick and I can't make it tonight"), contactFor('mia', 'Mia Shaffer'), {
      dates: [{ start_date: '2026-08-21', end_date: '2026-08-21', time_off_type: 'partial', period_label: 'evening', start_time: null, end_time: null }],
      reason: 'illness',
    });
    const body = replies()[0];
    expect(body).toMatch(/not on the schedule that day/i);
    expect(body).toMatch(/\?/);
    expect(body).not.toMatch(/17:00|5pm|21:00|9pm/);
    const pending = memory('pending_to:')[0];
    expect(pending.time_off_type).toBe('full_day');   // a "yes" logs a plain day off
    expect(pending.partial_days).toBeNull();
  });
});
