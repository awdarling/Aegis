import { describe, it, expect, vi } from 'vitest';

// operational-query.ts pulls in the Anthropic client, env, and the DB client at
// module load. Mock those so importing the pure prompt builder is side-effect-free.
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({
  env: { ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k', SENDGRID_FROM_EMAIL: 'a@b.test', SENDGRID_FROM_NAME: 'Aegis', BASE_URL: 'http://localhost:3000', NODE_ENV: 'test' },
}));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn() }));
vi.mock('../../ai/claude', () => ({ generateReply: vi.fn(), withAnthropicRetry: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ computeWageEstimate: vi.fn() }));
vi.mock('../payroll', () => ({ handleWageRateSync: vi.fn() }));

import { buildOperationalAnswerSystem } from '../operational-query';

const PERSONALITY = 'You are Aegis, an AI assistant manager for Sandbox Club.';
const TODAY = '2026-07-30';

// This is the one prompt EVERY free-form operational/general answer is built from.
// If it stops carrying the grounding or the scope guard, the "log into Homebase"
// hallucination and the free-Claude abuse both come straight back.
describe('buildOperationalAnswerSystem — employee', () => {
  const sys = buildOperationalAnswerSystem('employee', PERSONALITY, TODAY, 'Sam Rivera');

  it('carries the personality, date, and the employee name', () => {
    expect(sys).toContain(PERSONALITY);
    expect(sys).toContain(TODAY);
    expect(sys).toContain('Sam Rivera');
  });

  it('injects the grounding that closes the Homebase hallucination', () => {
    expect(sys).toMatch(/NEVER/);
    expect(sys).toMatch(/log into Homebase/i);
    expect(sys).toMatch(/text or email/i);
  });

  it('injects the scope guard so off-domain asks are declined, not answered', () => {
    expect(sys).toMatch(/do NOT answer/i);
    expect(sys).toMatch(/scheduling assistant/i);
  });

  it('keeps the no-leak guard and own-data-only scoping', () => {
    expect(sys).toMatch(/never mention how you got the information/i);
    expect(sys).toMatch(/their own schedule|their own shifts/i);
  });
});

describe('buildOperationalAnswerSystem — manager', () => {
  const sys = buildOperationalAnswerSystem('manager', PERSONALITY, TODAY, 'Dana Cruz');

  it('grounds + guards the manager path too', () => {
    expect(sys).toMatch(/Homebase/);
    expect(sys).toMatch(/do NOT answer/i);
    expect(sys).toMatch(/never mention how you got the information/i);
  });

  it('allows manager staffing answers', () => {
    expect(sys).toMatch(/staffing|headcount|coverage/i);
  });
});
