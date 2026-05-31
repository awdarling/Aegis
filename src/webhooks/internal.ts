import express, { Router, type Request, type Response } from 'express';
import { requireInternalAuth } from '../security/internal-auth';
import { sendDecisionNotification } from '../workflows/time-off';
import { distributeScheduleCore } from '../workflows/schedule-build';
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

// POST /internal/distribute-schedule
internalRouter.post('/distribute-schedule', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const scheduleId = body.schedule_id;

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
      .single();
    if (schedErr || !schedRow) {
      serverError(res, `schedule ${scheduleId} not found: ${schedErr?.message ?? 'no row'}`);
      return;
    }
    const companyId = (schedRow as { company_id: string }).company_id;

    const result = await distributeScheduleCore(scheduleId, companyId);
    res.json({
      ok: true,
      sent: result.sent,
      total_employees: result.total_employees,
      errors: result.errors,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[internal] distribute-schedule failed:', msg);
    serverError(res, msg);
  }
});
