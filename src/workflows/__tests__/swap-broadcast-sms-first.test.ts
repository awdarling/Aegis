import { describe, it, expect, beforeEach, vi } from 'vitest';

// H19 — the multi-candidate swap BROADCAST is now SMS-FIRST (SMS spec §3.4: swaps
// are text-native employee↔employee). This suite proves the two seams the feature
// rests on:
//   1) buildSwapBroadcastEmail emits an `sms` body that carries the SAME per-
//      candidate magic-links the email buttons use (pickup always; swap when
//      eligible) — and works for an SMS-ONLY candidate (no email on file), who the
//      old email-only fan-out silently skipped.
//   2) deliverSwapBroadcast routes SMS-first for a phone-holder, with email as the
//      fallback on no-phone / SMS failure, and email-first when SMS isn't available
//      (EMAIL_ONLY set, or no tenant SMS number).
// Supabase + messaging are mocked; we assert the LOGIC the deployed path runs.

const h = vi.hoisted(() => {
  const tokenInserts: { action_type: string; issued_to_email: string; payload: Record<string, unknown> }[] = [];
  return { tokenInserts };
});

vi.mock('../../config/env', () => ({
  env: {
    EMAIL_ONLY: false,
    SUPABASE_URL: 'https://test.local', SUPABASE_SERVICE_ROLE_KEY: 'test', BASE_URL: 'https://test.local',
    ANTHROPIC_API_KEY: 'test', SENDGRID_API_KEY: 'test', SENDGRID_FROM_EMAIL: 'a@test.local',
  },
}));
vi.mock('../../db/client', () => ({
  supabase: {
    from: (table: string) => ({
      insert: (rows: Record<string, unknown>) => {
        if (table === 'aegis_action_tokens') {
          h.tokenInserts.push({
            action_type: rows.action_type as string,
            issued_to_email: rows.issued_to_email as string,
            payload: rows.payload as Record<string, unknown>,
          });
        }
        return Promise.resolve({ error: null });
      },
    }),
  },
}));
vi.mock('../../ai/claude', () => ({
  generateReply: vi.fn(), classifyIntent: vi.fn(),
  AnthropicOverloadError: class AnthropicOverloadError extends Error {},
}));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ computeWageEstimate: vi.fn() }));

import { buildSwapBroadcastEmail, deliverSwapBroadcast, isReachableForOutreach } from '../shift-swap';
import { sendSms } from '../../messaging/sms';
import { sendEmail } from '../../messaging/email';

process.env.HOMEBASE_URL = 'https://homebase.test';

const base = {
  company_id: '00000000-0000-0000-0000-000000000001',
  requester_name: 'John Jones',
  shift_name: 'Saturday AM',
  shift_role: 'Lifeguard',
  shift_date: '2026-07-11',
  shift_start: '09:00',
  shift_end: '13:00',
  willing_dates: ['2026-07-06', '2026-07-07'],
  tradeableShifts: [
    { date: '2026-07-06', shift_name: 'Monday AM', role: 'Lifeguard', start_time: '09:00', end_time: '13:00' },
  ],
  token_payload: { requester_id: 'r1' },
};

beforeEach(() => {
  h.tokenInserts.length = 0;
  vi.mocked(sendSms).mockReset();
  vi.mocked(sendEmail).mockReset();
});

// ── 1) The SMS body carries the same magic-links as the email buttons ──────────
describe('buildSwapBroadcastEmail — sms body', () => {
  it('swap-eligible: sms carries BOTH the pickup and swap links (and matches the returned urls)', async () => {
    const r = await buildSwapBroadcastEmail({
      ...base, candidate: { id: 'c1', name: 'Dana Reed', email: 'dana@club.com' }, swapEligible: true,
    });
    expect(r.pickupUrl).toContain('https://homebase.test/api/aegis-action?token=');
    expect(r.swapUrl).toContain('https://homebase.test/api/aegis-action?token=');
    // The exact links the tokens minted must appear inline in the SMS.
    expect(r.sms).toContain(r.pickupUrl);
    expect(r.sms).toContain(r.swapUrl!);
    expect(r.sms).toMatch(/Pick it up:/);
    expect(r.sms).toMatch(/offer a swap instead/i);
    // First-commit framing + manager gate, in the SMS itself.
    expect(r.sms).toMatch(/First to tap/i);
    expect(r.sms).toMatch(/John Jones/);
    // The email "tap the button in this email" copy must NOT leak into the SMS
    // (an SMS has no buttons — this was the whole reason the old text was unusable).
    expect(r.sms).not.toMatch(/button in this email/i);
  });

  it('pickup-only: sms carries ONLY the pickup link, no swap line, and swapUrl is null', async () => {
    const r = await buildSwapBroadcastEmail({
      ...base, candidate: { id: 'c1', name: 'Dana Reed', email: 'dana@club.com' }, swapEligible: false,
    });
    expect(r.swapUrl).toBeNull();
    expect(r.sms).toContain(r.pickupUrl);
    expect(r.sms).not.toMatch(/offer a swap instead/i);
  });

  it('SMS-only candidate (no email on file): still mints both tokens, still builds inline links', async () => {
    const r = await buildSwapBroadcastEmail({
      ...base, candidate: { id: 'c1', name: 'Dana Reed', email: null }, swapEligible: true,
    });
    // Old behavior skipped these candidates before minting — now they get the blast.
    expect(h.tokenInserts.map(t => t.action_type).sort()).toEqual(['swap_pickup', 'swap_trade_select']);
    // issued_to_email is a required column; with no email we anchor on employee_id
    // and record an empty audit email rather than crashing.
    for (const t of h.tokenInserts) expect(t.issued_to_email).toBe('');
    expect(r.sms).toContain(r.pickupUrl);
    expect(r.sms).toContain(r.swapUrl!);
  });
});

// ── 2) deliverSwapBroadcast — the SMS-first routing matrix ─────────────────────
const deliverBase = {
  aegisSmsNumber: '+15550001111',
  sms: 'sms body', subject: 'subj', text: 'text', html: '<p>html</p>',
  company_id: base.company_id,
};

describe('deliverSwapBroadcast — routing', () => {
  it('SMS-capable + phone: sends SMS, returns "sms", never emails', async () => {
    vi.mocked(sendSms).mockResolvedValue(true as never);
    const ch = await deliverSwapBroadcast({ ...deliverBase, smsCapable: true, candidatePhone: '+15557654321', candidateEmail: 'dana@club.com' });
    expect(ch).toBe('sms');
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendSms).mock.calls[0][0]).toMatchObject({ to: '+15557654321', from: '+15550001111', body: 'sms body' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('SMS fails → falls back to email, returns "email"', async () => {
    vi.mocked(sendSms).mockResolvedValue(false as never);
    vi.mocked(sendEmail).mockResolvedValue(true as never);
    const ch = await deliverSwapBroadcast({ ...deliverBase, smsCapable: true, candidatePhone: '+15557654321', candidateEmail: 'dana@club.com' });
    expect(ch).toBe('email');
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('SMS fails and no email on file → "none" (never over-counts)', async () => {
    vi.mocked(sendSms).mockResolvedValue(false as never);
    const ch = await deliverSwapBroadcast({ ...deliverBase, smsCapable: true, candidatePhone: '+15557654321', candidateEmail: null });
    expect(ch).toBe('none');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('EMAIL_ONLY / not SMS-capable: email-first, no SMS attempt', async () => {
    vi.mocked(sendEmail).mockResolvedValue(true as never);
    const ch = await deliverSwapBroadcast({ ...deliverBase, smsCapable: false, candidatePhone: '+15557654321', candidateEmail: 'dana@club.com' });
    expect(ch).toBe('email');
    expect(sendSms).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('SMS-capable but candidate has no phone: email, no SMS attempt', async () => {
    vi.mocked(sendEmail).mockResolvedValue(true as never);
    const ch = await deliverSwapBroadcast({ ...deliverBase, smsCapable: true, candidatePhone: null, candidateEmail: 'dana@club.com' });
    expect(ch).toBe('email');
    expect(sendSms).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('SMS-only candidate (phone, no email): SMS success returns "sms"', async () => {
    vi.mocked(sendSms).mockResolvedValue(true as never);
    const ch = await deliverSwapBroadcast({ ...deliverBase, smsCapable: true, candidatePhone: '+15557654321', candidateEmail: null });
    expect(ch).toBe('sms');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('no phone and no email: "none", nothing sent', async () => {
    const ch = await deliverSwapBroadcast({ ...deliverBase, smsCapable: true, candidatePhone: null, candidateEmail: null });
    expect(ch).toBe('none');
    expect(sendSms).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('no tenant SMS number (aegisSmsNumber null) → email-first even when smsCapable flag is true', async () => {
    vi.mocked(sendEmail).mockResolvedValue(true as never);
    const ch = await deliverSwapBroadcast({ ...deliverBase, aegisSmsNumber: null, smsCapable: true, candidatePhone: '+15557654321', candidateEmail: 'dana@club.com' });
    expect(ch).toBe('email');
    expect(sendSms).not.toHaveBeenCalled();
  });
});

// ── 3) isReachableForOutreach — SMS-only candidates are in the pool ────────────
describe('isReachableForOutreach', () => {
  it('phone-only is reachable when the tenant has an SMS channel', () => {
    expect(isReachableForOutreach({ contact_email: null, contact_phone: '+15557654321' }, true)).toBe(true);
  });
  it('phone-only is NOT reachable without an SMS channel', () => {
    expect(isReachableForOutreach({ contact_email: null, contact_phone: '+15557654321' }, false)).toBe(false);
  });
  it('email-only is reachable regardless of SMS channel', () => {
    expect(isReachableForOutreach({ contact_email: 'dana@club.com', contact_phone: null }, false)).toBe(true);
  });
});
