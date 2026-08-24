import { Router } from 'express';
import { supabase } from '../db/client';
import { formatDateRange } from '../workflows/time-off-manager-email';
import { managerStillActive } from '../security/manager-active';
import { logActivity } from '../logger/activity-log';
import { sendEmail } from '../messaging/email';
import { sendSms } from '../messaging/sms';
import { env } from '../config/env';
import { normalizeReSubject } from '../messaging/reply';
import { executeScheduleSwap, executeScheduleTrade } from '../workflows/shift-swap';
// L4 / L4b — RULE 0b: the single answer to "what kind of swap is this row, and
// how (or whether) may the Homebase UI execute it?".
import { planRowExecution } from '../lib/swap-kind';
import { processCoverageButtonDecision, processCoverageBatchButton } from '../workflows/emergency-coverage';
import { computeWageEstimate } from '../lib/schedule-simulator';
import { BRAND, quriaLogoDataUri } from '../messaging/brand';
import type { Employee } from '../db/types';

// Escape user-supplied text before it lands in an HTML page.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Shared Aegis-branded landing page (dark surface + orange accent + logo header)
// so the /webhooks/decision pages match the branded emails and the Homebase
// aegis-action pages, instead of the old plain-white card.
export function brandedPage(opts: { title: string; heading: string; headingColor: string; icon: string; iconColor: string; body: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(opts.title)} — Aegis</title>
  <style>
    body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: ${BRAND.bgBase}; }
    .card { background: ${BRAND.surface2}; border: 1px solid ${BRAND.borderDefault}; border-radius: 14px; max-width: 420px; width: 90%; overflow: hidden; box-shadow: 0 8px 30px rgba(0,0,0,.5); }
    .hdr { display: flex; align-items: center; gap: 12px; padding: 18px 24px; background: ${BRAND.bgBase}; border-bottom: 2px solid ${BRAND.accent}; }
    .hdr img { width: 34px; height: 34px; border-radius: 8px; }
    .hdr span { color: ${BRAND.textPrimary}; font-weight: 700; font-size: 20px; }
    .body { padding: 34px 28px; text-align: center; }
    .icon { font-size: 30px; color: ${opts.iconColor}; }
    h1 { font-size: 22px; margin: 14px 0 8px; color: ${opts.headingColor}; }
    p { color: ${BRAND.textSecondary}; font-size: 15px; margin: 0; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="hdr"><img src="${quriaLogoDataUri()}" alt="Aegis"><span>Aegis</span></div>
    <div class="body">
      <div class="icon">${opts.icon}</div>
      <h1>${escapeHtml(opts.heading)}</h1>
      <p>${opts.body}</p>
    </div>
  </div>
</body>
</html>`;
}

export const decisionWebhook = Router();

// ── Types ─────────────────────────────────────────────────────────────────────

// Time-off token — decision_type is always normalised to 'time_off' on parse.
// thread_id/raw_subject carry the inbound email's Message-ID and Subject so
// the approve/deny notice to the employee threads back into the original
// conversation. Both are null for SMS submissions.
interface TimeOffDecisionToken {
  decision_type: 'time_off';
  action: 'approve' | 'deny';
  request_id: string;
  company_id: string;
  employee_id: string;
  employee_name: string;
  employee_channel: 'sms' | 'email';
  employee_contact: string;
  aegis_sms_channel: string | null;
  thread_id?: string | null;
  raw_subject?: string | null;
  // The manager the approve/deny link was sent to — used to attribute the
  // decision (decided_by + activity feed) to the person, not a system default.
  manager_user_id?: string | null;
  manager_name?: string | null;
  expires_at: string;
}

// Swap token
interface SwapDecisionToken {
  decision_type: 'swap';
  action: 'approve' | 'deny';
  request_id: string;
  company_id: string;
  requester_id: string;
  requester_name: string;
  requester_channel: 'sms' | 'email';
  requester_contact: string;
  aegis_sms_channel: string | null;
  receiver_id: string;
  receiver_name: string;
  shift_date: string;
  shift_name: string;
  role: string;
  // The manager who minted the approval email — persisted to swap_requests.decided_by
  // on approve/deny (Batch-1.5 #9), mirroring time-off. A single manager id is
  // resolved when the email is built, so the old "shared across managers → null"
  // note no longer holds.
  manager_user_id?: string | null;
  manager_name?: string | null;
  // Two-way trade (item 18): the target's shift the requester takes in return.
  // Present → execute a true trade; absent → legacy one-way reassignment.
  target_shift_date?: string | null;
  target_shift_name?: string | null;
  target_role?: string | null;
  target_shift_start?: string | null;
  target_shift_end?: string | null;
  expires_at: string;
}

// Coverage token — emergency-coverage Accept/Decline buttons. action is
// 'approve' (= accept the shift) | 'deny' (= decline), reusing the route's
// existing action vocabulary. The live outreach is looked up fresh by
// company_id + employee_id, so the token only needs identity + expiry.
interface CoverageDecisionToken {
  decision_type: 'coverage';
  action: 'approve' | 'deny';
  request_id: string;
  company_id: string;
  employee_id: string;
  employee_name: string;
  expires_at: string;
}

// Coverage "send another batch?" token (#11) — the MANAGER's button on the
// next-batch prompt. action 'approve' = send the next batch | 'deny' = stop.
// The live session is looked up fresh by company_id + manager_contact.
interface CoverageBatchDecisionToken {
  decision_type: 'coverage_batch';
  session_id?: string;
  action: 'approve' | 'deny';
  request_id: string;
  company_id: string;
  manager_contact: string;
  expires_at: string;
}

type DecisionToken = TimeOffDecisionToken | SwapDecisionToken | CoverageDecisionToken | CoverageBatchDecisionToken;

// ── HTML response helpers ─────────────────────────────────────────────────────

function confirmationPage(employeeName: string, action: 'approve' | 'deny'): string {
  const verb = action === 'approve' ? 'approved' : 'denied';
  const statusColor = action === 'approve' ? BRAND.goodText : BRAND.badText;
  return brandedPage({
    title: 'Decision Recorded',
    heading: 'Decision Recorded',
    headingColor: statusColor,
    icon: action === 'approve' ? '✓' : '✕',
    iconColor: statusColor,
    body: `Request ${verb}. I've let ${escapeHtml(employeeName)} know.`,
  });
}

function errorPage(message: string): string {
  return brandedPage({
    title: 'Error',
    heading: 'Unable to Process',
    headingColor: BRAND.badText,
    icon: '⚠️',
    iconColor: BRAND.warnText,
    body: escapeHtml(message),
  });
}

// ── Time-off notification ─────────────────────────────────────────────────────

// Decision notices are the single most important message in a flow, so they must
// never be silently dropped. Send over the employee's channel, but ALWAYS fall
// back to email if the SMS send fails or returns false (a transient Telnyx error
// or an unreachable/invalid number must not lose a decision). Mirrors the
// submission-confirmation path. (DRIFT_REGISTER H2 / batch 2a)
export async function notifyEmployeeDecision(opts: {
  company_id: string;
  smsChannel: string | null;
  phone: string | null;
  email: string | null;
  body: string;
  subject: string;
  thread_id?: string | null;
  // The recipient employee — REQUIRED for the SMS leg (N3 consent gate). Blocked
  // → email fallback, which is the correct legal behavior for a decision notice.
  employee_id?: string | null;
}): Promise<boolean> {
  if (!env.EMAIL_ONLY && opts.phone && opts.smsChannel) {
    const ok = await sendSms({
      to: opts.phone,
      from: opts.smsChannel,
      body: opts.body,
      company_id: opts.company_id,
      employee_id: opts.employee_id ?? undefined,
    });
    if (ok) return true;
    console.warn(`[decision-notify] SMS send failed for company ${opts.company_id}; falling back to email`);
  }
  if (opts.email) {
    await sendEmail({ to: opts.email, subject: opts.subject, text: opts.body, company_id: opts.company_id, thread_id: opts.thread_id ?? undefined });
    return true;
  }
  console.error(`[decision-notify] no channel available to deliver decision notice for company ${opts.company_id}`);
  return false;
}

async function notifyEmployee(
  token: TimeOffDecisionToken,
  employee: Employee,
  action: 'approve' | 'deny'
): Promise<void> {
  const verb = action === 'approve' ? 'approved' : 'denied';
  // Name the date(s) so an employee with several requests in flight knows exactly
  // which one this decision covers.
  const { data: torDates } = await supabase
    .from('time_off_requests')
    .select('start_date, end_date')
    .eq('id', token.request_id)
    .maybeSingle();
  const tr = torDates as { start_date: string; end_date: string } | null;
  const forDates = tr ? ` for ${formatDateRange(tr.start_date, tr.end_date)}` : '';
  const messageText =
    action === 'approve'
      ? `Great news! Your time-off request${forDates} has been approved. Enjoy your time off!`
      : `Your time-off request${forDates} has been denied. Please contact your manager if you have questions or would like to discuss alternatives.`;

  const subject = token.raw_subject
    ? normalizeReSubject(token.raw_subject)
    : `Your time-off request has been ${verb}`;
  // SMS only when that's the employee's channel; the email fallback uses their
  // address on file (or the email-channel contact).
  const phone = token.employee_channel === 'sms' ? token.employee_contact : null;
  const email = employee.contact_email ?? (token.employee_channel === 'email' ? token.employee_contact : null);
  await notifyEmployeeDecision({
    company_id: token.company_id,
    smsChannel: token.aegis_sms_channel,
    phone,
    email,
    body: messageText,
    subject,
    thread_id: token.thread_id,
    employee_id: employee.id,
  });
}

// ── Swap decision handler ─────────────────────────────────────────────────────

// Approval confirmations for a swap decision. Two shapes:
//  • TRADE (both people exchange shifts): each person hears the shift they now work.
//  • GIVEAWAY (one-way — receiver covers, requester is off): the RECEIVER is the
//    coverer for BOTH parties, so both messages ground on the receiver, with the
//    right per-recipient perspective. The old code passed requester_name into the
//    receiver's own message, so the coverer was wrongly told the giver would cover
//    (WM giveaway confirmation bug, 2026-08-01). Never name the requester as coverer.
export function buildSwapDecisionMessages(
  token: Pick<SwapDecisionToken, 'shift_name' | 'receiver_name' | 'target_shift_name'>,
  isTrade: boolean,
  dateLong: string,
  targetDateLong: string,
): { requesterMsg: string; receiverMsg: string } {
  const tradeMsg = (worksShift: string, worksDate: string) =>
    `Your shift trade has been approved! You're now on the ${worksShift} shift on ${worksDate}.`;
  if (isTrade) {
    return {
      requesterMsg: tradeMsg(token.target_shift_name!, targetDateLong),
      receiverMsg: tradeMsg(token.shift_name, dateLong),
    };
  }
  // Giveaway: the receiver covers for both. The requester (giver) is told they're
  // off; the receiver (coverer) is told they'll cover — never that the giver covers.
  return {
    requesterMsg: `Your shift swap has been approved! ${token.receiver_name} will cover your ${token.shift_name} shift on ${dateLong} — you're off.`,
    receiverMsg: `Your shift swap has been approved! You'll cover the ${token.shift_name} shift on ${dateLong}.`,
  };
}

async function handleSwapDecision(
  res: import('express').Response,
  requestId: string,
  action: 'approve' | 'deny',
  token: SwapDecisionToken
): Promise<void> {
  // Load swap request
  const { data: swapRow, error: swapError } = await supabase
    .from('swap_requests')
    .select('*')
    .eq('id', requestId)
    .eq('company_id', token.company_id)
    .single();

  if (swapError || !swapRow) {
    res.status(404).send(errorPage('Swap request not found. It may have already been processed.'));
    return;
  }

  const swap = swapRow as {
    id: string; status: string; requesting_employee_id: string; receiving_employee_id: string | null;
    shift_date: string; shift_name: string; role: string;
    // L4 — the legacy swap-kind marker (fallback). L4b — the real columns.
    notes: string | null;
    kind: string | null;
    target_shift_date: string | null;
    target_shift_name: string | null;
    target_shift_role: string | null;
  };

  if (swap.status !== 'pending_manager') {
    res.status(409).send(errorPage(`This swap has already been ${swap.status}. No further action is needed.`));
    return;
  }

  // Load both employee records
  const [requesterRes, receiverRes] = await Promise.all([
    supabase.from('employees').select('*').eq('id', token.requester_id).single(),
    supabase.from('employees').select('*').eq('id', token.receiver_id).single(),
  ]);

  const requester = requesterRes.data as Employee | null;
  const receiver = receiverRes.data as Employee | null;

  // NOTE: a banned-pair (hard 'never' conflict) does NOT block the swap here —
  // per flag-don't-force, the manager was warned in their approval email and
  // makes the call. See buildSwapManagerApprovalEmail's bannedPairFlag.

  // ── D2 — THE SCHEDULE WRITE IS AUTHORITATIVE ────────────────────────────────
  //
  // This used to run in exactly the wrong order: set status='approved' FIRST,
  // then try to apply the swap, then email both employees "approved!" —
  // OUTSIDE the `if (schedRow && receiver)` guard. So when the week's schedule
  // was missing, still draft, or the assignment didn't match, the row read
  // 'approved', both employees were told the swap was done, and the schedule
  // never changed. The person who thought they were covered didn't show up.
  //
  // Now: apply the schedule change FIRST. Only if it actually lands do we mark
  // the swap approved (recording the schedule_id it landed on, as the receipt)
  // and tell anyone. If it fails, the row STAYS 'pending_manager' so the
  // manager can retry after publishing, and nobody is told a lie.
  const isTrade = !!(token.target_shift_name && token.target_shift_date);

  if (action === 'approve') {
    if (!receiver) {
      res.status(409).send(errorPage(
        'The employee picking up this shift could not be found, so the swap was not applied. Nothing has changed — the request is still awaiting your approval.',
      ));
      return;
    }

    // Find the schedule covering this shift date.
    //
    // L4 [SWAP-SCHEDULE-SELECT] — `.is('archived_at', null)` added so this agrees
    // with the PUBLISHER's own definition of "the live row for this week".
    //
    // Both publish paths (schedule-build.ts distributeScheduleCore + the
    // redistribute path, and Homebase's publish_schedule_swap RPC) supersede a
    // prior row with `{ status: 'archived', archived_at, superseded_by }`, keyed
    // on `published_at NOT NULL AND archived_at IS NULL`. So "live" is defined by
    // archived_at, while this query defined it by the status enum plus newest
    // generated_at — TWO definitions of one fact, which is precisely what lets a
    // writer and a reader land on different rows (SCHEMA_DRIFT_LOG 2026-07-01 s2,
    // where multiple published rows per week caused approved swaps not to appear
    // on the schedule the employee sees).
    //
    // Verified read-only 2026-08-16: NOT currently reachable. Live Watermark has
    // 12 published rows, ZERO with archived_at set and ZERO with status
    // 'archived' — no republish has fired in production yet — and because the
    // archive path sets BOTH status and archived_at, the status filter alone
    // still excludes superseded rows. This is defence in depth: it removes the
    // dependency on those two columns never disagreeing (a legacy row archived
    // by an older code path, a manual DB edit, or a republish from an OLDER
    // build whose generated_at outranks the live row).
    const { data: schedRow } = await supabase.from('schedules').select('id, data')
      .is('deleted_at', null).is('archived_at', null)
      .eq('company_id', token.company_id).eq('status', 'published')
      .lte('week_start', token.shift_date).gte('week_end', token.shift_date)
      .order('generated_at', { ascending: false }).limit(1).maybeSingle();

    if (!schedRow) {
      res.status(409).send(errorPage(
        `There's no published schedule covering ${token.shift_date} yet, so this swap can't be applied to it. ` +
        `Nothing has changed and nobody has been notified — publish the schedule for that week, then approve this again.`,
      ));
      return;
    }

    const row = schedRow as { id: string; data: { assignments: unknown[] } };
    const applied = isTrade
      ? await executeScheduleTrade(
          token.company_id, row.id,
          { date: token.shift_date, shift_name: token.shift_name, employee_id: token.requester_id, employee_name: token.requester_name },
          { date: token.target_shift_date!, shift_name: token.target_shift_name!, employee_id: token.receiver_id, employee_name: token.receiver_name },
        )
      : await executeScheduleSwap(
          token.company_id, row.id, token.shift_date, token.shift_name,
          token.requester_id, token.receiver_id, token.receiver_name,
        );

    if (!applied.ok) {
      // The schedule did NOT change. Do not approve, do not notify.
      console.error(`[swap-decision] apply failed (${applied.code}) for swap ${requestId}: ${applied.reason}`);
      res.status(409).send(errorPage(
        `${applied.reason} Nothing has changed and nobody has been notified — the request is still awaiting your approval.`,
      ));
      return;
    }

    // The schedule changed. NOW the approval is real — record it with the
    // receipt (schedule_id) in the same write. decided_by is the approving
    // manager's user id, carried on the token (Batch-1.5 #9).
    const { error: statusErr } = await supabase.from('swap_requests').update({
      status: 'approved',
      schedule_id: applied.schedule_id,
      decided_at: new Date().toISOString(),
      decided_by: token.manager_user_id ?? null,
    }).eq('id', requestId);
    if (statusErr) {
      // The schedule IS updated but the row didn't close. Say so loudly rather
      // than silently leaving a swap that's live on the schedule but reads as
      // pending — that's a reconciliation problem, not a no-op.
      console.error(`[swap-decision] schedule ${applied.schedule_id} updated but swap ${requestId} status write FAILED:`, statusErr);
    }

    await consumeSwapTokens(token.company_id, requestId);

    // Notify both employees — for a trade, each person hears the shift they now work.
    const dateLong = new Date(token.shift_date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const targetDateLong = token.target_shift_date
      ? new Date(token.target_shift_date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
      : dateLong;
    const { requesterMsg, receiverMsg } = buildSwapDecisionMessages(token, isTrade, dateLong, targetDateLong);
    const subj = isTrade ? 'Shift trade approved' : 'Swap approved';

    await notifyEmployeeDecision({ company_id: token.company_id, smsChannel: token.aegis_sms_channel, phone: requester?.contact_phone ?? null, email: requester?.contact_email ?? null, body: requesterMsg, subject: subj, employee_id: token.requester_id });
    await notifyEmployeeDecision({ company_id: token.company_id, smsChannel: token.aegis_sms_channel, phone: receiver?.contact_phone ?? null, email: receiver?.contact_email ?? null, body: receiverMsg, subject: subj, employee_id: token.receiver_id });
  } else {
    // Denied — no schedule change is involved, so the status write is safe to
    // do first. (D2 only reorders the APPROVE path, where a status of
    // 'approved' is a claim about the schedule that must be earned.)
    await supabase.from('swap_requests').update({
      status: 'denied',
      decided_at: new Date().toISOString(),
      decided_by: token.manager_user_id ?? null,
    }).eq('id', requestId);

    await consumeSwapTokens(token.company_id, requestId);

    // Notify both
    const deniedMsg = `Your shift ${isTrade ? 'trade' : 'swap'} request for the ${token.shift_name} shift on ${new Date(token.shift_date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} has been denied by your manager. Please contact them if you have questions.`;
    const subj = isTrade ? 'Shift trade denied' : 'Swap denied';
    await notifyEmployeeDecision({ company_id: token.company_id, smsChannel: token.aegis_sms_channel, phone: requester?.contact_phone ?? null, email: requester?.contact_email ?? null, body: deniedMsg, subject: subj, employee_id: token.requester_id });
    await notifyEmployeeDecision({ company_id: token.company_id, smsChannel: token.aegis_sms_channel, phone: receiver?.contact_phone ?? null, email: receiver?.contact_email ?? null, body: deniedMsg, subject: subj, employee_id: token.receiver_id });
  }

  const decisionPast = action === 'approve' ? 'approved' : 'denied';
  await logActivity({
    company_id: token.company_id,
    action: `swap_${decisionPast}`,
    entity_type: 'swap_request',
    entity_id: requestId,
    summary: `Swap between ${token.requester_name} and ${token.receiver_name} ${decisionPast} by manager via email`,
    metadata: { requester_id: token.requester_id, receiver_id: token.receiver_id, shift_date: token.shift_date, shift_name: token.shift_name },
  });

  res.send(confirmationPage(`${token.requester_name} & ${token.receiver_name}`, action));
}

async function consumeSwapTokens(companyId: string, requestId: string): Promise<void> {
  const { data: rows } = await supabase.from('aegis_memory').select('id, content')
    .eq('company_id', companyId).like('source', 'decision_token:%');
  if (!rows) return;
  const ids = (rows as { id: string; content: string }[])
    .filter(r => { try { return (JSON.parse(r.content) as { request_id?: string }).request_id === requestId; } catch { return false; } })
    .map(r => r.id);
  if (ids.length > 0) await supabase.from('aegis_memory').delete().in('id', ids);
}

// ── Coverage Accept/Decline (decision_type: 'coverage') ───────────────────────

function coverageResultPage(employeeName: string, outcome: 'accepted' | 'declined' | 'already_filled' | 'not_found', shiftName: string): string {
  const map = {
    accepted: { icon: '✅', color: BRAND.goodText, title: "You're covered in", body: `Thanks, ${employeeName}! You're confirmed for the ${shiftName} shift. Your manager has been notified.` },
    declined: { icon: '👍', color: BRAND.silver, title: 'Thanks for letting us know', body: `No problem, ${employeeName} — we'll find someone else for the ${shiftName} shift.` },
    already_filled: { icon: 'ℹ️', color: BRAND.reviewText, title: 'Already covered', body: `Thanks for responding! The ${shiftName} shift has already been filled — no action needed.` },
    not_found: { icon: '⌛', color: BRAND.badText, title: 'No longer active', body: `This coverage request is no longer active. If you think that's a mistake, reply to the email or contact your manager.` },
  }[outcome];
  return brandedPage({ title: 'Coverage', heading: map.title, headingColor: map.color, icon: map.icon, iconColor: map.color, body: map.body });
}

async function handleCoverageDecision(
  res: import('express').Response,
  requestId: string,
  action: 'approve' | 'deny',
  token: CoverageDecisionToken,
): Promise<void> {
  const result = await processCoverageButtonDecision({
    companyId: token.company_id,
    employeeId: token.employee_id,
    employeeName: token.employee_name,
    action: action === 'approve' ? 'accept' : 'decline',
  });
  // Single-use: drop both of this request's tokens so the link can't be replayed.
  await consumeSwapTokens(token.company_id, requestId);
  res.send(coverageResultPage(token.employee_name, result.outcome, result.shiftName));
}

// ── Coverage "send another batch?" (decision_type: 'coverage_batch') ──────────

function coverageBatchResultPage(outcome: 'sent' | 'stopped' | 'exhausted' | 'not_found', shiftName: string): string {
  const map = {
    sent: { icon: '📣', color: BRAND.goodText, title: 'On it', body: `I'm reaching out to the next batch of employees for the ${shiftName} shift. I'll let you know the moment someone accepts.` },
    stopped: { icon: '👍', color: BRAND.silver, title: "Got it", body: `I'll leave the ${shiftName} shift with you. Reply any time if you'd like me to find more coverage.` },
    exhausted: { icon: 'ℹ️', color: BRAND.reviewText, title: 'Everyone contacted', body: `I've now reached everyone qualified and available for the ${shiftName} shift. You'll need to contact staff directly.` },
    not_found: { icon: '⌛', color: BRAND.badText, title: 'No longer active', body: `This coverage request is no longer active. If you think that's a mistake, reply to the email or contact Aegis directly.` },
  }[outcome];
  return brandedPage({ title: 'Coverage', heading: map.title, headingColor: map.color, icon: map.icon, iconColor: map.color, body: map.body });
}

async function handleCoverageBatchDecision(
  res: import('express').Response,
  requestId: string,
  action: 'approve' | 'deny',
  token: CoverageBatchDecisionToken,
): Promise<void> {
  const result = await processCoverageBatchButton({
    companyId: token.company_id,
    managerContact: token.manager_contact,
    action: action === 'approve' ? 'send' : 'stop',
    sessionId: token.session_id,
  });
  // Single-use: drop both of this request's tokens so the link can't be replayed.
  await consumeSwapTokens(token.company_id, requestId);
  res.send(coverageBatchResultPage(result.outcome, result.shiftName));
}

// ── Route handler ─────────────────────────────────────────────────────────────

decisionWebhook.get('/', async (req, res) => {
  const { action, requestId, token } = req.query as Record<string, string>;

  // Validate required params
  if (!action || !requestId || !token) {
    res.status(400).send(errorPage('Invalid or missing parameters. This link may be malformed.'));
    return;
  }

  if (action !== 'approve' && action !== 'deny') {
    res.status(400).send(errorPage('Unknown action. Please use the links from your Aegis email.'));
    return;
  }

  // Look up the decision token in aegis_memory
  const { data: tokenData } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('source', `decision_token:${token}`)
    .maybeSingle();

  if (!tokenData) {
    res
      .status(404)
      .send(
        errorPage(
          'This link has already been used or has expired. If you need to change a decision, please contact Aegis directly.'
        )
      );
    return;
  }

  let decisionToken: DecisionToken;
  try {
    const row = tokenData as { id: string; content: string };
    // Normalise: tokens stored before swap support have no decision_type — default to 'time_off'
    const raw = JSON.parse(row.content) as Record<string, unknown>;
    decisionToken = { decision_type: 'time_off', ...raw } as DecisionToken;
  } catch {
    res.status(500).send(errorPage('An internal error occurred. Please try again.'));
    return;
  }

  // Check expiry
  if (new Date(decisionToken.expires_at) < new Date()) {
    await supabase
      .from('aegis_memory')
      .delete()
      .eq('source', `decision_token:${token}`);
    res.status(410).send(errorPage('This link has expired. Please ask the employee to resubmit their request.'));
    return;
  }

  // Verify requestId matches token
  if (decisionToken.request_id !== requestId) {
    res.status(400).send(errorPage('This link does not match the request. Please use the links from your Aegis email.'));
    return;
  }

  // Verify action matches token (each token has a fixed action)
  if (decisionToken.action !== action) {
    res.status(400).send(errorPage('Action mismatch. Please use the correct Approve or Deny button from your email.'));
    return;
  }

  // S-3 (actor half): the link was minted for a specific manager. If that
  // login has since been revoked, the link is dead — regardless of expiry.
  const actorId = 'manager_user_id' in decisionToken ? decisionToken.manager_user_id : null;
  if (!(await managerStillActive(actorId))) {
    console.log('[decision] refused — manager login revoked or unknown', { actorId, requestId });
    res.status(403).send(errorPage('This link belongs to a login that no longer has manager access. Please ask a current manager to review the request in Homebase.'));
    return;
  }

  // Branch: swap vs coverage vs time-off
  if (decisionToken.decision_type === 'swap') {
    await handleSwapDecision(res, requestId, action as 'approve' | 'deny', decisionToken);
    return;
  }

  if (decisionToken.decision_type === 'coverage') {
    await handleCoverageDecision(res, requestId, action as 'approve' | 'deny', decisionToken);
    return;
  }

  if (decisionToken.decision_type === 'coverage_batch') {
    await handleCoverageBatchDecision(res, requestId, action as 'approve' | 'deny', decisionToken);
    return;
  }

  // Look up the time-off request
  const { data: torData, error: torError } = await supabase
    .from('time_off_requests')
    .select('*')
    .eq('id', requestId)
    .eq('company_id', decisionToken.company_id)
    .single();

  if (torError || !torData) {
    res.status(404).send(errorPage('Time-off request not found. It may have already been processed.'));
    return;
  }

  const tor = torData as { id: string; status: string; employee_id: string; start_date: string; end_date: string; reason: string | null };

  if (tor.status !== 'pending') {
    res
      .status(409)
      .send(
        errorPage(
          `This request has already been ${tor.status}. No further action is needed.`
        )
      );
    return;
  }

  // Load employee record for notification
  const { data: empData } = await supabase
    .from('employees')
    .select('*')
    .eq('id', decisionToken.employee_id)
    .eq('company_id', decisionToken.company_id)
    .single();

  const employee = empData as Employee | null;

  // Update time_off_requests status. Attribute the decision to the manager the
  // approve/deny link was sent to, so the record credits the person who acted.
  await supabase
    .from('time_off_requests')
    .update({
      status: action === 'approve' ? 'approved' : 'denied',
      decided_at: new Date().toISOString(),
      decided_by: decisionToken.manager_user_id ?? null,
    })
    .eq('id', requestId);

  // Consume the token — delete both approve and deny tokens for this request
  await supabase
    .from('aegis_memory')
    .delete()
    .like('source', 'decision_token:%')
    .eq('content', JSON.stringify({ ...decisionToken }));

  // Also clean up the sibling token by querying for the same request_id
  const { data: siblingTokens } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .like('source', 'decision_token:%')
    .eq('company_id', decisionToken.company_id);

  if (siblingTokens) {
    const siblings = (siblingTokens as { id: string; content: string }[]).filter(row => {
      try {
        const parsed = JSON.parse(row.content) as { request_id?: string };
        return parsed.request_id === requestId;
      } catch {
        return false;
      }
    });
    if (siblings.length > 0) {
      await supabase
        .from('aegis_memory')
        .delete()
        .in('id', siblings.map(s => s.id));
    }
  }

  // Log the decision
  const decisionPast = action === 'approve' ? 'approved' : 'denied';
  const deciderName = decisionToken.manager_name ?? null;
  await logActivity({
    company_id: decisionToken.company_id,
    // A manager clicked the approve/deny link — credit the manager, not the
    // 'aegis' default (which read on the feed as the assistant deciding itself).
    actor: 'manager',
    actor_name: deciderName,
    action: `time_off_${decisionPast}`,
    entity_type: 'time_off_request',
    entity_id: requestId,
    summary: `Time-off request for ${decisionToken.employee_name} ${decisionPast}${deciderName ? ` by ${deciderName}` : ''} via email link`,
    metadata: {
      employee_id: decisionToken.employee_id,
      start_date: tor.start_date,
      end_date: tor.end_date,
      reason: tor.reason,
      decided_by: decisionToken.manager_user_id ?? null,
    },
  });

  // Record a pattern in aegis_memory for future reference
  await supabase.from('aegis_memory').insert({
    company_id: decisionToken.company_id,
    memory_type: 'pattern',
    source: 'time_off_decision_history',
    content: JSON.stringify({
      employee_id: decisionToken.employee_id,
      employee_name: decisionToken.employee_name,
      action,
      start_date: tor.start_date,
      end_date: tor.end_date,
      reason: tor.reason,
      decided_at: new Date().toISOString(),
    }),
  });

  // Notify employee
  if (employee) {
    try {
      await notifyEmployee(decisionToken, employee, action);
    } catch (err) {
      console.error('[decision] employee notification failed:', err);
    }
  }

  // Return HTML confirmation page to the manager's browser
  const employeeName = decisionToken.employee_name;
  res.send(confirmationPage(employeeName, action));
});


// ── Homebase-UI swap approval → execute + notify (B7) ─────────────────────────
//
// The manager email button (handleSwapDecision) was the ONLY swap approval that
// executed the schedule change AND notified both employees; a manager approving a
// swap in the Homebase UI just flipped swap_requests.status and stopped (the
// confirmed gap). Homebase now POSTs { swap_request_id, decision } to
// /internal/notify-swap-decision, which calls this: reconstruct the context from
// the row (Homebase sends only the id), then run the SAME execute + confirm the
// email path does, reusing buildSwapDecisionMessages so both speak identically.
//
// GIVEAWAY / PICKUP ONLY — and as of L4 that is ENFORCED, not just asserted.
//
// swap_requests has NO target-shift columns (verified against the live DB
// 2026-07-31), so a two-way trade's return shift cannot be reconstructed from
// the row alone. Trades are supposed to go through the manager email button,
// whose decision token carries the target shift.
//
// That restriction was documented in THREE files (here, webhooks/internal.ts,
// and Homebase src/lib/swaps/decide.ts) and implemented in NONE. This function
// called the one-way executeScheduleSwap unconditionally, so a manager who
// approved a TRADE from the Homebase Swaps tab moved exactly one shift, silently
// dropped the return leg, wrote status='approved', and told the requester they
// were "off" when they had agreed to work the coworker's shift. Trades do reach
// this path: both the broadcast trade and the directed trade create
// status='pending_manager' rows with a receiver, and the tab renders live
// Approve/Deny buttons for any such row.
//
// The guard is now real: canExecuteFromRowAlone (lib/swap-kind.ts) reads the
// persisted kind marker and this function refuses anything it cannot PROVE is
// one-way — including legacy rows with no marker, because the pre-L4 directed
// note was byte-identical for giveaways and trades and guessing is exactly the
// mistake that caused the bug. Refusals are returned as a noop with a manager-
// readable reason, so Homebase can tell the manager to use the email button
// instead of claiming the schedule was updated.
type SwapNotifyResult = { status: 'approved' | 'denied' | 'noop'; notified: number; reason?: string };

async function loadSwapEmployee(companyId: string, employeeId: string) {
  const { data } = await supabase.from('employees')
    .select('id, name, contact_email, contact_phone')
    .eq('id', employeeId).eq('company_id', companyId).single();
  return data as { id: string; name: string; contact_email: string | null; contact_phone: string | null } | null;
}

// One employee-facing notice, routed like the email-button path: SMS when live +
// the person has a phone + the tenant has an Aegis number, else email. Returns
// whether a channel was used (email honesty flows through sendEmail's boolean).
async function sendSwapNotice(
  to: { id: string; contact_email: string | null; contact_phone: string | null },
  body: string, subject: string, aegisSmsChannel: string | null, companyId: string,
): Promise<boolean> {
  if (!env.EMAIL_ONLY && to.contact_phone && aegisSmsChannel) {
    const ok = await sendSms({ to: to.contact_phone, from: aegisSmsChannel, body, company_id: companyId, employee_id: to.id });
    if (ok) return true;
    // Consent-blocked or send failure → fall through to the email leg below.
  }
  if (to.contact_email) {
    return sendEmail({ to: to.contact_email, subject, text: body, company_id: companyId });
  }
  return false;
}

export async function sendSwapDecisionNotification(
  swapRequestId: string,
  decision: 'approved' | 'denied',
): Promise<SwapNotifyResult> {
  const { data: swapRow } = await supabase.from('swap_requests').select('*').eq('id', swapRequestId).maybeSingle();
  if (!swapRow) return { status: 'noop', notified: 0, reason: 'swap request not found' };
  const swap = swapRow as {
    id: string; company_id: string; status: string;
    requesting_employee_id: string; receiving_employee_id: string | null;
    shift_date: string; shift_name: string; role: string;
    // L4 — carries the persisted swap-kind marker (lib/swap-kind.ts).
    notes: string | null;
  };
  // Idempotent + safe: only a still-pending swap with a known coverer can execute.
  if (swap.status !== 'pending_manager') return { status: 'noop', notified: 0, reason: `swap already ${swap.status}` };
  if (!swap.receiving_employee_id) return { status: 'noop', notified: 0, reason: 'no coworker has taken this shift yet' };

  // L4 — FAIL CLOSED. Only execute what we can prove is a one-way reassignment.
  // Checked before ANY write and before either branch: a trade must not be
  // denied-and-notified from here either, because the email button carrying the
  // real shift details is the path that should decide it.
  // L4b — decide HOW to execute, not merely WHETHER. A trade with its return
  // shift on the row is now executed properly here; only rows that are genuinely
  // unexecutable (unmarked legacy, or a pre-023 trade whose return shift was
  // never stored) are refused, and the refusal names the path that does work.
  const plan = planRowExecution(swap);
  if (plan.mode === 'refuse') {
    console.warn(
      `[sendSwapDecisionNotification] REFUSING ${decision} for swap ${swap.id} — ` +
      `kind=${plan.kind ?? 'unknown'}. ${plan.reason}`
    );
    return { status: 'noop', notified: 0, reason: plan.reason };
  }

  const [requester, receiver] = await Promise.all([
    loadSwapEmployee(swap.company_id, swap.requesting_employee_id),
    loadSwapEmployee(swap.company_id, swap.receiving_employee_id),
  ]);
  if (!requester || !receiver) return { status: 'noop', notified: 0, reason: 'employee record missing' };

  // Tenant Aegis outbound SMS number (null → email fallback) — same lookup the
  // time-off decision path uses.
  const { data: channelRow } = await supabase.from('company_channels')
    .select('channel_value').eq('company_id', swap.company_id).eq('channel_type', 'sms').maybeSingle();
  const aegisSmsChannel = (channelRow as { channel_value: string } | null)?.channel_value ?? null;

  const dateLong = new Date(swap.shift_date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const dateShort = new Date(swap.shift_date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  if (decision === 'denied') {
    await supabase.from('swap_requests').update({ status: 'denied', decided_at: new Date().toISOString(), decided_by: null }).eq('id', swap.id);
    // L4b — a TRADE denial must not be described as a "coverage request", or
    // both people are told the wrong thing about what was refused.
    const msg = plan.mode === 'trade'
      ? `Your shift trade for the ${swap.shift_name} shift on ${dateShort} was not approved by your manager. ` +
        `Both of you stay on your original shifts. Please contact them if you have questions.`
      : `Your shift coverage request for the ${swap.shift_name} shift on ${dateShort} has been denied by your manager. Please contact them if you have questions.`;
    const subject = plan.mode === 'trade' ? 'Shift trade not approved' : 'Coverage denied';
    let notified = 0;
    if (await sendSwapNotice(requester, msg, subject, aegisSmsChannel, swap.company_id)) notified++;
    if (await sendSwapNotice(receiver, msg, subject, aegisSmsChannel, swap.company_id)) notified++;
    return { status: 'denied', notified };
  }

  // Approve. The schedule write is authoritative (D2): apply first, and only mark
  // approved + notify if it actually lands — otherwise leave it pending and say why.
  // L4 [SWAP-SCHEDULE-SELECT] — same `archived_at` guard as the email-button
  // path above; see the long note there for why.
  const { data: schedRow } = await supabase.from('schedules').select('id, data')
    .is('deleted_at', null).is('archived_at', null)
    .eq('company_id', swap.company_id).eq('status', 'published')
    .lte('week_start', swap.shift_date).gte('week_end', swap.shift_date)
    .order('generated_at', { ascending: false }).limit(1).maybeSingle();
  if (!schedRow) return { status: 'noop', notified: 0, reason: `no published schedule covers ${swap.shift_date}` };

  // L4b — TRADE vs ONE-WAY. This branch is the whole point of migration 023:
  // the return shift is now on the row, so the UI can run the SAME two-leg
  // executor the email button uses instead of silently running a giveaway.
  //
  // executeScheduleTrade requires EXACTLY ONE matching assignment per leg and
  // writes nothing otherwise (L4), so a trade that no longer matches the
  // schedule fails closed here exactly as it does on the email path.
  const applied = plan.mode === 'trade'
    ? await executeScheduleTrade(
        swap.company_id, (schedRow as { id: string }).id,
        { date: swap.shift_date, shift_name: swap.shift_name,
          employee_id: swap.requesting_employee_id, employee_name: requester.name },
        { date: plan.returnShift.date, shift_name: plan.returnShift.shift_name,
          employee_id: swap.receiving_employee_id, employee_name: receiver.name },
      )
    : await executeScheduleSwap(
        swap.company_id, (schedRow as { id: string }).id, swap.shift_date, swap.shift_name,
        swap.requesting_employee_id, swap.receiving_employee_id, receiver.name,
      );
  if (!applied.ok) return { status: 'noop', notified: 0, reason: applied.reason };

  await supabase.from('swap_requests').update({
    status: 'approved', schedule_id: applied.schedule_id, decided_at: new Date().toISOString(), decided_by: null,
  }).eq('id', swap.id);

  // BOTH PARTIES, with wording that matches what actually happened. Previously
  // this hard-coded `isTrade = false` and `target_shift_name: null`, so a trade
  // approved here told the requester they were "off" when they had agreed to
  // work the coworker's shift. buildSwapDecisionMessages is shared with the
  // email-button path, so the two now say the same thing (RULE 0b).
  const isTrade = plan.mode === 'trade';
  const targetDateLong = isTrade
    ? new Date(plan.returnShift.date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : dateLong;
  const { requesterMsg, receiverMsg } = buildSwapDecisionMessages(
    {
      shift_name: swap.shift_name,
      receiver_name: receiver.name,
      target_shift_name: isTrade ? plan.returnShift.shift_name : null,
    },
    isTrade, dateLong, targetDateLong,
  );
  const subject = isTrade ? 'Shift trade approved' : 'Coverage approved';
  let notified = 0;
  if (await sendSwapNotice(requester, requesterMsg, subject, aegisSmsChannel, swap.company_id)) notified++;
  if (await sendSwapNotice(receiver, receiverMsg, subject, aegisSmsChannel, swap.company_id)) notified++;

  // The MANAGER acted in the UI, so they already know the outcome — but the
  // activity feed is the shared record, and a trade must not be logged with
  // giveaway vocabulary.
  await logActivity({
    company_id: swap.company_id,
    action: 'swap_approved',
    entity_type: 'swap_request',
    entity_id: swap.id,
    summary: isTrade
      ? `Trade approved in Homebase: ${requester.name} takes ${plan.returnShift.shift_name} on ${plan.returnShift.date}, ${receiver.name} takes ${swap.shift_name} on ${swap.shift_date}.`
      : `Swap approved in Homebase: ${receiver.name} covers ${requester.name}'s ${swap.shift_name} shift on ${swap.shift_date}.`,
    metadata: {
      kind: plan.kind, requester_id: swap.requesting_employee_id,
      receiver_id: swap.receiving_employee_id, schedule_id: applied.schedule_id,
      notified, decided_via: 'homebase_ui',
    },
  });

  return { status: 'approved', notified };
}
