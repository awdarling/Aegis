import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Batch-1 F8: day-closure fan-out notifies the whole day roster, SMS-first ────
//
// notifyDayClosureCore reads the day's assignments from the schedule and notifies
// EVERY scheduled employee (SMS-first + email fallback). Replaces the fragile
// Homebase→public-webhook impersonation that notified nobody. Drives the REAL
// core; DB + transport mocked.

const h = vi.hoisted(() => ({
  sendSmsMock: vi.fn(async () => true),
  sendEmailMock: vi.fn(async () => true),
  scheduleData: {
    assignments: [
      { employee_id: 'e1', date: '2026-08-15', shift_name: 'Morning' },
      { employee_id: 'e2', date: '2026-08-15', shift_name: 'Evening' },
      { employee_id: 'e3', date: '2026-08-16', shift_name: 'Morning' }, // different day — must be ignored
    ],
  } as Record<string, unknown>,
}));

vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: false, SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', ANTHROPIC_API_KEY: 'x', SENDGRID_FROM_EMAIL: 'a@b.c', BASE_URL: 'http://x' } }));

function makeBuilder(table: string) {
  const builder: Record<string, unknown> = {
    select() { return builder; },
    eq() { return builder; },
    in() { return builder; },
    is() { return builder; },
    insert() { return Promise.resolve({ error: null }); },
    single() {
      if (table === 'schedules') return Promise.resolve({ data: { id: 'sched-1', company_id: 'c1', data: h.scheduleData }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    maybeSingle() {
      if (table === 'companies') return Promise.resolve({ data: { name: 'Watermark' }, error: null });
      if (table === 'company_channels') return Promise.resolve({ data: { channel_value: '+16166164898' }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    then(onF: (v: { data: unknown; error: null }) => unknown, onR?: (e: unknown) => unknown) {
      const data = table === 'employees'
        ? [
            { id: 'e1', name: 'Luka', contact_phone: '+16167170847', contact_email: 'luka@x.com' },
            { id: 'e2', name: 'Sam', contact_phone: null, contact_email: 'sam@x.com' },
          ]
        : null;
      return Promise.resolve({ data, error: null }).then(onF, onR);
    },
  };
  return builder;
}

vi.mock('../../db/client', () => ({ supabase: { from: (t: string) => makeBuilder(t) } }));
vi.mock('../../messaging/sms', () => ({ sendSms: h.sendSmsMock }));
vi.mock('../../messaging/email', () => ({ sendEmail: h.sendEmailMock }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn(), normalizeReSubject: (s: string) => s }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));

import { notifyDayClosureCore } from '../day-closure';

beforeEach(() => { h.sendSmsMock.mockClear(); h.sendEmailMock.mockClear(); });

describe('notifyDayClosureCore (Batch-1 F8)', () => {
  it('notifies every employee scheduled that day — SMS-first, email fallback', async () => {
    const r = await notifyDayClosureCore('c1', 'sched-1', '2026-08-15');
    expect(r.total_scheduled).toBe(2);       // e3 is on a different day — excluded
    expect(r.notified).toBe(2);
    expect(r.texted).toBe(1);                 // Luka (phone)
    expect(r.emailed).toBe(1);                // Sam (no phone → email fallback)
    expect(h.sendSmsMock).toHaveBeenCalledTimes(1);
    expect(h.sendSmsMock.mock.calls[0][0]).toMatchObject({ to: '+16167170847' });
    expect(h.sendEmailMock).toHaveBeenCalledTimes(1);
    expect(h.sendEmailMock.mock.calls[0][0]).toMatchObject({ to: 'sam@x.com' });
  });

  it('returns notified:0 when nobody is scheduled that day', async () => {
    const r = await notifyDayClosureCore('c1', 'sched-1', '2026-12-25');
    expect(r.notified).toBe(0);
    expect(r.total_scheduled).toBe(0);
    expect(h.sendSmsMock).not.toHaveBeenCalled();
    expect(h.sendEmailMock).not.toHaveBeenCalled();
  });
});
