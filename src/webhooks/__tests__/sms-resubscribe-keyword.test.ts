import { describe, it, expect, vi } from 'vitest';

// ── Batch-1.5 #19: START/UNSTOP are carrier resubscribe keywords the app must NOT
// re-answer (they'd stack the capabilities menu on top of the carrier's resubscribe
// confirmation). YES must still route (it's the onboarding opt-in answer).

vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: false, SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', ANTHROPIC_API_KEY: 'x', SENDGRID_FROM_EMAIL: 'a@b.c', BASE_URL: 'http://x' } }));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));

import { isResubscribeKeyword, isStopKeyword, isHelpKeyword } from '../sms';

describe('isResubscribeKeyword (#19)', () => {
  it('recognizes START and UNSTOP (case/whitespace-insensitive)', () => {
    expect(isResubscribeKeyword('START')).toBe(true);
    expect(isResubscribeKeyword(' start ')).toBe(true);
    expect(isResubscribeKeyword('unstop')).toBe(true);
  });

  it('does NOT treat YES as a resubscribe keyword (opt-in must still route)', () => {
    expect(isResubscribeKeyword('YES')).toBe(false);
    expect(isResubscribeKeyword('yes')).toBe(false);
  });

  it('is disjoint from STOP and HELP keyword sets', () => {
    expect(isResubscribeKeyword('STOP')).toBe(false);
    expect(isResubscribeKeyword('HELP')).toBe(false);
    expect(isStopKeyword('START')).toBe(false);
    expect(isHelpKeyword('START')).toBe(false);
  });
});
