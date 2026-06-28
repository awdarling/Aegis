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
import { commitSwapPickup, proposeSwapTrade, resolveSwapProposal } from '../workflows/shift-swap';
import { supabase } from '../db/client';
import { sendEmail } from '../messaging/email';
import { brandedEmailShell, BRAND } from '../messaging/brand';

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
  // A date-limited override needs custom_end_date + a proposed list. A rotating
  // override carries its pattern in `rotation` instead, so neither is required.
  if (!isRotating) {
    if (typeof customEndDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(customEndDate)) {
      badRequest(res, 'custom_end_date is required (YYYY-MM-DD) unless a rotation is provided');
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
      custom_end_date: typeof customEndDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(customEndDate) ? customEndDate : null,
      rotation: isRotating ? (rotationRaw as unknown as RotationSpec) : null,
      current_availability: Array.isArray(body.current_availability)
        ? (body.current_availability as AvailabilitySlot[])
        : [],
      availability_raw: typeof body.availability_raw === 'string' ? body.availability_raw : '',
      decided_by: typeof body.decided_by === 'string' ? body.decided_by : undefined,
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
