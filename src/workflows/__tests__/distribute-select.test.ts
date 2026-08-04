import { describe, it, expect, vi } from 'vitest';

// schedule-build pulls in the Supabase client, messaging, and the Anthropic
// client at import. Mock those so we can reach the pure selection helper.
vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local', SUPABASE_SERVICE_ROLE_KEY: 'test', BASE_URL: 'https://test.local',
    ANTHROPIC_API_KEY: 'test', SENDGRID_API_KEY: 'test', SENDGRID_FROM_EMAIL: 'a@test.local',
  },
}));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../ai/claude', () => ({
  generateReply: vi.fn(), classifyIntent: vi.fn(), withAnthropicRetry: vi.fn(),
  AnthropicOverloadError: class AnthropicOverloadError extends Error {},
}));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn(), normalizeReSubject: (s: string) => s }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));

import { pickScheduleToDistribute } from '../schedule-build';

// Issue 6: distributing a week that already has a stale published+distributed row
// must pick the FRESHLY-BUILT draft (newest generated_at), not the old published
// row (whose distributed_at trips the re-distribution guard → "already sent").
describe('pickScheduleToDistribute', () => {
  it('picks the newest build even when an older published row exists', () => {
    const rows = [
      { id: 'old-published', status: 'published', generated_at: '2026-08-02T20:24:37Z' },
      { id: 'fresh-draft', status: 'draft', generated_at: '2026-08-04T00:48:50Z' },
    ];
    expect(pickScheduleToDistribute(rows)?.id).toBe('fresh-draft');
  });

  it('tie-breaks equal generated_at to the published row', () => {
    const rows = [
      { id: 'd', status: 'draft', generated_at: '2026-08-04T00:00:00Z' },
      { id: 'p', status: 'published', generated_at: '2026-08-04T00:00:00Z' },
    ];
    expect(pickScheduleToDistribute(rows)?.id).toBe('p');
  });

  it('returns the sole row, and null for an empty set', () => {
    expect(pickScheduleToDistribute([{ id: 'only', status: 'published', generated_at: '2026-08-01T00:00:00Z' }])?.id).toBe('only');
    expect(pickScheduleToDistribute([])).toBeNull();
  });
});
