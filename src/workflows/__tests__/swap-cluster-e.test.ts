import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Batch-1.5 Cluster E: swap polish (#8 directed hint, #10 trade SMS-first) ─────

const h = vi.hoisted(() => ({
  broadcast: null as Record<string, unknown> | null,
  requesterRow: null as Record<string, unknown> | null,
  receiverRow: null as Record<string, unknown> | null,
  emailOnly: false,
  replyMock: vi.fn(async () => {}),
  sendEmailMock: vi.fn(async () => true),
  sendSmsMock: vi.fn(async () => true),
}));

vi.mock('../../config/env', () => ({ env: { get EMAIL_ONLY() { return h.emailOnly; }, SUPABASE_URL: 'https://t.local', SUPABASE_SERVICE_ROLE_KEY: 't', BASE_URL: 'https://t.local', ANTHROPIC_API_KEY: 't', SENDGRID_API_KEY: 't', SENDGRID_FROM_EMAIL: 'a@t.local' } }));
vi.mock('../../db/client', () => ({
  supabase: {
    from: (table: string) => {
      const b: Record<string, unknown> = { _cols: '' };
      b.select = (c: string) => { b._cols = c; return b; };
      b.eq = () => b; b.is = () => b; b.order = () => b; b.limit = () => b; b.update = () => b; b.delete = () => b;
      b.insert = () => Promise.resolve({ error: null });
      b.maybeSingle = async () => ({ data: table === 'aegis_memory' && h.broadcast ? { id: 'mem1', content: JSON.stringify(h.broadcast) } : null, error: null });
      b.single = async () => {
        if (table === 'employees') {
          const cols = String(b._cols);
          return { data: cols.includes('contact_phone') ? h.requesterRow : h.receiverRow, error: null };
        }
        return { data: null, error: null };
      };
      return b;
    },
  },
}));
vi.mock('../../messaging/email', () => ({ sendEmail: h.sendEmailMock }));
vi.mock('../../messaging/sms', () => ({ sendSms: h.sendSmsMock }));
vi.mock('../../messaging/reply', () => ({ reply: h.replyMock, sendInThreadAck: vi.fn(), normalizeReSubject: (s: string) => s }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ computeWageEstimate: vi.fn() }));

import { buildFacilitatedSwapConfirm, proposeSwapTrade } from '../shift-swap';

process.env.HOMEBASE_URL = 'https://homebase.test';

describe('buildFacilitatedSwapConfirm (#8)', () => {
  it('surfaces the option to name a specific coworker for a directed swap', () => {
    const out = buildFacilitatedSwapConfirm({ shiftLabel: 'AM shift', dateLabel: 'Sat Jun 13', candidateNote: '', tradeNote: '' });
    expect(out).toMatch(/tell me their name/i);
    expect(out).toMatch(/directly/i);
    expect(out).toMatch(/ask the team\?$/);
  });
});

function seedBroadcast(channel: 'sms' | 'email') {
  h.broadcast = {
    company_id: 'c1', requester_id: 'req1', requester_name: 'Luka',
    shift_date: '2026-06-13', shift_name: 'AM', role: 'Lifeguard', shift_start: '09:00', shift_end: '13:00',
    schedule_id: 'sch1', status: 'open',
    requester_channel: channel, requester_sender: channel === 'sms' ? '+16167170847' : 'luka@x.com',
    requester_recipient: channel === 'sms' ? '+16166164898' : 'aegis@x.com',
    requester_raw_subject: null, requester_thread_id: null,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  };
  h.receiverRow = { id: 'rcv1', name: 'Riley' };
  h.requesterRow = { id: 'req1', name: 'Luka', contact_email: 'luka@x.com', contact_phone: '+16167170847' };
}

describe('proposeSwapTrade requester notice (#10)', () => {
  beforeEach(() => { h.replyMock.mockClear(); h.sendEmailMock.mockClear(); h.emailOnly = false; });

  it('sends an SMS-first heads-up AND the email-with-buttons for an SMS requester', async () => {
    seedBroadcast('sms');
    const r = await proposeSwapTrade({ company_id: 'c1', requester_id: 'req1', receiver_id: 'rcv1',
      selected_shift: { date: '2026-06-14', shift_name: 'PM', role: 'Lifeguard', start_time: '13:00', end_time: '21:00' } });
    expect(r.ok).toBe(true);
    expect(h.replyMock).toHaveBeenCalledTimes(1);       // SMS-first heads-up (was email-only)
    expect(h.sendEmailMock).toHaveBeenCalledTimes(1);   // Agree/Decline buttons still in the email
  });

  it('does not send the SMS heads-up when the requester submitted by email', async () => {
    seedBroadcast('email');
    await proposeSwapTrade({ company_id: 'c1', requester_id: 'req1', receiver_id: 'rcv1',
      selected_shift: { date: '2026-06-14', shift_name: 'PM', role: 'Lifeguard', start_time: '13:00', end_time: '21:00' } });
    expect(h.replyMock).not.toHaveBeenCalled();
    expect(h.sendEmailMock).toHaveBeenCalledTimes(1);
  });
});
