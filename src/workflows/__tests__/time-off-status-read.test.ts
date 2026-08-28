import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Batch-1.5 #5: time-off status read surfaces PENDING/DENIED, not just approved ──
// "where does my request stand?" for a pending request used to say "no approved
// time off." Now it reads back every current/upcoming request with its status.

const h = vi.hoisted(() => ({ rows: [] as unknown[], replyMock: vi.fn(async () => {}) }));

vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: false, ANTHROPIC_API_KEY: 'x', SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', SENDGRID_FROM_EMAIL: 'a@b.c', BASE_URL: 'http://x' } }));
vi.mock('../../db/client', () => ({
  supabase: {
    from: () => {
      const chain: Record<string, unknown> = {};
      // W-2 added: .in() (call-out side-row read) and .maybeSingle()
      // (tenantTodayAndZone — the status query is tenant-local now).
      for (const m of ['select', 'eq', 'gte', 'order', 'in']) chain[m] = () => chain;
      (chain as { maybeSingle: unknown }).maybeSingle = () => Promise.resolve({ data: { timezone: 'America/Detroit' }, error: null });
      // The query is awaited after .order(); make the chain thenable.
      (chain as { then: unknown }).then = (onF: (v: { data: unknown[] }) => unknown) => Promise.resolve({ data: h.rows }).then(onF);
      return chain;
    },
  },
}));
vi.mock('../../messaging/reply', () => ({ reply: h.replyMock, sendInThreadAck: vi.fn(), normalizeReSubject: (s: string) => s }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../ai/claude', () => ({ withAnthropicRetry: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));

import { handleQueryMyTimeOff } from '../time-off';
import type { InboundMessage, VerifiedContact } from '../../security/types';

const contact: VerifiedContact = { role: 'employee', company_id: 'c1', employee_id: 'e1', user_id: null, name: 'Luka', matched_identifier: '+16167170847', channel: 'sms' };
const message: InboundMessage = { sender: '+16167170847', recipient: '+16166164898', body: 'where does my time off request stand?', channel: 'sms' };

beforeEach(() => { h.replyMock.mockClear(); h.rows = []; });

describe('handleQueryMyTimeOff status read (#5)', () => {
  it('reports a PENDING request as pending/awaiting', async () => {
    h.rows = [{ start_date: '2026-08-26', end_date: '2026-08-26', time_off_type: 'full_day', partial_days: null, status: 'pending' }];
    await handleQueryMyTimeOff(message, contact, {});
    const text = String(h.replyMock.mock.calls[0][2]);
    expect(text).toMatch(/Pending|awaiting/i);
    expect(text).not.toMatch(/don't have any/i);
  });

  it('labels a DENIED request as not approved', async () => {
    h.rows = [{ start_date: '2026-08-26', end_date: '2026-08-26', time_off_type: 'full_day', partial_days: null, status: 'denied' }];
    await handleQueryMyTimeOff(message, contact, {});
    expect(String(h.replyMock.mock.calls[0][2])).toMatch(/Not approved/i);
  });

  it('still lists approved time off', async () => {
    h.rows = [{ start_date: '2026-08-27', end_date: '2026-08-27', time_off_type: 'full_day', partial_days: null, status: 'approved' }];
    await handleQueryMyTimeOff(message, contact, {});
    expect(String(h.replyMock.mock.calls[0][2])).toMatch(/Approved/i);
  });

  it('empty state no longer claims "no approved time off"', async () => {
    h.rows = [];
    await handleQueryMyTimeOff(message, contact, {});
    const text = String(h.replyMock.mock.calls[0][2]);
    expect(text).toMatch(/don't have any time off on file/i);
    expect(text).not.toMatch(/approved/i);
  });
});
