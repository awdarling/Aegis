import { describe, it, expect, vi, beforeEach } from 'vitest';

// H7 (DRIFT_REGISTER) — the emergency-coverage manager handler must YIELD a
// clearly-different actionable request instead of swallowing it as "manager
// declining". These tests prove the wiring: when the interrupt classifier flags
// a different intent, the coverage session is PAUSED (not abandoned), the router
// re-handles the message, and the call-out is then RESUMED with a short nudge so
// the manager can finish it later; a genuine decline still ends the session with
// the usual reply.

vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local', SUPABASE_SERVICE_ROLE_KEY: 'test',
    BASE_URL: 'https://test.local', ANTHROPIC_API_KEY: 'test',
    SENDGRID_API_KEY: 'test', SENDGRID_FROM_EMAIL: 'a@test.local', EMAIL_ONLY: true,
  },
}));

// A permissive query-builder mock: every builder method chains, terminals resolve
// to empty. Enough for clearSession's delete and findEmployeeByName's lookups.
function q(): any {
  const p: any = Promise.resolve({ data: null, error: null });
  for (const m of ['select','insert','update','delete','upsert','eq','neq','is','in','or','and','not','filter','ilike','like','gte','lte','gt','lt','contains','overlaps','order','limit','range']) {
    p[m] = () => q();
  }
  p.single = () => Promise.resolve({ data: null, error: null });
  p.maybeSingle = () => Promise.resolve({ data: null, error: null });
  return p;
}
vi.mock('../../db/client', () => ({ supabase: { from: () => q() } }));

const generateReply = vi.fn();
vi.mock('../../ai/claude', () => ({
  generateReply: (...a: unknown[]) => generateReply(...a),
  classifyIntent: vi.fn(),
  AnthropicOverloadError: class extends Error {},
}));

const reply = vi.fn(async () => {});
vi.mock('../../messaging/reply', () => ({ reply: (...a: unknown[]) => reply(...a), sendInThreadAck: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ computeWageEstimate: vi.fn(async () => 0) }));

// The two modules the yield helper dynamically imports.
const managerInterruptIntent = vi.fn();
vi.mock('../../router/interrupt', () => ({
  managerInterruptIntent: (...a: unknown[]) => managerInterruptIntent(...a),
}));
const routeIntent = vi.fn(async () => {});
vi.mock('../../router/intent-router', () => ({ routeIntent: (...a: unknown[]) => routeIntent(...a) }));

import { handleManagerCoverageReply, resumeCoveragePrompt, type CoverageSession } from '../emergency-coverage';
import type { InboundMessage, VerifiedContact } from '../../security/types';

const mgr: VerifiedContact = {
  role: 'manager', company_id: 'co-1', employee_id: null, user_id: 'u1',
  name: 'Manager', matched_identifier: 'm@club.com', channel: 'sms',
};
const msg = (body: string): InboundMessage => ({
  sender: 'm@club.com', recipient: 'aegis@club.com', body, channel: 'sms',
});
function session(over: Partial<CoverageSession> = {}): CoverageSession {
  return {
    session_id: 'sess-1', company_id: 'co-1', manager_contact: 'm@club.com',
    manager_channel: 'sms', manager_sender: 'm@club.com', manager_recipient: 'aegis@club.com',
    callout_employee_id: 'e9', callout_employee_name: 'Jamie',
    shift_date: '2026-08-08',
    shift_info: { shift_name: 'Morning', start_time: '09:00', end_time: '13:00', role: 'Lifeguard' } as CoverageSession['shift_info'],
    state: 'awaiting_names', outreach_queue: [], outreach_results: [],
    coverage_filled: false, covered_by_employee_id: null, urgency_window_minutes: 60,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...over,
  } as CoverageSession;
}

beforeEach(() => {
  reply.mockClear(); routeIntent.mockClear(); managerInterruptIntent.mockReset(); generateReply.mockReset();
});

describe('H7 — coverage yields to a different actionable intent', () => {
  it('a mid-coverage query ("who\'s free saturday?") yields to the router, then resumes with a nudge', async () => {
    generateReply.mockResolvedValue('{"names":[]}');            // extractOutreachNames → no names
    managerInterruptIntent.mockResolvedValue('operational_query');
    await handleManagerCoverageReply(msg("who's free saturday?"), mgr, session());
    expect(routeIntent).toHaveBeenCalledTimes(1);
    // The ONE reply is the resume nudge (the call-out is still open), NOT the
    // "I'll leave it with you" decline.
    expect(reply).toHaveBeenCalledTimes(1);
    const body = reply.mock.calls[0][2] as string;
    expect(body.toLowerCase()).toContain('still got the coverage request');
    expect(body).not.toContain("I'll leave it with you");
  });

  it('"approve Sam\'s swap" mid-coverage yields even when the name-extractor grabbed a name', async () => {
    generateReply.mockResolvedValue('{"names":["Sam"]}');        // extractor mistakenly grabbed Sam
    managerInterruptIntent.mockResolvedValue('approve_swap');    // but it classifies as an ACTION
    await handleManagerCoverageReply(msg("approve Sam's swap"), mgr, session());
    expect(routeIntent).toHaveBeenCalledTimes(1);
    // did not fall through to contacting anyone
    expect(managerInterruptIntent).toHaveBeenCalledWith(expect.anything(), expect.anything(), { allowQueries: false });
    // and the call-out is resumed with a nudge rather than abandoned
    expect(reply).toHaveBeenCalledTimes(1);
    expect((reply.mock.calls[0][2] as string).toLowerCase()).toContain('coverage request');
  });

  it('a genuine decline still ends the session and does NOT re-route', async () => {
    generateReply.mockResolvedValue('{"names":[]}');
    managerInterruptIntent.mockResolvedValue(null);             // not a different intent
    await handleManagerCoverageReply(msg('nah never mind'), mgr, session());
    expect(routeIntent).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);                     // the "I'll leave it with you" reply
  });

  it('a bare name ("Kori") does NOT yield — it proceeds down the contact path', async () => {
    generateReply.mockResolvedValue('{"names":["Kori"]}');
    managerInterruptIntent.mockResolvedValue(null);            // bare name is not an interrupt
    await handleManagerCoverageReply(msg('Kori'), mgr, session());
    expect(routeIntent).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalled();                          // "couldn't find employees named Kori" (no such row in mock)
  });

  it('a batch-decision reply that yields also resumes (state-aware nudge)', async () => {
    // On the awaiting_next_batch_decision branch, a query interrupt yields with
    // allowQueries:true, then resumes with the YES-for-more-people nudge.
    managerInterruptIntent.mockResolvedValue('operational_query');
    await handleManagerCoverageReply(msg("who's on saturday?"), mgr, session({ state: 'awaiting_next_batch_decision' }));
    expect(routeIntent).toHaveBeenCalledTimes(1);
    expect(managerInterruptIntent).toHaveBeenCalledWith(expect.anything(), expect.anything(), { allowQueries: true });
    expect((reply.mock.calls.at(-1)?.[2] as string).toLowerCase()).toContain('reply yes');
  });
});

describe('H7 — resumeCoveragePrompt (state-aware resume nudge)', () => {
  it('awaiting_names → asks for a name / "all"', () => {
    const p = resumeCoveragePrompt(session({ state: 'awaiting_names' }));
    expect(p).toContain("Jamie's Morning shift");
    expect(p.toLowerCase()).toContain('reply with a name');
  });
  it('awaiting_next_batch_decision → asks for YES to reach more people', () => {
    const p = resumeCoveragePrompt(session({ state: 'awaiting_next_batch_decision' }));
    expect(p.toLowerCase()).toContain('reply yes');
  });
});
