import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── L5 — the onboarding sweepers. THE FIRST TESTS THESE HAVE EVER HAD. ───────
//
// `checkStaleOnboardingSessions` (the 24h "hasn't finished" warning) and
// `expireOldOnboardingSessions` (the 48h reaper) had ZERO test coverage —
// `src/scheduler/` has no __tests__ directory at all — and between them they
// produced the false manager alerts that started this whole investigation.
//
// THE LIVE FACTS (read-only, 2026-08-16). Bennet Nieukoop and Rosa Thornburg:
//   onboarding_started 8/11 → 24h warning 8/12 → timeout 8/13
//   → re-started 8/13 → employee_opt_in_confirmed 8/13
//   → 24h warning AGAIN 8/15 → timeout AGAIN 8/16
// with role, email and 6–7 availability rows all on file, and NO
// onboarding_complete ever. Both sweepers knew only "the walk hasn't reached its
// last step". Neither consulted consent, and neither asked whether anything was
// actually still missing.
//
// These tests reconstruct that exact shape and pin that it can't happen again.

const h = vi.hoisted(() => ({
  memoryRows: [] as Array<{ id: string; company_id: string; content: string }>,
  employeeRow: null as Record<string, unknown> | null,
  availabilityPresent: false,
  deletes: [] as string[],
  updates: [] as Array<{ id: string; content: string }>,
  activity: [] as Array<Record<string, unknown>>,
  replies: [] as string[],
}));

vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local', SUPABASE_SERVICE_ROLE_KEY: 'test',
    BASE_URL: 'https://test.local', ANTHROPIC_API_KEY: 'test',
    SENDGRID_API_KEY: 'test', SENDGRID_FROM_EMAIL: 'a@test.local', EMAIL_ONLY: true,
  },
}));

vi.mock('../../db/client', () => ({
  supabase: {
    from(table: string) {
      let pendingId: string | null = null;
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.like = () => b;
      b.eq = (col: string, val: unknown) => { if (col === 'id') pendingId = String(val); return b; };
      b.is = () => b;
      b.order = () => b;
      b.limit = () => b;
      b.update = (patch: Record<string, unknown>) => {
        const target = { ...b } as Record<string, unknown>;
        target.eq = (col: string, val: unknown) => {
          if (col === 'id' && table === 'aegis_memory') {
            h.updates.push({ id: String(val), content: String(patch.content ?? '') });
          }
          return Promise.resolve({ error: null });
        };
        return target;
      };
      b.delete = () => {
        const target = { ...b } as Record<string, unknown>;
        target.eq = (col: string, val: unknown) => {
          if (col === 'id') h.deletes.push(String(val));
          return Promise.resolve({ error: null });
        };
        return target;
      };
      b.insert = () => Promise.resolve({ error: null });
      b.maybeSingle = async () => ({
        data: table === 'employees' ? h.employeeRow : null,
        error: null,
      });
      b.single = async () => ({ data: table === 'employees' ? h.employeeRow : null, error: null });
      b.then = (res: (v: unknown) => unknown) => {
        void pendingId;
        if (table === 'aegis_memory') return Promise.resolve(res({ data: h.memoryRows, error: null }));
        if (table === 'availability') {
          return Promise.resolve(res({ data: h.availabilityPresent ? [{ employee_id: 'x' }] : [], error: null }));
        }
        return Promise.resolve(res({ data: [], error: null }));
      };
      return b;
    },
  },
}));

vi.mock('../../logger/activity-log', () => ({
  logActivity: vi.fn(async (o: Record<string, unknown>) => { h.activity.push(o); }),
}));
vi.mock('../../messaging/reply', () => ({
  reply: vi.fn(async (_c: unknown, _m: unknown, text: string) => { h.replies.push(text); }),
  sendInThreadAck: vi.fn(),
}));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn(async () => true), getTenantSmsNumber: vi.fn(async () => null) }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn(async () => true) }));
vi.mock('../../messaging/consent', () => ({ setEmployeeConsentState: vi.fn() }));
vi.mock('../../messaging/notify', () => ({ getAegisSmsChannel: vi.fn(async () => null) }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() } } }));
vi.mock('../../ai/claude', () => ({ withAnthropicRetry: (fn: () => unknown) => fn() }));

import { checkStaleOnboardingSessions, expireOldOnboardingSessions } from '../employee-onboarding';

const COMPANY = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const EMP = '774acc69-556b-4289-a846-e790f8615a7c';
const HOURS = 60 * 60 * 1000;

/** Bennet's real session shape at the moment the sweepers hit him. */
function session(over: Record<string, unknown> = {}) {
  return {
    company_id: COMPANY,
    employee_id: EMP,
    employee_name: 'Bennet Nieukoop',
    employee_phone: '+16165550001',
    employee_email: 'bennet@club.com',
    employee_channel: 'sms',
    aegis_sms_channel: '+16166164898',
    manager_contact: 'jack@club.com',
    manager_channel: 'email',
    manager_sender: 'jack@club.com',
    manager_recipient: 'aegis@club.com',
    step: 'time_off',            // parked on the OPTIONAL question
    collected: {
      name_confirmed: true, email: null, role: null, availability_raw: null,
      availability_parsed: [], availability_confirmed: false, time_off_submitted: false,
    },
    flagged_low_availability: false,
    invalid_email_attempts: 0,
    invalid_availability_attempts: 0,
    warned_24h: false,
    opt_in_confirmed: true,      // they SAID YES
    opt_in_sent_at: new Date(Date.now() - 50 * HOURS).toISOString(),
    started_at: new Date(Date.now() - 50 * HOURS).toISOString(),
    expires_at: new Date(Date.now() - 2 * HOURS).toISOString(),  // lapsed
    ...over,
  };
}

function row(s: Record<string, unknown>) {
  return { id: 'mem-1', company_id: COMPANY, content: JSON.stringify(s) };
}

/** Bennet's real employee record: consented, role + email + availability on file. */
const ONBOARDED_EMPLOYEE = {
  contact_phone: '+16165550001',
  contact_email: 'bennet@club.com',
  primary_role: 'Greeter',
  qualified_roles: ['Greeter'],
  sms_consent_state: 'confirmed',
};

beforeEach(() => {
  h.memoryRows = [];
  h.employeeRow = null;
  h.availabilityPresent = false;
  h.deletes = [];
  h.updates = [];
  h.activity = [];
  h.replies = [];
});

const timeouts = () => h.activity.filter(a => a.action === 'onboarding_timeout');
const warnings = () => h.activity.filter(a => a.action === 'onboarding_24h_warning_sent');

// ── The 24h warning sweeper ──────────────────────────────────────────────────

describe('L5 · checkStaleOnboardingSessions no longer nags people who are done', () => {
  it("THE LIVE BUG: an onboarded employee gets NO warning and NO manager alert", async () => {
    // Bennet on 8/15: consented, record complete, parked on the optional
    // time-off question. The old sweeper texted his manager
    // "Bennet hasn't completed onboarding yet."
    h.memoryRows = [row(session())];
    h.employeeRow = ONBOARDED_EMPLOYEE;
    h.availabilityPresent = true;

    await checkStaleOnboardingSessions();

    expect(warnings()).toHaveLength(0);
    expect(h.replies).toHaveLength(0);
    // The stale row is cleaned up so it can't be re-examined tomorrow.
    expect(h.deletes).toContain('mem-1');
  });

  it('someone genuinely unfinished IS still warned — the guard must not silence real ones', async () => {
    h.memoryRows = [row(session({ opt_in_confirmed: false }))];
    h.employeeRow = { ...ONBOARDED_EMPLOYEE, sms_consent_state: null };
    h.availabilityPresent = false;

    await checkStaleOnboardingSessions();

    expect(warnings()).toHaveLength(1);
    expect(h.replies[0]).toMatch(/hasn't completed onboarding/i);
    expect(h.updates.some(u => JSON.parse(u.content).warned_24h === true)).toBe(true);
  });

  it('consented but NOT schedulable (no availability) is still unfinished', async () => {
    // Consent alone was the old completion signal. It isn't one.
    h.memoryRows = [row(session())];
    h.employeeRow = ONBOARDED_EMPLOYEE;
    h.availabilityPresent = false;

    await checkStaleOnboardingSessions();
    expect(warnings()).toHaveLength(1);
  });

  it('a session started less than 24h ago is left alone', async () => {
    h.memoryRows = [row(session({ started_at: new Date(Date.now() - 2 * HOURS).toISOString() }))];
    h.employeeRow = { ...ONBOARDED_EMPLOYEE, sms_consent_state: null };

    await checkStaleOnboardingSessions();
    expect(warnings()).toHaveLength(0);
  });

  it('an already-warned session is not warned twice', async () => {
    h.memoryRows = [row(session({ warned_24h: true, opt_in_confirmed: false }))];
    h.employeeRow = { ...ONBOARDED_EMPLOYEE, sms_consent_state: null };

    await checkStaleOnboardingSessions();
    expect(warnings()).toHaveLength(0);
  });

  it('a corrupted row is skipped without taking the sweep down', async () => {
    h.memoryRows = [
      { id: 'bad', company_id: COMPANY, content: '{not json' },
      row(session({ opt_in_confirmed: false })),
    ];
    h.employeeRow = { ...ONBOARDED_EMPLOYEE, sms_consent_state: null };

    await checkStaleOnboardingSessions();
    expect(warnings()).toHaveLength(1);
  });
});

// ── The 48h reaper ───────────────────────────────────────────────────────────

describe('L5 · expireOldOnboardingSessions no longer reports completed people as timed out', () => {
  it("THE LIVE BUG: an onboarded employee's lapsed row closes SILENTLY", async () => {
    // This is the event that put "Completed Aug 16" on Bennet's Homebase row —
    // the tab was showing the TIMEOUT's timestamp in a column headed "Completed".
    h.memoryRows = [row(session())];
    h.employeeRow = ONBOARDED_EMPLOYEE;
    h.availabilityPresent = true;

    await expireOldOnboardingSessions();

    expect(timeouts()).toHaveLength(0);
    expect(h.replies).toHaveLength(0);
    expect(h.deletes).toContain('mem-1');   // still cleaned up
  });

  it('a genuinely unfinished lapsed session DOES time out and tell the manager', async () => {
    h.memoryRows = [row(session({ opt_in_confirmed: false }))];
    h.employeeRow = { ...ONBOARDED_EMPLOYEE, sms_consent_state: null };
    h.availabilityPresent = false;

    await expireOldOnboardingSessions();

    expect(timeouts()).toHaveLength(1);
    expect(timeouts()[0].metadata).toMatchObject({ reaped_by: 'proactive_expiry' });
    expect(h.replies[0]).toMatch(/expired without completion/i);
  });

  it('a session still inside its window is untouched', async () => {
    h.memoryRows = [row(session({ expires_at: new Date(Date.now() + 10 * HOURS).toISOString() }))];
    h.employeeRow = { ...ONBOARDED_EMPLOYEE, sms_consent_state: null };

    await expireOldOnboardingSessions();
    expect(timeouts()).toHaveLength(0);
    expect(h.deletes).toHaveLength(0);
  });

  it('the row is deleted BEFORE notifying, so a notify failure cannot wedge it', async () => {
    // Otherwise a transient send error leaves the row to be reaped again
    // tomorrow, and the manager gets the same alert every day.
    h.memoryRows = [row(session({ opt_in_confirmed: false }))];
    h.employeeRow = { ...ONBOARDED_EMPLOYEE, sms_consent_state: null };

    await expireOldOnboardingSessions();
    expect(h.deletes).toContain('mem-1');
  });

  it('FAILS OPEN: if the employee row cannot be read, it still times out', async () => {
    // A DB blip must not silently swallow a legitimate warning about someone
    // who really hasn't finished.
    h.memoryRows = [row(session())];
    h.employeeRow = null;

    await expireOldOnboardingSessions();
    expect(timeouts()).toHaveLength(1);
  });

  it('a DECLINED employee is not treated as onboarded, but is still reaped', async () => {
    h.memoryRows = [row(session({ opt_in_confirmed: false }))];
    h.employeeRow = { ...ONBOARDED_EMPLOYEE, sms_consent_state: 'declined' };
    h.availabilityPresent = true;

    await expireOldOnboardingSessions();
    // 'declined' is terminal — not 'onboarded' — so the row still closes loudly.
    // (N4 separately refuses to re-onboard them; see onboarding-subset tests.)
    expect(timeouts()).toHaveLength(1);
    expect(h.deletes).toContain('mem-1');
  });
});
