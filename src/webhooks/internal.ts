import express, { Router, type Request, type Response } from 'express';
import { requireInternalAuth } from '../security/internal-auth';
import { sendDecisionNotification } from '../workflows/time-off';
import { distributeScheduleCore } from '../workflows/schedule-build';
import {
  applyAvailabilityDecision,
  applyCustomAvailabilityDecision,
  type AvailabilitySlot,
  type RotationSpec,
} from '../workflows/employee-onboarding';
import { supabase } from '../db/client';

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

// POST /internal/distribute-schedule
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
