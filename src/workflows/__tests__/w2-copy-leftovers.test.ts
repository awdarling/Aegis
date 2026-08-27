import { describe, it, expect, vi } from 'vitest';

// ── W-2 branch 4: the last keyword prompts go natural (N9, approved by
// Alexander 2026-08-27) and the F7 replay can never replace the employee's own
// words with a stored date (§N10 — Jenna's "Aug 24–30" became "through July
// 16" six times before W-1 blocked the common path; this closes the latent one).

vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: true, ANTHROPIC_API_KEY: 'x', SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', SENDGRID_FROM_EMAIL: 'a@b.c', BASE_URL: 'http://x', NODE_ENV: 'test' } }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../db/client', () => ({
  supabase: {
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'neq', 'like', 'ilike', 'in', 'is', 'lte', 'gte', 'lt', 'gt', 'order', 'limit', 'or', 'insert', 'update', 'delete']) b[m] = () => b;
      (b as { maybeSingle: unknown }).maybeSingle = () => Promise.resolve({ data: null, error: null });
      (b as { single: unknown }).single = () => Promise.resolve({ data: null, error: null });
      (b as { then: unknown }).then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(onF, onR);
      return b;
    },
  },
}));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn(), normalizeReSubject: (s: string) => s }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));

import { resolveAvailTargetReplay } from '../employee-onboarding';

describe('§N10 — the F7 replay honours the employee\'s own words', () => {
  it('"going forward" in the original message wins even over a "temporary" answer', () => {
    // Jenna: "for the rest of the season I can only work Sundays" — asked the
    // (pre-W-1) question anyway and answered "temporary": her own words say
    // NORMAL, and the stored July 16 must never ride back in.
    const out = resolveAvailTargetReplay('temporary', 'for the rest of the season I can only work Sundays', '2026-07-16');
    expect(out).toEqual({ avail_target: 'normal' });
  });

  it('a dateless original + "temporary" keeps the stored end date (the honest fallback)', () => {
    const out = resolveAvailTargetReplay('temporary', 'I can only work Friday mornings', '2026-09-01');
    expect(out).toEqual({ avail_target: 'temporary', end_date: '2026-09-01' });
  });

  it('a "normal" answer is normal, full stop', () => {
    expect(resolveAvailTargetReplay('normal', 'I can only work Friday mornings', '2026-07-16')).toEqual({ avail_target: 'normal' });
  });
});

describe('N9 — no keyword prompts outside the A2P opt-in', () => {
  it('the manager-facing and confirm-gate copy carries no "Reply YES/NO" instruction', async () => {
    const fs = await import('node:fs');
    const files = [
      'src/workflows/employee-onboarding.ts',
      'src/workflows/broadcast.ts',
      'src/workflows/time-off.ts',
      'src/workflows/shift-swap.ts',
    ];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      // Strip comments, then look for the prompt in live template strings.
      const code = src.replace(/^\s*\/\/.*$/gm, '');
      const hits = [...code.matchAll(/Reply YES[^`]*`/g)].map(m => m[0]);
      // The ONE allowed keyword prompt is the A2P/TCPA opt-in pair in
      // employee-onboarding ("Reply YES to confirm", "reply YES to receive").
      const allowed = hits.filter(h => /confirm|receive scheduling notifications/i.test(h));
      expect(hits.length).toBe(allowed.length);
    }
  });
});
