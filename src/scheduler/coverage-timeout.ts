import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { promptForNextBatchOrExhaust } from '../workflows/emergency-coverage';
import {
  checkStaleOnboardingSessions,
  expireOldOnboardingSessions,
} from '../workflows/employee-onboarding';
import type { ActiveOutreach, CoverageSession, OutreachResult } from '../workflows/emergency-coverage';
import type { InboundMessage, VerifiedContact } from '../security/types';

const POLL_INTERVAL_MS = 60_000;
const ONBOARDING_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

// ── Scheduler entry point ─────────────────────────────────────────────────────

export function startCoverageTimeoutScheduler(): void {
  console.log('[coverage-timeout] scheduler started — polling every 60 seconds');
  void runPollCycle();
  setInterval(() => void runPollCycle(), POLL_INTERVAL_MS);

  console.log('[onboarding-timeout] daily stale-session check started');
  void checkStaleOnboardingSessions();
  setInterval(() => void checkStaleOnboardingSessions(), ONBOARDING_CHECK_INTERVAL_MS);

  console.log('[onboarding-expire] daily proactive 48h expiry started');
  void expireOldOnboardingSessions();
  setInterval(() => void expireOldOnboardingSessions(), ONBOARDING_CHECK_INTERVAL_MS);
}

// ── Poll cycle ────────────────────────────────────────────────────────────────

async function runPollCycle(): Promise<void> {
  const { data: rows, error } = await supabase
    .from('aegis_memory')
    .select('id, company_id, source, content')
    .like('source', 'outreach_active:%');

  if (error) {
    console.error('[coverage-timeout] DB query failed:', error.message);
    return;
  }

  const records = (rows ?? []) as {
    id: string;
    company_id: string;
    source: string;
    content: string;
  }[];

  if (records.length === 0) return;

  let checked = 0;
  let timedOut = 0;
  let skipped = 0;

  for (const record of records) {
    checked++;
    try {
      const outcome = await processRecord(record);
      if (outcome === 'timed_out') timedOut++;
      else skipped++;
    } catch (err) {
      console.error(`[coverage-timeout] error processing ${record.source}:`, err);
      // Continue — one failure must not stop the rest of the cycle
    }
  }

  console.log(
    `[coverage-timeout] poll complete — ${checked} checked, ${timedOut} timed out, ${skipped} skipped`
  );
}

// ── Record processor ──────────────────────────────────────────────────────────

type ProcessOutcome = 'timed_out' | 'skipped';

async function processRecord(record: {
  id: string;
  company_id: string;
  source: string;
  content: string;
}): Promise<ProcessOutcome> {
  let outreach: ActiveOutreach;
  try {
    outreach = JSON.parse(record.content) as ActiveOutreach;
  } catch {
    // Corrupted record — remove and skip
    await supabase.from('aegis_memory').delete().eq('id', record.id);
    await logActivity({
      company_id: record.company_id,
      action: 'emergency_coverage_timeout_skipped',
      summary: `Removed corrupted outreach record: ${record.source}`,
      metadata: { source: record.source },
    });
    return 'skipped';
  }

  // Window hasn't expired yet — nothing to do
  if (new Date(outreach.window_expires_at) > new Date()) {
    return 'skipped';
  }

  // Outreach record itself says coverage already filled — clean up stale record
  if (outreach.coverage_filled) {
    await supabase.from('aegis_memory').delete().eq('id', record.id);
    return 'skipped';
  }

  // Load the parent coverage session — by the id the outreach carries (D19).
  const session = await loadSession(outreach.company_id, outreach.session_id);

  if (!session) {
    // Orphaned outreach — no parent session exists, clean up
    await supabase.from('aegis_memory').delete().eq('id', record.id);
    await logActivity({
      company_id: outreach.company_id,
      action: 'emergency_coverage_timeout_skipped',
      summary: `Removed orphaned outreach record for employee ${outreach.employee_id} — no parent session found`,
      metadata: { source: record.source, employee_id: outreach.employee_id },
    });
    return 'skipped';
  }

  if (session.coverage_filled) {
    // Session already resolved — clean up stale outreach record
    await supabase.from('aegis_memory').delete().eq('id', record.id);
    return 'skipped';
  }

  // Process the timeout: treat as no_response and advance the queue
  await handleTimeout(record.id, outreach, session);
  return 'timed_out';
}

// ── Timeout handler ───────────────────────────────────────────────────────────

async function handleTimeout(
  outreachMemoryId: string,
  outreach: ActiveOutreach,
  session: CoverageSession & { _memory_id: string }
): Promise<void> {
  // 1. Remove the expired outreach record.
  await supabase.from('aegis_memory').delete().eq('id', outreachMemoryId);

  // 2. Mark this employee as no_response.
  const updatedResults: OutreachResult[] = session.outreach_results.map(r =>
    r.employee_id === outreach.employee_id
      ? { ...r, response: 'no_response' as const, responded_at: new Date().toISOString() }
      : r
  );

  // 3. If others in the contacted batch are still pending, just record it and
  // keep waiting — we only escalate once the whole group has lapsed.
  const anyPending = session.outreach_queue.some(id =>
    updatedResults.some(r => r.employee_id === id && r.response === 'pending')
  );
  if (anyPending) {
    await updateSession({ ...session, outreach_results: updatedResults });
    return;
  }

  // 4. Whole contacted group lapsed with no acceptance. Ask the manager whether
  // to send another batch — never auto-send. (Shared with the decline path.)
  await promptForNextBatchOrExhaust({
    session,
    managerContact: buildManagerContact(outreach),
    managerMessage: buildManagerMessage(outreach),
    updatedResults,
  });
}

// ── Session DB helpers ────────────────────────────────────────────────────────
// These are local to the scheduler — emergency-coverage.ts has its own copies.
// Duplication is intentional: the scheduler is a separate process context.

// D19 — sessions are keyed per call-out (`coverage_session:<session_id>`), so the
// scheduler loads the specific session an outreach belongs to. Falls back to the
// legacy per-company key for any outreach/session that predates the change.
function sessionSource(sessionId: string): string {
  return `coverage_session:${sessionId}`;
}

async function loadSession(
  companyId: string,
  sessionId: string | undefined
): Promise<(CoverageSession & { _memory_id: string }) | null> {
  const source = sessionId ? sessionSource(sessionId) : `coverage_session:${companyId}`;
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .eq('source', source)
    .maybeSingle();

  if (!data) return null;

  try {
    const row = data as { id: string; content: string };
    const session = JSON.parse(row.content) as CoverageSession;
    return { ...session, _memory_id: row.id };
  } catch {
    return null;
  }
}

async function updateSession(session: CoverageSession & { _memory_id?: string }): Promise<void> {
  const { _memory_id, ...data } = session;
  if (_memory_id) {
    await supabase.from('aegis_memory').update({ content: JSON.stringify(data) }).eq('id', _memory_id);
    return;
  }
  const source = session.session_id ? sessionSource(session.session_id) : `coverage_session:${session.company_id}`;
  await supabase.from('aegis_memory').delete()
    .eq('company_id', session.company_id)
    .eq('source', source);
  await supabase.from('aegis_memory').insert({
    company_id: session.company_id,
    memory_type: 'observation',
    source,
    content: JSON.stringify(data),
  });
}

// (No clearSession here — the scheduler never resolves a session to "done";
// it only advances the queue or hands off to promptForNextBatchOrExhaust, which
// owns clearing. emergency-coverage.ts has the clearing logic.)

// ── Formatting ────────────────────────────────────────────────────────────────

function formatShortDate(dateStr: string): string {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

// ── Manager reply construction ────────────────────────────────────────────────
// Reconstructs the synthetic InboundMessage/VerifiedContact stored in the
// outreach record so we can reply to the manager from a background context.

function buildManagerContact(outreach: ActiveOutreach): VerifiedContact {
  return {
    role: 'manager',
    company_id: outreach.company_id,
    employee_id: null,
    user_id: null,
    name: 'Manager',
    matched_identifier: outreach.manager_contact,
    channel: outreach.manager_channel,
  };
}

function buildManagerMessage(outreach: ActiveOutreach): InboundMessage {
  return {
    sender: outreach.manager_sender,
    recipient: outreach.manager_recipient,
    body: '',
    channel: outreach.manager_channel,
    raw_subject: outreach.manager_raw_subject,
    thread_id: outreach.manager_thread_id,
  };
}
