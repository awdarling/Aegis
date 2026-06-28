import { describe, it, expect, beforeEach, vi } from 'vitest';

// #10 Stage 2 — buildSwapBroadcastEmail. Supabase + messaging are mocked; we assert
// the LOGIC the deployed feature runs: the pickup token is always minted, the swap
// token only when the candidate is swap-eligible, the right buttons render, and the
// employee-facing email never leaks a Homebase CTA.

const h = vi.hoisted(() => {
  const tokenInserts: { action_type: string; payload: Record<string, unknown> }[] = [];
  return { tokenInserts };
});

vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local', SUPABASE_SERVICE_ROLE_KEY: 'test', BASE_URL: 'https://test.local',
    ANTHROPIC_API_KEY: 'test', SENDGRID_API_KEY: 'test', SENDGRID_FROM_EMAIL: 'a@test.local',
    TWILIO_ACCOUNT_SID: 'test', TWILIO_AUTH_TOKEN: 'test',
  },
}));
vi.mock('../../db/client', () => ({
  supabase: {
    from: (table: string) => ({
      insert: (rows: Record<string, unknown>) => {
        if (table === 'aegis_action_tokens') {
          h.tokenInserts.push({ action_type: rows.action_type as string, payload: rows.payload as Record<string, unknown> });
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

import { buildSwapBroadcastEmail } from '../shift-swap';

process.env.HOMEBASE_URL = 'https://homebase.test';

const base = {
  company_id: '00000000-0000-0000-0000-000000000001',
  candidate: { id: 'c1', name: 'Dana Reed', email: 'dana@club.com' },
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
  token_payload: { broadcast_id: 'b1', requester_id: 'r1' },
};

beforeEach(() => { h.tokenInserts.length = 0; });

describe('buildSwapBroadcastEmail — swap-eligible candidate', () => {
  it('mints BOTH tokens and renders BOTH buttons', async () => {
    const { subject, text, html } = await buildSwapBroadcastEmail({ ...base, swapEligible: true });

    const types = h.tokenInserts.map(t => t.action_type).sort();
    expect(types).toEqual(['swap_pickup', 'swap_trade_select']);
    // Each token carries the shared snapshot + the candidate as receiver.
    for (const t of h.tokenInserts) {
      expect(t.payload.receiver_id).toBe('c1');
      expect(t.payload.broadcast_id).toBe('b1');
    }
    expect(h.tokenInserts.find(t => t.action_type === 'swap_pickup')!.payload.mode).toBe('pickup');
    const swapTok = h.tokenInserts.find(t => t.action_type === 'swap_trade_select')!;
    expect(swapTok.payload.mode).toBe('swap');
    // The swap token is self-contained: it carries the candidate's tradeable
    // shifts (the picker-page options) + the requester's shift in human + raw form.
    expect(swapTok.payload.tradeable_shifts).toEqual(base.tradeableShifts);
    expect(swapTok.payload.shift_name).toBe('Saturday AM');
    expect(swapTok.payload.shift_date).toBe('2026-07-11');
    expect(swapTok.payload.requester_name).toBe('John Jones');

    expect(html).toContain(">I'll pick it up</a>");
    expect(html).toContain(">I'd like to swap</a>");
    expect(subject).toContain('Saturday AM');
    expect(text).toMatch(/John Jones/);
    // Employee-facing: never a Homebase CTA.
    expect(html).not.toMatch(/view in homebase/i);
  });
});

describe('buildSwapBroadcastEmail — pickup-only candidate', () => {
  it('mints ONLY the pickup token and renders ONLY the pickup button', async () => {
    const { html } = await buildSwapBroadcastEmail({ ...base, swapEligible: false });

    expect(h.tokenInserts.map(t => t.action_type)).toEqual(['swap_pickup']);
    expect(html).toContain(">I'll pick it up</a>");
    expect(html).not.toContain(">I'd like to swap</a>");
  });

  it('mentions the days the requester can work in return', async () => {
    const { text } = await buildSwapBroadcastEmail({ ...base, swapEligible: true });
    // 2026-07-06 = Monday, Jul 6; 2026-07-07 = Tuesday, Jul 7.
    expect(text).toMatch(/Jul 6/);
    expect(text).toMatch(/Jul 7/);
  });
});
