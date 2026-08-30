import express, { Router, type Request, type Response } from 'express';
import { requireInternalAuth } from '../security/internal-auth';
import { sendDecisionNotification, recomputeTimeOffRecommendation, recheckAndReplyToManager } from '../workflows/time-off';
import { distributeScheduleCore, buildScheduleAndSave, notifyScheduleChangesCore } from '../workflows/schedule-build';
import {
  applyAvailabilityDecision,
  applyCustomAvailabilityDecision,
  type AvailabilitySlot,
  type RotationSpec,
} from '../workflows/employee-onboarding';
import { loadAvailabilityChangeRow } from '../workflows/availability-change-requests';
import { notifyDayClosureCore } from '../workflows/day-closure';
import { commitSwapPickup, proposeSwapTrade, resolveSwapProposal } from '../workflows/shift-swap';
import { sendSwapDecisionNotification } from './decision';
import { applyTimeOffDecision, describeDecisionResultForManager } from '../workflows/callout-decision';
import { managerStillActive } from '../security/manager-active';
import { getAegisSmsChannel, notifyEmployeeSmsFirst } from '../messaging/notify';
import type { CallOutShift } from '../workflows/time-off';
import { supabase } from '../db/client';
import { sendEmail } from '../messaging/email';
import { brandedEmailShell, BRAND } from '../messaging/brand';
import { formatClockRange } from '../lib/shift-hours';
import { firstName } from '../messaging/greeting';
import { logActivity } from '../logger/activity-log';

// Bearer-auth-gated endpoints called by Homebase /api/aegis-action after a
// manager clicks an aegis_action_tokens magic-link. Homebase consumes the
// token + records the manager decision, then POSTs here to trigger the
// employee-facing side effects (decision notification, schedule fan-out).
export const internalRouter = Router();

// Auth runs first so unauthenticated requests don't get their bodies parsed.
internalRouter.use(requireInternalAuth);
internalRouter.use(express.json());

function badRequest(res: Response, error: string): void {
  res.status(400).json({ ok: false, error });
}

function serverError(res: Response, error: string): void {
  res.status(500).json({ ok: false, error });
}

// POST /internal/notify-to-decision
internalRouter.post('/notify-to-decision', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const requestId = body.time_off_request_id;
  const decision = body.decision;

  if (typeof requestId !== 'string' || requestId.length === 0) {
    badRequest(res, 'time_off_request_id is required');
    return;
  }
  if (decision !== 'approved' && decision !== 'denied') {
    badRequest(res, 'decision must be "approved" or "denied"');
    return;
  }

  try {
    const result = await sendDecisionNotification(requestId, decision);
    res.json({ ok: true, channel: result.channel, sent_to: result.sent_to });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[internal] notify-to-decision failed:', msg);
    serverError(res, msg);
  }
});

// POST /internal/apply-time-off-decision
//
// N-3 (2026-08-28): THE server-side landing for a time-off / call-out decision
// made through a Homebase aegis_action_tokens magic link (the confirm page).
// Homebase consumes the token and POSTs here; this endpoint:
//   1. refuses a revoked manager (S-3 actor half — the OLD Homebase magic-link
//      path never checked this; now every emailed decision door does),
//   2. rebuilds the decision context from the live rows (never trusting the
//      payload for anything the database knows better), and
//   3. hands the decision to applyTimeOffDecision — the ONE core shared with
//      the manager's texted replies (F13). Whichever door decides first, the
//      other reports "already decided" truthfully.
// The response carries a ready-made manager-facing message (one voice —
// describeDecisionResultForManager) so Homebase renders exactly what the text
// door would have said.
//
// P2 (2026-08-30, DRIFT §P2): the in-tab Homebase button now lands here too,
// via 'source: "in_tab"'. Two things a browser click can't supply that an
// emailed link's token payload used to carry:
//   - call_out — resolved server-side from the same to_thread:<id> side row
//     already being read for threading, when the caller doesn't send one.
//     The browser should not have to know whether a request is a call-out.
//   - manager_avatar_url — looked up alongside manager_name when missing.
// 'source' also picks the activity-log voice ("the Time Off tab" vs. "email
// link"); the magic-link dispatcher never sends it, so its behavior — and
// every existing caller's — is unchanged.
internalRouter.post('/apply-time-off-decision', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const requestId = body.time_off_request_id;
  const action = body.action;
  const companyId = body.company_id;
  const managerUserId = typeof body.manager_user_id === 'string' && body.manager_user_id.length > 0 ? body.manager_user_id : null;
  const via: 'email_link' | 'in_tab' = body.source === 'in_tab' ? 'in_tab' : 'email_link';

  if (typeof requestId !== 'string' || requestId.length === 0) {
    badRequest(res, 'time_off_request_id is required');
    return;
  }
  if (typeof companyId !== 'string' || companyId.length === 0) {
    badRequest(res, 'company_id is required');
    return;
  }
  if (action !== 'approve' && action !== 'deny' && action !== 'approve_and_cover') {
    badRequest(res, 'action must be "approve", "deny" or "approve_and_cover"');
    return;
  }

  try {
    // S-3 (actor half): the link was minted for a specific manager; if that
    // login has been revoked since, the link is dead regardless of expiry.
    if (!(await managerStillActive(managerUserId))) {
      console.log('[internal] apply-time-off-decision refused — manager login revoked or unknown', { managerUserId, requestId });
      res.status(403).json({
        ok: false,
        outcome: 'revoked',
        message: 'This link belongs to a login that no longer has manager access. Please ask a current manager to review the request in Homebase.',
      });
      return;
    }

    // Rebuild the decision context from the live rows. The token payload only
    // supplies what the database cannot know: the call-out snapshot and the
    // origin-thread metadata (also recoverable from the to_thread side row).
    const { data: torData } = await supabase
      .from('time_off_requests')
      .select('id, company_id, employee_id')
      .eq('id', requestId)
      .eq('company_id', companyId)
      .maybeSingle();
    const tor = torData as { id: string; company_id: string; employee_id: string } | null;
    if (!tor) {
      res.json({ ok: true, outcome: 'not_found', message: "I couldn't find that request anymore — check the Time Off tab in Homebase for where it stands." });
      return;
    }

    const { data: empData } = await supabase
      .from('employees')
      .select('id, name, contact_email, contact_phone')
      .eq('id', tor.employee_id)
      .eq('company_id', companyId)
      .maybeSingle();
    const employee = empData as { id: string; name: string; contact_email: string | null; contact_phone: string | null } | null;

    // Origin channel + email-thread metadata from the to_thread side row
    // (written at submission for both channels) — same read
    // sendDecisionNotification has always used.
    let originChannel: 'sms' | 'email' | null = null;
    let threadId: string | null = typeof body.thread_id === 'string' ? body.thread_id : null;
    let rawSubject: string | null = typeof body.raw_subject === 'string' ? body.raw_subject : null;
    const { data: metaRow } = await supabase
      .from('aegis_memory')
      .select('content')
      .eq('source', `to_thread:${requestId}`)
      .maybeSingle();
    // P2: resolve call_out from the body first (magic-link payload); when the
    // caller doesn't send one (the in-tab button), fall back to the SAME
    // to_thread:<id> row's own call_out field — written for both channels at
    // submission time (workflows/time-off.ts), so it's already sitting in
    // `meta` below whenever it exists. No caller-side lookup required.
    let metaCallOut: CallOutShift[] | null = null;
    if (metaRow) {
      try {
        const meta = JSON.parse((metaRow as { content: string }).content) as { channel?: 'sms' | 'email' | null; thread_id?: string | null; raw_subject?: string | null; call_out?: CallOutShift[] | null };
        originChannel = meta.channel ?? null;
        threadId = threadId ?? meta.thread_id ?? null;
        rawSubject = rawSubject ?? meta.raw_subject ?? null;
        metaCallOut = Array.isArray(meta.call_out) && meta.call_out.length > 0 ? meta.call_out : null;
      } catch { /* corrupted side row — proceed without threading */ }
    }

    let managerName: string | null = typeof body.manager_name === 'string' ? body.manager_name : null;
    let managerAvatarUrl: string | null = typeof body.manager_avatar_url === 'string' ? body.manager_avatar_url : null;
    if ((!managerName || !managerAvatarUrl) && managerUserId) {
      const { data: mgrRow } = await supabase.from('users').select('name, avatar_url').eq('id', managerUserId).maybeSingle();
      const mgr = mgrRow as { name: string | null; avatar_url: string | null } | null;
      managerName = managerName ?? mgr?.name ?? null;
      managerAvatarUrl = managerAvatarUrl ?? mgr?.avatar_url ?? null;
    }

    const bodyCallOut = Array.isArray(body.call_out) && body.call_out.length > 0 ? (body.call_out as CallOutShift[]) : null;
    const callOut = bodyCallOut ?? metaCallOut;
    const smsChannel = await getAegisSmsChannel(companyId);
    const phone = employee?.contact_phone ?? null;
    const email = employee?.contact_email ?? null;
    const channel: 'sms' | 'email' = originChannel ?? (phone ? 'sms' : 'email');

    const ctx = {
      request_id: requestId,
      company_id: companyId,
      employee_id: tor.employee_id,
      employee_name: employee?.name ?? 'the employee',
      employee_channel: channel,
      employee_contact: (channel === 'sms' ? phone : email) ?? email ?? phone ?? '',
      aegis_sms_channel: smsChannel,
      thread_id: threadId,
      raw_subject: rawSubject,
      manager_user_id: managerUserId,
      manager_name: managerName,
      manager_avatar_url: managerAvatarUrl,
      call_out: callOut,
    };

    const result = await applyTimeOffDecision(ctx, action, via);
    res.json({
      ok: true,
      outcome: result.outcome,
      ...(result.outcome === 'already_decided' ? { status: result.status } : {}),
      message: describeDecisionResultForManager(ctx, action, result),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[internal] apply-time-off-decision failed:', msg);
    serverError(res, msg);
  }
});

// POST /internal/notify-assignment
//
// S-4 (2026-08-28): the shift-assignment notification, moved behind Aegis's
// consent gate. Homebase's /api/notify-assignment used to send the SMS itself
// through its own Telnyx client — the ONE door in the whole system that could
// text an employee without asking "may we text this person?" (dormant, held
// closed only by EMAIL_ONLY on Vercel, but compliance-relevant). Homebase is
// now a thin proxy to this endpoint, and the send goes through
// notifyEmployeeSmsFirst → sendSms, where the N3 consent gate lives — so after
// this, exactly ONE function in the system decides whether an employee may be
// texted (Rule 0b). A non-consented employee falls back to email (legal), and
// an unreachable one is reported honestly.
//
// The employee lookup is BOUND to company_id: a caller naming another
// company's employee gets a 404 and nothing is sent.
internalRouter.post('/notify-assignment', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const companyId = body.company_id;
  const employeeId = body.employee_id;
  const shiftName = body.shift_name;
  const role = body.role;
  const date = body.date;
  const startTime = typeof body.start_time === 'string' ? body.start_time : null;
  const endTime = typeof body.end_time === 'string' ? body.end_time : null;
  const approvedBy = typeof body.approved_by === 'string' ? body.approved_by : null;
  const approvedByEmail = typeof body.approved_by_email === 'string' ? body.approved_by_email : null;

  if (typeof companyId !== 'string' || companyId.length === 0) { badRequest(res, 'company_id is required'); return; }
  if (typeof employeeId !== 'string' || employeeId.length === 0) { badRequest(res, 'employee_id is required'); return; }
  if (typeof shiftName !== 'string' || shiftName.length === 0) { badRequest(res, 'shift_name is required'); return; }
  if (typeof role !== 'string' || role.length === 0) { badRequest(res, 'role is required'); return; }
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { badRequest(res, 'date must be YYYY-MM-DD'); return; }

  try {
    // Company-bound lookup — refuse a foreign employee_id.
    const { data: empData } = await supabase
      .from('employees')
      .select('id, name, contact_phone, contact_email')
      .eq('id', employeeId)
      .eq('company_id', companyId)
      .maybeSingle();
    const employee = empData as { id: string; name: string; contact_phone: string | null; contact_email: string | null } | null;
    if (!employee) {
      res.status(404).json({ ok: false, error: 'employee not found for this company' });
      return;
    }

    // YYYY-MM-DD parsed component-wise (never new Date('YYYY-MM-DD'), which
    // shifts the day at UTC midnight), and times through the one employee-
    // facing clock formatter — never a raw HH:MM:SS interpolation (§N2).
    const [y, mo, da] = date.split('-').map(Number);
    const dateStr = new Date(y, mo - 1, da).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
    });
    const hours = startTime && endTime ? ` (${role}, ${formatClockRange(startTime, endTime)})` : ` (${role})`;
    const messageBody =
      `Hi ${firstName(employee.name)} — you've been added to the ${shiftName} shift${hours} on ${dateStr} by your manager. See you then!`;

    const smsChannel = await getAegisSmsChannel(companyId);
    const channel = await notifyEmployeeSmsFirst({
      company_id: companyId,
      smsChannel,
      phone: employee.contact_phone,
      email: employee.contact_email,
      body: messageBody,
      subject: `You've been added to the ${shiftName} shift on ${dateStr}`,
      employee_id: employee.id,
    });

    const summary = channel === 'none'
      ? `Assignment notification for ${employee.name} could not be delivered — no reachable channel (${shiftName}, ${date})`
      : `Assignment notification sent to ${employee.name} by ${channel}: ${shiftName} (${role}) on ${date}`;
    await logActivity({
      company_id: companyId,
      actor: 'manager',
      action: channel === 'none' ? 'assignment_notification_failed' : 'assignment_notification_sent',
      entity_type: 'employee',
      entity_id: employee.id,
      summary,
      metadata: {
        shift_name: shiftName, role, date, channel,
        approved_by: approvedBy, approved_by_email: approvedByEmail,
        via: 'internal_notify_assignment',
      },
    });

    res.json({
      ok: channel !== 'none',
      channel,
      message: channel === 'sms'
        ? `${firstName(employee.name)} has been texted about the shift.`
        : channel === 'email'
          ? `${firstName(employee.name)} couldn't be texted (no number or no text permission), so they've been emailed instead.`
          : `${employee.name} has no phone or email on file — please let them know directly.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[internal] notify-assignment failed:', msg);
    serverError(res, msg);
  }
});

// POST /internal/notify-swap-decision
// Homebase calls this after a manager approves/denies a swap in the UI (it only
// updates swap_requests.status; Aegis executes the schedule change + notifies).
// Giveaway/pickup only — and as of L4 that is ENFORCED in
// sendSwapDecisionNotification via canExecuteFromRowAlone, not merely asserted
// in a comment (it was asserted here, in decision.ts, and in Homebase
// src/lib/swaps/decide.ts, and implemented in none of them). A trade — or any
// row whose kind can't be proven — comes back as status:'noop' with a
// manager-readable reason, which Homebase surfaces instead of claiming the
// schedule was updated.
internalRouter.post('/notify-swap-decision', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const swapRequestId = body.swap_request_id;
  const decision = body.decision;

  if (typeof swapRequestId !== 'string' || swapRequestId.length === 0) {
    badRequest(res, 'swap_request_id is required');
    return;
  }
  if (decision !== 'approved' && decision !== 'denied') {
    badRequest(res, 'decision must be "approved" or "denied"');
    return;
  }

  try {
    const result = await sendSwapDecisionNotification(swapRequestId, decision);
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[internal] notify-swap-decision failed:', msg);
    serverError(res, msg);
  }
});

// POST /internal/notify-access-removed
// Called by Homebase when a manager sets an employee's Aegis access to
// "blocked". Aegis already refuses to act on a blocked sender (sender
// verification returns null); this sends the person a one-time, friendly
// heads-up so they aren't left wondering why Aegis went quiet. Email-first;
// if there's no email on file we no-op (SMS notice is a later add).
internalRouter.post('/notify-access-removed', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const companyId = body.company_id;
  const employeeId = body.employee_id;
  if (typeof companyId !== 'string' || companyId.length === 0) {
    badRequest(res, 'company_id is required');
    return;
  }
  if (typeof employeeId !== 'string' || employeeId.length === 0) {
    badRequest(res, 'employee_id is required');
    return;
  }

  try {
    const { data: empRow } = await supabase
      .from('employees')
      .select('name, contact_email')
      .eq('id', employeeId)
      .eq('company_id', companyId)
      .maybeSingle();
    const emp = empRow as { name: string | null; contact_email: string | null } | null;
    if (!emp) {
      badRequest(res, 'employee not found');
      return;
    }

    const first = (emp.name ?? '').trim().split(/\s+/)[0] || 'there';
    const text =
      `Hi ${first} — a quick heads-up: your access to Aegis has been turned off. ` +
      `If you think that's a mistake, just reach out to your manager and they can get it sorted out.`;

    if (!emp.contact_email) {
      res.json({ ok: true, channel: null });
      return;
    }

    const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = brandedEmailShell({
      bodyHtml: `<p style="margin:0;font-size:16px;color:${BRAND.textPrimary};line-height:1.65;">${safe}</p>`,
      preheader: 'Your Aegis access has changed',
    });

    await sendEmail({
      to: emp.contact_email,
      subject: 'Your Aegis access has changed',
      text,
      html,
      company_id: companyId,
    });
    res.json({ ok: true, channel: 'email' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[internal] notify-access-removed failed:', msg);
    serverError(res, msg);
  }
});

// POST /internal/recompute-to-recommendation  (TO-RERUN-1)
// Re-runs the coverage simulation + AI recommendation for an existing time-off
// request against CURRENT approvals and persists the refreshed recommendation.
// Called by the Homebase "Re-run check" button, the email-card re-check link
// (via the aegis-action dispatcher), and the conversational re-run command.
// Read-only w.r.t. the decision — only rewrites aegis_recommendation/reasoning.
internalRouter.post('/recompute-to-recommendation', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const requestId = body.time_off_request_id;

  if (typeof requestId !== 'string' || requestId.length === 0) {
    badRequest(res, 'time_off_request_id is required');
    return;
  }

  try {
    const result = await recomputeTimeOffRecommendation(requestId);
    if (result.status === 'not_found') {
      res.status(404).json({ ok: false, error: 'time_off_request not found' });
      return;
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[internal] recompute-to-recommendation failed:', msg);
    serverError(res, msg);
  }
});

// POST /internal/recheck-to-reply  (TO-RERUN-1, email magic-link path)
// Re-runs the recommendation AND replies to the manager IN THE SAME EMAIL THREAD
// as the original action-card email, with a refreshed card. Used when a manager
// clicks "Re-run check" in their inbox, so the conversation stays in one chain.
internalRouter.post('/recheck-to-reply', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const requestId = body.time_off_request_id;
  const managerEmail = body.manager_email;

  if (typeof requestId !== 'string' || requestId.length === 0) {
    badRequest(res, 'time_off_request_id is required');
    return;
  }
  if (typeof managerEmail !== 'string' || managerEmail.length === 0) {
    badRequest(res, 'manager_email is required');
    return;
  }
  const managerUserId = typeof body.manager_user_id === 'string' ? body.manager_user_id : undefined;

  try {
    // Respond FAST so the magic-link landing page never hangs (the recompute runs
    // the AI + sends an email, ~several seconds — long enough that managers were
    // re-clicking into "link already used"). Only the cheap status read is
    // synchronous; the recompute + threaded reply run in the background.
    const { data: row } = await supabase
      .from('time_off_requests').select('status').eq('id', requestId).maybeSingle();
    if (!row) {
      res.status(404).json({ ok: false, error: 'time_off_request not found' });
      return;
    }
    if ((row as { status: string }).status !== 'pending') {
      res.json({ ok: true, status: 'already_decided' });
      return;
    }

    // Pending → kick off the recompute + threaded reply, but don't await it.
    void recheckAndReplyToManager({ requestId, managerEmail, managerUserId }).catch((err) => {
      console.error('[internal] recheck-to-reply background failed:', err instanceof Error ? err.message : String(err));
    });
    res.json({ ok: true, status: 'processing' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[internal] recheck-to-reply failed:', msg);
    serverError(res, msg);
  }
});

// POST /internal/apply-availability-decision
// Called by Homebase /api/aegis-action after a manager clicks Approve/Deny on
// the availability email. The token payload (the approval snapshot) is forwarded
// here; we apply the SAME effect the reply-"YES" path applies (DB write +
// employee notification) via the shared applyAvailabilityDecision.
internalRouter.post('/apply-availability-decision', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const decision = body.decision;
  if (decision !== 'approved' && decision !== 'denied') {
    badRequest(res, 'decision must be "approved" or "denied"');
    return;
  }

  const companyId = body.company_id;
  const employeeId = body.employee_id;
  const employeeSender = body.employee_sender;
  const employeeChannel = body.employee_channel;
  const proposed = body.proposed_availability;

  if (typeof companyId !== 'string' || companyId.length === 0) {
    badRequest(res, 'company_id is required');
    return;
  }
  if (typeof employeeId !== 'string' || employeeId.length === 0) {
    badRequest(res, 'employee_id is required');
    return;
  }
  if (!Array.isArray(proposed)) {
    badRequest(res, 'proposed_availability must be an array');
    return;
  }
  if (typeof employeeSender !== 'string' || employeeSender.length === 0) {
    badRequest(res, 'employee_sender is required to notify the employee');
    return;
  }
  if (employeeChannel !== 'sms' && employeeChannel !== 'email') {
    badRequest(res, 'employee_channel must be "sms" or "email"');
    return;
  }

  try {
    await applyAvailabilityDecision({
      decision,
      company_id: companyId,
      employee_id: employeeId,
      employee_name: typeof body.employee_name === 'string' ? body.employee_name : 'there',
      current_availability: Array.isArray(body.current_availability)
        ? (body.current_availability as AvailabilitySlot[])
        : [],
      proposed_availability: proposed as AvailabilitySlot[],
      availability_raw: typeof body.availability_raw === 'string' ? body.availability_raw : '',
      decided_by: typeof body.decided_by === 'string' ? body.decided_by : undefined,
      decided_by_user_id: typeof body.decided_by_user_id === 'string' ? body.decided_by_user_id : null,
      change_request_id: typeof body.change_request_id === 'string' ? body.change_request_id : undefined,
      employee_sender: employeeSender,
      employee_recipient: typeof body.employee_recipient === 'string' ? body.employee_recipient : '',
      employee_channel: employeeChannel,
      thread_id: typeof body.thread_id === 'string' ? body.thread_id : null,
      raw_subject: typeof body.raw_subject === 'string' ? body.raw_subject : null,
    });
    res.json({ ok: true, decision });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[internal] apply-availability-decision failed:', msg);
    serverError(res, msg);
  }
});

// POST /internal/apply-custom-availability-decision
// Sibling of apply-availability-decision for the TEMPORARY (date-limited) custom
// override. Homebase forwards the consumed token payload here; we apply the SAME
// effect the reply-"YES" path applies (write the date-limited custom_availability
// override + notify the employee) via the shared applyCustomAvailabilityDecision.
internalRouter.post('/apply-custom-availability-decision', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const decision = body.decision;
  if (decision !== 'approved' && decision !== 'denied') {
    badRequest(res, 'decision must be "approved" or "denied"');
    return;
  }

  const companyId = body.company_id;
  const employeeId = body.employee_id;
  const employeeSender = body.employee_sender;
  const employeeChannel = body.employee_channel;
  const proposed = body.proposed_availability;
  const customEndDate = body.custom_end_date;
  const effectiveStartDate = body.effective_start_date;
  const hasValidStart = typeof effectiveStartDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(effectiveStartDate);
  const rotationRaw = body.rotation && typeof body.rotation === 'object'
    ? (body.rotation as { cycle_weeks?: unknown; cycle_start_date?: unknown; weeks?: unknown })
    : null;
  const isRotating = !!rotationRaw
    && typeof rotationRaw.cycle_weeks === 'number'
    && typeof rotationRaw.cycle_start_date === 'string'
    && Array.isArray(rotationRaw.weeks);

  if (typeof companyId !== 'string' || companyId.length === 0) {
    badRequest(res, 'company_id is required');
    return;
  }
  if (typeof employeeId !== 'string' || employeeId.length === 0) {
    badRequest(res, 'employee_id is required');
    return;
  }
  // A date-limited override needs a proposed list plus at least one date bound:
  // custom_end_date (temporary "until X") and/or effective_start_date (future-start
  // "from X"). A rotating override carries its pattern in `rotation` instead, so
  // neither is required for it.
  const hasValidEnd = typeof customEndDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(customEndDate);
  if (!isRotating) {
    if (!hasValidEnd && !hasValidStart) {
      badRequest(res, 'custom_end_date or effective_start_date is required (YYYY-MM-DD) unless a rotation is provided');
      return;
    }
    if (!Array.isArray(proposed)) {
      badRequest(res, 'proposed_availability must be an array');
      return;
    }
  }
  if (typeof employeeSender !== 'string' || employeeSender.length === 0) {
    badRequest(res, 'employee_sender is required to notify the employee');
    return;
  }
  if (employeeChannel !== 'sms' && employeeChannel !== 'email') {
    badRequest(res, 'employee_channel must be "sms" or "email"');
    return;
  }

  try {
    await applyCustomAvailabilityDecision({
      decision,
      company_id: companyId,
      employee_id: employeeId,
      employee_name: typeof body.employee_name === 'string' ? body.employee_name : 'there',
      proposed_availability: Array.isArray(proposed) ? (proposed as AvailabilitySlot[]) : [],
      custom_end_date: hasValidEnd ? (customEndDate as string) : null,
      effective_start_date: hasValidStart ? (effectiveStartDate as string) : null,
      rotation: isRotating ? (rotationRaw as unknown as RotationSpec) : null,
      current_availability: Array.isArray(body.current_availability)
        ? (body.current_availability as AvailabilitySlot[])
        : [],
      availability_raw: typeof body.availability_raw === 'string' ? body.availability_raw : '',
      decided_by: typeof body.decided_by === 'string' ? body.decided_by : undefined,
      decided_by_user_id: typeof body.decided_by_user_id === 'string' ? body.decided_by_user_id : null,
      change_request_id: typeof body.change_request_id === 'string' ? body.change_request_id : undefined,
      employee_sender: employeeSender,
      employee_recipient: typeof body.employee_recipient === 'string' ? body.employee_recipient : '',
      employee_channel: employeeChannel,
      thread_id: typeof body.thread_id === 'string' ? body.thread_id : null,
      raw_subject: typeof body.raw_subject === 'string' ? body.raw_subject : null,
    });
    res.json({ ok: true, decision });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[internal] apply-custom-availability-decision failed:', msg);
    serverError(res, msg);
  }
});

// POST /internal/decide-availability-change
// Homebase Availability tab calls this after a manager clicks Approve/Deny on a
// pending availability_change_requests row. Aegis is authoritative (like swaps): it
// applies the DB effect + notifies via the SAME shared apply functions the reply-YES
// and email-button paths use, and the guarded flip inside them is the idempotency guard.
internalRouter.post('/decide-availability-change', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const id = body.availability_change_request_id;
  const decision = body.decision;
  const decidedByUserId = typeof body.decided_by_user_id === 'string' ? body.decided_by_user_id : null;
  const decidedByName = typeof body.decided_by_name === 'string' ? body.decided_by_name : undefined;

  if (typeof id !== 'string' || id.length === 0) {
    badRequest(res, 'availability_change_request_id is required');
    return;
  }
  if (decision !== 'approved' && decision !== 'denied') {
    badRequest(res, 'decision must be "approved" or "denied"');
    return;
  }

  try {
    const row = await loadAvailabilityChangeRow(id);
    if (!row) {
      res.status(404).json({ ok: false, error: 'availability_change_request not found' });
      return;
    }
    if (row.status !== 'pending') {
      res.json({ ok: true, status: 'noop', reason: `already ${row.status}` });
      return;
    }

    const snap = row.proposed_change;
    const base = {
      company_id: snap.company_id,
      employee_id: snap.employee_id,
      employee_name: snap.employee_name,
      current_availability: snap.current_availability ?? [],
      proposed_availability: snap.proposed_availability ?? [],
      availability_raw: snap.availability_raw ?? '',
      decided_by: decidedByName,
      decided_by_user_id: decidedByUserId,
      change_request_id: row.id,
      employee_sender: snap.employee_sender,
      employee_recipient: snap.employee_recipient,
      employee_channel: snap.employee_channel,
      thread_id: snap.thread_id ?? null,
      raw_subject: snap.raw_subject ?? null,
    };

    const outcome =
      row.change_kind === 'permanent'
        ? await applyAvailabilityDecision({ ...base, decision })
        : await applyCustomAvailabilityDecision({
            ...base,
            custom_end_date: snap.custom_end_date ?? null,
            effective_start_date: snap.effective_start_date ?? null,
            rotation: snap.rotation ?? null,
            decision,
          });

    if (outcome.status === 'already_decided') {
      res.json({ ok: true, status: 'noop', reason: 'already decided' });
      return;
    }
    res.json({ ok: true, status: decision });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[internal] decide-availability-change failed:', msg);
    serverError(res, msg);
  }
});

// POST /internal/swap-pickup-commit
// Called by Homebase /api/aegis-action when a broadcast candidate clicks
// "I'll pick it up" and confirms. Locks the broadcast (first-commit-wins),
// creates the one-way pickup swap_request (pending manager), notifies the
// requester, and emails the manager the approve/deny. Returns { ok, message }
// which the landing page shows the candidate.
internalRouter.post('/swap-pickup-commit', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const companyId = body.company_id;
  const requesterId = body.requester_id;
  const receiverId = body.receiver_id;

  if (typeof companyId !== 'string' || companyId.length === 0) {
    badRequest(res, 'company_id is required');
    return;
  }
  if (typeof requesterId !== 'string' || requesterId.length === 0) {
    badRequest(res, 'requester_id is required');
    return;
  }
  if (typeof receiverId !== 'string' || receiverId.length === 0) {
    badRequest(res, 'receiver_id is required');
    return;
  }

  try {
    const result = await commitSwapPickup({
      company_id: companyId,
      requester_id: requesterId,
      receiver_id: receiverId,
    });
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[internal] swap-pickup-commit failed:', msg);
    serverError(res, msg);
  }
});

// POST /internal/swap-propose
// Called by Homebase when a broadcast candidate selects which of their own shifts
// to trade on the swap-picker page. Locks the broadcast, records the proposal, and
// returns { ok, message }. Stage 4 then asks the requester to agree.
internalRouter.post('/swap-propose', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const companyId = body.company_id;
  const requesterId = body.requester_id;
  const receiverId = body.receiver_id;
  const sel = body.selected_shift && typeof body.selected_shift === 'object'
    ? (body.selected_shift as Record<string, unknown>)
    : null;

  if (typeof companyId !== 'string' || companyId.length === 0) { badRequest(res, 'company_id is required'); return; }
  if (typeof requesterId !== 'string' || requesterId.length === 0) { badRequest(res, 'requester_id is required'); return; }
  if (typeof receiverId !== 'string' || receiverId.length === 0) { badRequest(res, 'receiver_id is required'); return; }
  if (!sel || typeof sel.date !== 'string' || typeof sel.shift_name !== 'string' || typeof sel.role !== 'string'
    || typeof sel.start_time !== 'string' || typeof sel.end_time !== 'string') {
    badRequest(res, 'selected_shift {date, shift_name, role, start_time, end_time} is required');
    return;
  }

  try {
    const result = await proposeSwapTrade({
      company_id: companyId,
      requester_id: requesterId,
      receiver_id: receiverId,
      selected_shift: {
        date: sel.date as string,
        shift_name: sel.shift_name as string,
        role: sel.role as string,
        start_time: sel.start_time as string,
        end_time: sel.end_time as string,
      },
    });
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[internal] swap-propose failed:', msg);
    serverError(res, msg);
  }
});

// POST /internal/swap-proposal-decision
// Called by Homebase when the REQUESTER clicks Agree/Decline on a proposed trade.
// agree → two-way swap_request + manager approve/deny email; decline → reopen the
// broadcast to remaining candidates. Returns { ok, message } for the page.
internalRouter.post('/swap-proposal-decision', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const companyId = body.company_id;
  const requesterId = body.requester_id;
  const decision = body.decision;

  if (typeof companyId !== 'string' || companyId.length === 0) { badRequest(res, 'company_id is required'); return; }
  if (typeof requesterId !== 'string' || requesterId.length === 0) { badRequest(res, 'requester_id is required'); return; }
  if (decision !== 'agree' && decision !== 'decline') { badRequest(res, 'decision must be "agree" or "decline"'); return; }

  try {
    const result = await resolveSwapProposal({
      company_id: companyId,
      requester_id: requesterId,
      decision,
    });
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[internal] swap-proposal-decision failed:', msg);
    serverError(res, msg);
  }
});

// POST /internal/distribute-schedule
// POST /internal/build-schedule
// Homebase "Build" button (item 9). Builds + saves a fresh draft schedule for a
// company + target week, reusing the same engine core as the email handler.
// Body: { company_id: string, target_week?: 'this' | 'next', veteran_preference?: string }
internalRouter.post('/build-schedule', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const companyId = body.company_id;
  if (typeof companyId !== 'string' || companyId.length === 0) {
    badRequest(res, 'company_id is required');
    return;
  }

  // Only forward the fields the build core understands.
  const extracted: Record<string, unknown> = {};
  if (body.target_week === 'this' || body.target_week === 'next') {
    extracted['target_week'] = body.target_week;
  }
  if (typeof body.veteran_preference === 'string') {
    extracted['veteran_preference'] = body.veteran_preference;
  }
  if (Array.isArray(body.veteran_only_dates)) {
    extracted['veteran_only_dates'] = body.veteran_only_dates;
  }

  try {
    const outcome = await buildScheduleAndSave(companyId, extracted);
    if (!outcome.ok) {
      // no_shift_types → 422 (caller misconfigured); save_failed → 500.
      const status = outcome.reason === 'no_shift_types' ? 422 : 500;
      res.status(status).json({
        ok: false,
        reason: outcome.reason,
        week_start: outcome.weekStart,
        week_end: outcome.weekEnd,
        error: outcome.reason === 'save_failed' ? outcome.error : undefined,
      });
      return;
    }
    res.json({
      ok: true,
      schedule_id: outcome.scheduleId,
      week_start: outcome.weekStart,
      week_end: outcome.weekEnd,
      total_filled: outcome.totalFilled,
      total_required: outcome.totalRequired,
      gaps: outcome.gaps.length,
      flagged_issues: outcome.flagged_issues.length,
      estimated_wages: outcome.wages.total_estimated,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[internal] build-schedule failed:', msg);
    serverError(res, msg);
  }
});

// POST /internal/notify-schedule-changes
// Republish notify (item 12). Emails/texts ONLY the employees whose shifts
// changed between the previously-published schedule and the newly-published one.
// The atomic publish swap (Homebase route) must have already run; this only
// sends the change notifications + sets distributed_at on the new row.
// Body: { new_schedule_id: string, previous_schedule_id: string }
internalRouter.post('/notify-schedule-changes', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const newScheduleId = body.new_schedule_id;
  const oldScheduleId = body.previous_schedule_id;
  if (typeof newScheduleId !== 'string' || newScheduleId.length === 0) {
    badRequest(res, 'new_schedule_id is required');
    return;
  }
  if (typeof oldScheduleId !== 'string' || oldScheduleId.length === 0) {
    badRequest(res, 'previous_schedule_id is required');
    return;
  }

  try {
    // Resolve company_id from the new schedule row.
    const { data: schedRow, error: schedErr } = await supabase
      .from('schedules')
      .select('company_id')
      .eq('id', newScheduleId)
      .single();
    if (schedErr || !schedRow) {
      serverError(res, `schedule ${newScheduleId} not found: ${schedErr?.message ?? 'no row'}`);
      return;
    }
    const companyId = (schedRow as { company_id: string }).company_id;

    const result = await notifyScheduleChangesCore(newScheduleId, oldScheduleId, companyId);
    res.json({
      ok: true,
      notified: result.notified,
      emailed: result.emailed,
      texted: result.texted,
      changed_employees: result.changed_employees,
      no_contact: result.no_contact,
      errors: result.errors,
      week_label: result.week_label,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[internal] notify-schedule-changes failed:', msg);
    serverError(res, msg);
  }
});

internalRouter.post('/distribute-schedule', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const scheduleId = body.schedule_id;
  // Optional re-send override (default false). The future Homebase "Distribute"
  // button passes force=true to deliberately re-distribute an already-sent week.
  const force = body.force === true;

  if (typeof scheduleId !== 'string' || scheduleId.length === 0) {
    badRequest(res, 'schedule_id is required');
    return;
  }

  try {
    // Resolve company_id by loading the schedule row first.
    const { data: schedRow, error: schedErr } = await supabase
      .from('schedules')
      .select('company_id')
      .eq('id', scheduleId)
      .is('deleted_at', null)
      .single();
    if (schedErr || !schedRow) {
      serverError(res, `schedule ${scheduleId} not found: ${schedErr?.message ?? 'no row'}`);
      return;
    }
    const companyId = (schedRow as { company_id: string }).company_id;

    const result = await distributeScheduleCore(scheduleId, companyId, force);
    res.json({
      ok: true,
      sent: result.sent,
      total_employees: result.total_employees,
      errors: result.errors,
      already_distributed: result.already_distributed ?? false,
      distributed_at: result.distributed_at ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[internal] distribute-schedule failed:', msg);
    serverError(res, msg);
  }
});

// POST /internal/notify-day-closure
// Homebase "Close day" (Batch-1 F8). Aegis owns the roster: given the schedule +
// the closed date, it notifies EVERY scheduled employee SMS-first + email
// fallback. Replaces the old approach where Homebase impersonated the manager
// over the public /webhooks/sms|email and relied on the classifier to deliver —
// which notified nobody. Body: { company_id, schedule_id, date }
internalRouter.post('/notify-day-closure', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const companyId = body.company_id;
  const scheduleId = body.schedule_id;
  const date = body.date;
  if (typeof companyId !== 'string' || companyId.length === 0) { badRequest(res, 'company_id is required'); return; }
  if (typeof scheduleId !== 'string' || scheduleId.length === 0) { badRequest(res, 'schedule_id is required'); return; }
  if (typeof date !== 'string' || date.length === 0) { badRequest(res, 'date is required'); return; }

  try {
    const result = await notifyDayClosureCore(companyId, scheduleId, date);
    res.json({
      ok: true,
      notified: result.notified,
      total_scheduled: result.total_scheduled,
      texted: result.texted,
      emailed: result.emailed,
      failures: result.failures,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[internal] notify-day-closure failed:', msg);
    serverError(res, msg);
  }
});
