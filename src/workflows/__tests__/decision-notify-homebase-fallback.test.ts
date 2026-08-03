import { describe, it, expect, vi, beforeEach } from 'vitest';

// sendDecisionNotification (time-off.ts) is the employee decision-notify used by
// the Homebase-button path (POST /internal/notify-to-decision). Before the H3
// fix it THREW on an SMS send failure with no email fallback — the same gap H2
// closed on the email-button path (decision.ts). EMAIL_ONLY:false so the SMS
// route is exercised. We mock every module time-off.ts pulls at load, and drive
// a chainable supabase stub that returns one row per table.

const rows: Record<string, unknown> = {
  time_off_requests: {
    id: 'r1', company_id: 'c1', employee_id: 'e1',
    start_date: '2026-08-05', end_date: '2026-08-05',
  },
  employees: {
    id: 'e1', name: 'Sam Rivera',
    contact_email: 'sam@example.com', contact_phone: '+16165551234',
  },
  // to_thread side row records the origin channel — 'sms' forces the SMS route.
  aegis_memory: { content: JSON.stringify({ channel: 'sms', thread_id: null, raw_subject: null }) },
  company_channels: { channel_value: '+16160000000' },
};

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = () => b;
  b.single = async () => ({ data: rows[table] ?? null, error: rows[table] ? null : { message: 'no row' } });
  b.maybeSingle = async () => ({ data: rows[table] ?? null, error: null });
  return b;
}

vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: false, BASE_URL: 'https://x.test' } }));
vi.mock('../../db/client', () => ({ supabase: { from: (t: string) => makeBuilder(t) } }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), normalizeReSubject: (s: string) => s }));
vi.mock('../../messaging/greeting', () => ({
  greeting: () => 'Hi', firstName: (n: string) => n, textOpener: () => 'Hi Sam — ', managerAlertSms: () => 'alert',
}));
vi.mock('../../ai/claude', () => ({ classifyIntent: vi.fn(), generateReply: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({
  runSimulation: vi.fn(), getWeekBounds: vi.fn(), loadTimeOffPolicies: vi.fn(),
}));
vi.mock('../../lib/time-off-policies', () => ({ computeTimeOffViolations: vi.fn() }));
vi.mock('../../messaging/brand', () => ({ BRAND: {}, logoUrl: () => '', brandedEmailShell: (x: unknown) => x }));
vi.mock('../time-off-manager-email', () => ({
  buildTimeOffManagerEmail: vi.fn(), buildTimeOffResolutionEmail: vi.fn(),
}));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));

import { sendDecisionNotification } from '../time-off';
import { sendSms } from '../../messaging/sms';
import { sendEmail } from '../../messaging/email';

const mockSms = vi.mocked(sendSms);
const mockEmail = vi.mocked(sendEmail);

describe('sendDecisionNotification — Homebase-path email fallback (DRIFT_REGISTER H3)', () => {
  beforeEach(() => {
    mockSms.mockReset();
    mockEmail.mockReset();
    mockEmail.mockResolvedValue(true);
    rows.employees = { id: 'e1', name: 'Sam Rivera', contact_email: 'sam@example.com', contact_phone: '+16165551234' };
  });

  it('falls back to email when the SMS send fails (the H3 gap)', async () => {
    mockSms.mockResolvedValue(false);
    const result = await sendDecisionNotification('r1', 'approved');
    expect(mockSms).toHaveBeenCalledTimes(1);
    expect(mockEmail).toHaveBeenCalledTimes(1);
    expect(result.channel).toBe('email');
    expect(result.sent_to).toBe('sam@example.com');
  });

  it('does NOT email when the SMS send succeeds', async () => {
    mockSms.mockResolvedValue(true);
    const result = await sendDecisionNotification('r1', 'approved');
    expect(mockSms).toHaveBeenCalledTimes(1);
    expect(mockEmail).not.toHaveBeenCalled();
    expect(result.channel).toBe('sms');
    expect(result.sent_to).toBe('+16165551234');
  });

  it('throws only when SMS fails AND there is no email to fall back to', async () => {
    mockSms.mockResolvedValue(false);
    rows.employees = { id: 'e1', name: 'Sam Rivera', contact_email: null, contact_phone: '+16165551234' };
    await expect(sendDecisionNotification('r1', 'approved')).rejects.toThrow(/no email address on file/);
    expect(mockEmail).not.toHaveBeenCalled();
  });
});
