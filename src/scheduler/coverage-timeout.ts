import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { reply } from '../messaging/reply';
import { dispatchOutreach } from '../workflows/emergency-coverage';
import {
  checkStaleOnboardingSessions,
  expireOldOnboardingSessions,
} from '../workflows/employee-onboarding';
import type { ActiveOutreach, CoverageSession, OutreachResult } from '../workflows/emergency-coverage';
import type { Employee } from '../db/types';
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

  // Load the parent coverage session
  const session = await loadSession(outreach.company_id);

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
  const timedOutName =
    session.outreach_results.find(r => r.employee_id === outreach.employee_id)?.employee_name ??
    'Employee';

  // 1. Remove the expired outreach record
  await supabase.from('aegis_memory').delete().eq('id', outreachMemoryId);

  // 2. Mark this employee as no_response in the session results
  const updatedResults: OutreachResult[] = session.outreach_results.map(r =>
    r.employee_id === outreach.employee_id
      ? { ...r, response: 'no_response' as const, responded_at: new Date().toISOString() }
      : r
  );

  // 3. Find the next pending employee in the queue
  const nextId = session.outreach_queue.find(empId =>
    updatedResults.some(r => r.employee_id === empId && r.response === 'pending')
  );

  const managerContact = buildManagerContact(outreach);
  const managerMsg = buildManagerMessage(outreach);

  if (nextId) {
    // Load next employee record
    const { data: empData } = await supabase
      .from('employees')
      .select('*')
      .eq('id', nextId)
      .single();
    const nextEmp = empData as Employee | null;

    // Update session results regardless of whether we can contact the next employee
    const updatedSession: CoverageSession = { ...session, outreach_results: updatedResults };
    await updateSession(updatedSession);

    if (!nextEmp) {
      await reply(
        managerContact,
        managerMsg,
        `${timedOutName} did not respond within the ${session.urgency_window_minutes}-minute window. ` +
          `The next employee in the queue could not be found. Please follow up directly.`
      );
      await logActivity({
        company_id: outreach.company_id,
        action: 'emergency_coverage_timeout',
        summary: `Outreach to ${timedOutName} timed out — next employee not found in DB`,
        metadata: {
          timed_out_employee_id: outreach.employee_id,
          next_employee_id: nextId,
          shift_date: outreach.shift_date,
          shift_name: outreach.shift_info.shift_name,
        },
      });
      return;
    }

    // Dispatch outreach to next employee
    const dispatchResult = await dispatchOutreach({
      employee: nextEmp,
      session: updatedSession,
      aegisSmsNumber: outreach.aegis_sms_channel,
    });

    if (dispatchResult.sent) {
      await reply(
        managerContact,
        managerMsg,
        `${timedOutName} did not respond within the ${session.urgency_window_minutes}-minute window. ` +
          `Now contacting ${nextEmp.name} (window: ${session.urgency_window_minutes} min).`
      );
    } else {
      await reply(
        managerContact,
        managerMsg,
        `${timedOutName} did not respond. Unable to contact ${nextEmp.name}: ${dispatchResult.reason}. ` +
          `No further employees can be reached automatically — please contact staff directly.`
      );
    }

    await logActivity({
      company_id: outreach.company_id,
      action: 'emergency_coverage_timeout',
      summary: `Outreach to ${timedOutName} timed out — ${dispatchResult.sent ? `advancing to ${nextEmp.name}` : `unable to contact ${nextEmp.name}`}`,
      metadata: {
        timed_out_employee_id: outreach.employee_id,
        timed_out_name: timedOutName,
        next_employee_id: nextId,
        next_employee_name: nextEmp.name,
        next_dispatch_sent: dispatchResult.sent,
        window_minutes: session.urgency_window_minutes,
        shift_date: outreach.shift_date,
        shift_name: outreach.shift_info.shift_name,
        role: outreach.shift_info.role,
      },
    });
  } else {
    // Queue exhausted — no more pending employees
    await clearSession(outreach.company_id);

    await reply(
      managerContact,
      managerMsg,
      `${timedOutName} did not respond within the ${session.urgency_window_minutes}-minute window. ` +
        `The outreach queue is exhausted — no coverage found for the ${outreach.shift_info.shift_name} shift on ` +
        `${formatShortDate(outreach.shift_date)}. Please contact additional staff directly.`
    );

    await logActivity({
      company_id: outreach.company_id,
      action: 'emergency_coverage_queue_exhausted',
      summary: `Outreach queue exhausted after timeout from ${timedOutName} — no coverage found for ${outreach.shift_date}`,
      metadata: {
        timed_out_employee_id: outreach.employee_id,
        timed_out_name: timedOutName,
        shift_date: outreach.shift_date,
        shift_name: outreach.shift_info.shift_name,
        role: outreach.shift_info.role,
        all_results: updatedResults,
      },
    });
  }
}

// ── Session DB helpers ────────────────────────────────────────────────────────
// These are local to the scheduler — emergency-coverage.ts has its own copies.
// Duplication is intentional: the scheduler is a separate process context.

async function loadSession(
  companyId: string
): Promise<(CoverageSession & { _memory_id: string }) | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .eq('source', `coverage_session:${companyId}`)
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
  } else {
    await supabase.from('aegis_memory').delete()
      .eq('company_id', session.company_id)
      .eq('source', `coverage_session:${session.company_id}`);
    await supabase.from('aegis_memory').insert({
      company_id: session.company_id,
      memory_type: 'observation',
      source: `coverage_session:${session.company_id}`,
      content: JSON.stringify(data),
    });
  }
}

async function clearSession(companyId: string): Promise<void> {
  await supabase.from('aegis_memory').delete()
    .eq('company_id', companyId)
    .eq('source', `coverage_session:${companyId}`);
}

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
