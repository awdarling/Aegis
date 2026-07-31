import { describe, it, expect, vi } from 'vitest';

// employee-onboarding.ts pulls in Anthropic/env/DB/messaging at import. Mock them
// so we can reach the pure read-back builder without side effects.
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({
  env: { ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k', SENDGRID_FROM_EMAIL: 'a@b.test', SENDGRID_FROM_NAME: 'Aegis', BASE_URL: 'http://localhost:3000', NODE_ENV: 'test', EMAIL_ONLY: false },
}));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn(), getTenantSmsNumber: vi.fn() }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn() }));
vi.mock('../../ai/claude', () => ({ withAnthropicRetry: (fn: () => unknown) => fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));

import { buildAvailChangeConfirmBody } from '../employee-onboarding';

const SLOTS = [
  { day_of_week: 1, start_time: '09:00', end_time: '15:00' },
  { day_of_week: 3, start_time: '09:00', end_time: '15:00' },
];

// Alexander's live-test complaints: (1) it still used the robotic "Reply YES … or
// NO"; (2) a correction ("No, the latest I can work is 3pm") should be applied,
// not scrap everything. The read-back copy must invite BOTH a yes and a change.
describe('buildAvailChangeConfirmBody — human, correction-friendly read-back', () => {
  it('does NOT use the robotic reply-YES/NO gate', () => {
    const body = buildAvailChangeConfirmBody(SLOTS);
    expect(body).not.toMatch(/reply\s+"?yes"?/i);
    expect(body).not.toMatch(/reply\s+"?no"?/i);
    expect(body).not.toMatch(/\bor NO\b/);
  });

  it('invites either a confirmation or a partial correction', () => {
    const body = buildAvailChangeConfirmBody(SLOTS);
    expect(body).toMatch(/does that look right/i);
    expect(body).toMatch(/tell me what to change/i);
    expect(body).toMatch(/pass it to your manager/i);
  });

  it('shows the proposed availability and handles the temporary (until-date) variant', () => {
    const body = buildAvailChangeConfirmBody(SLOTS, { customEndDate: '2026-09-01' });
    expect(body).toMatch(/back to your normal hours/i);
    expect(body).toMatch(/tell me what to change/i);
    expect(body).not.toMatch(/\bor NO\b/);
  });

  it('explains the assumed-full-week inference without a yes/no gate', () => {
    const body = buildAvailChangeConfirmBody(SLOTS, { assumedFullWeek: true });
    expect(body).toMatch(/don't have any availability on file/i);
    expect(body).toMatch(/does that look right/i);
    expect(body).not.toMatch(/reply\s+"?yes"?/i);
  });
});
