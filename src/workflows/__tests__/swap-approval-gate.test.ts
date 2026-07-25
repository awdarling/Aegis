import { describe, it, expect, vi } from 'vitest';

// ── Manager-approval gate regression suite ────────────────────────────────────
//
// THE GAP (audit, 2026-07-25): a one-way DIRECTED giveaway ("Emily is taking my
// Saturday shift") auto-executed on the coworker's YES with NO manager sign-off,
// because approval was only forced when a two-way trade named a return shift
// (`outreach.target_shift_name`) or a company swap policy explicitly required it.
// Watermark has NO `swaps` policy, so the giveaway path bypassed the manager
// entirely — contradicting the confirmation Aegis sends the requester
// ("...then pass it to your manager to approve").
//
// THE CONTRACT: every DIRECTED swap (giveaway OR trade) is manager-gated,
// regardless of policy. Only the legacy facilitated one-at-a-time pickup may
// auto-execute, and only when a policy waives approval.

vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local',
    SUPABASE_SERVICE_ROLE_KEY: 'test',
    BASE_URL: 'https://test.local',
    ANTHROPIC_API_KEY: 'test',
    SENDGRID_API_KEY: 'test',
    SENDGRID_FROM_EMAIL: 'a@test.local',
    TWILIO_ACCOUNT_SID: 'test',
    TWILIO_AUTH_TOKEN: 'test',
    EMAIL_ONLY: true,
  },
}));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../ai/claude', () => ({
  generateReply: vi.fn(),
  classifyIntent: vi.fn(),
  AnthropicOverloadError: class AnthropicOverloadError extends Error {},
}));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ computeWageEstimate: vi.fn() }));

import { swapRequiresManagerApproval } from '../shift-swap';

describe('swapRequiresManagerApproval', () => {
  it('directed GIVEAWAY (no return shift, no policy) → requires approval (the bug)', () => {
    expect(swapRequiresManagerApproval({
      mode: 'directed', targetShiftName: null, policyRequiresApproval: false,
    })).toBe(true);
  });

  it('directed GIVEAWAY (undefined target) → requires approval', () => {
    expect(swapRequiresManagerApproval({
      mode: 'directed', policyRequiresApproval: false,
    })).toBe(true);
  });

  it('directed TRADE (return shift named) → requires approval', () => {
    expect(swapRequiresManagerApproval({
      mode: 'directed', targetShiftName: 'Friday PM', policyRequiresApproval: false,
    })).toBe(true);
  });

  it('directed swap ignores policy=false and still requires approval', () => {
    expect(swapRequiresManagerApproval({
      mode: 'directed', targetShiftName: null, policyRequiresApproval: false,
    })).toBe(true);
  });

  it('facilitated one-way pickup, NO policy → auto-executes (no approval)', () => {
    expect(swapRequiresManagerApproval({
      mode: 'facilitated', targetShiftName: null, policyRequiresApproval: false,
    })).toBe(false);
  });

  it('facilitated one-way pickup, policy requires approval → requires approval', () => {
    expect(swapRequiresManagerApproval({
      mode: 'facilitated', targetShiftName: null, policyRequiresApproval: true,
    })).toBe(true);
  });

  it('facilitated with a return shift (two-way) → requires approval regardless of policy', () => {
    expect(swapRequiresManagerApproval({
      mode: 'facilitated', targetShiftName: 'Friday PM', policyRequiresApproval: false,
    })).toBe(true);
  });
});
