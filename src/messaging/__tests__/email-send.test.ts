import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks shared with the hoisted vi.mock factories.
const h = vi.hoisted(() => {
  const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  const chain: Record<string, unknown> = {
    select: () => chain, eq: () => chain, limit: () => chain, maybeSingle,
  };
  return {
    send: vi.fn(),
    setApiKey: vi.fn(),
    supabase: { from: () => chain },
    saveConversation: vi.fn().mockResolvedValue(undefined),
    resolveMonitoringEmails: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('@sendgrid/mail', () => ({ default: { setApiKey: h.setApiKey, send: h.send } }));
vi.mock('../../config/env', () => ({
  env: { SENDGRID_API_KEY: 'k', SENDGRID_FROM_EMAIL: 'aegis@quria.test', SENDGRID_FROM_NAME: 'Aegis', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k', NODE_ENV: 'test' },
}));
vi.mock('../../db/client', () => ({ supabase: h.supabase }));
vi.mock('../../logger/conversation', () => ({ saveConversation: h.saveConversation }));
vi.mock('../monitoring', () => ({ resolveMonitoringEmails: h.resolveMonitoringEmails, buildBccList: () => [] }));

import { sendEmail } from '../email';

// The 401 that broke swap outreach in live testing was swallowed, so the workflow
// reported "I've reached out to Riley" while nothing sent. sendEmail must now
// report success/failure honestly (never throwing) so callers can tell the truth.
describe('sendEmail — honest success/failure boolean', () => {
  beforeEach(() => {
    h.send.mockReset();
    h.saveConversation.mockClear().mockResolvedValue(undefined);
  });

  it('returns true when SendGrid accepts the message, and logs the conversation', async () => {
    h.send.mockResolvedValue([{ statusCode: 202 }]);
    const ok = await sendEmail({ to: 'a@b.test', subject: 's', text: 't', company_id: 'c1' });
    expect(ok).toBe(true);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.saveConversation).toHaveBeenCalledTimes(1);
  });

  it('returns false (never throws) when SendGrid rejects — e.g. 401 bad key', async () => {
    h.send.mockRejectedValue(Object.assign(new Error('Unauthorized'), { code: 401 }));
    let threw = false;
    let ok: boolean | undefined;
    try {
      ok = await sendEmail({ to: 'a@b.test', subject: 's', text: 't', company_id: 'c1' });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(ok).toBe(false);
    // a failed send must NOT be logged as an outbound conversation
    expect(h.saveConversation).not.toHaveBeenCalled();
  });

  it('still returns true if only the bookkeeping (saveConversation) fails', async () => {
    h.send.mockResolvedValue([{ statusCode: 202 }]);
    h.saveConversation.mockRejectedValueOnce(new Error('db down'));
    const ok = await sendEmail({ to: 'a@b.test', subject: 's', text: 't', company_id: 'c1' });
    expect(ok).toBe(true); // the email went out; logging failure doesn't flip it
  });
});
