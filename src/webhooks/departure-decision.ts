import { Router } from 'express';
import { managerStillActive } from '../security/manager-active';
import { findTokenRow, deleteTokenRowBySource } from '../security/decision-token-store';
import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { getAegisSmsChannel, notifyEmployeeSmsFirst } from '../messaging/notify';
import { formatDateRange } from '../workflows/time-off';
import { brandedPage } from './decision';
import { BRAND } from '../messaging/brand';
import type { DepartureDecisionToken } from '../workflows/departure';

// ── Departure Acknowledge / Follow-up magic-link (NextBuild Feature B) ─────────
//
// The manager's alert email carries two one-tap buttons that land here:
//   • acknowledge → records the employee's last_day in Homebase (when a date was
//     given) and texts the employee that their manager has it.
//   • followup    → records nothing; texts the employee that their manager will
//     reach out personally.
// Either way the SUBMITTING employee hears back. Deliberately separate from the
// live time-off/swap/coverage decision webhook so that flow stays untouched.

export const departureDecisionWebhook = Router();

function firstName(name: string): string {
  return (name ?? '').trim().split(/\s+/)[0] || 'there';
}
function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const errorPage = (msg: string): string =>
  brandedPage({ title: 'Departure', heading: 'Something went wrong', headingColor: BRAND.textPrimary, icon: '✕', iconColor: '#e5484d', body: msg });

export interface DepartureDecisionResult {
  status: number;
  html: string;
}

type ResolvedDeparture =
  | { kind: 'respond'; status: number; html: string }
  | { kind: 'ok'; payload: DepartureDecisionToken; tokenSource: string };

// Validation only — reads nothing but the token row and changes NOTHING (N-3:
// the GET renders a confirm page from this; only the POST executes).
async function resolveDepartureToken(params: {
  action?: string;
  departureId?: string;
  token?: string;
}): Promise<ResolvedDeparture> {
  const { action, departureId, token } = params;

  if (!action || !departureId || !token) {
    return { kind: 'respond', status: 400, html: errorPage('This link is missing information. Please use the buttons from your Aegis email.') };
  }
  if (action !== 'acknowledge' && action !== 'followup') {
    return { kind: 'respond', status: 400, html: errorPage('Unknown action. Please use the Acknowledge or follow-up button from your email.') };
  }

  const tokenData = await findTokenRow('departure_token', token);
  if (!tokenData) {
    return { kind: 'respond', status: 404, html: errorPage('This link has already been used or has expired. You can set or change a last day anytime in Homebase.') };
  }

  let payload: DepartureDecisionToken;
  try {
    payload = JSON.parse(tokenData.content) as DepartureDecisionToken;
  } catch {
    return { kind: 'respond', status: 500, html: errorPage('An internal error occurred. Please try again.') };
  }

  if (new Date(payload.expires_at) < new Date()) {
    await deleteTokenRowBySource(tokenData.source);
    return { kind: 'respond', status: 410, html: errorPage('This link has expired. You can set the last day directly in Homebase.') };
  }
  if (payload.departure_id !== departureId) {
    return { kind: 'respond', status: 400, html: errorPage('This link does not match the request. Please use the buttons from your Aegis email.') };
  }
  // S-3 (actor half): a revoked manager's link is dead.
  if (!(await managerStillActive(payload.manager_user_id))) {
    return { kind: 'respond', status: 403, html: errorPage('This link belongs to a login that no longer has manager access. Please ask a current manager to handle this in Homebase.') };
  }

  return { kind: 'ok', payload, tokenSource: tokenData.source };
}

// The N-3 confirm page — read-only description of what the button will do.
export function confirmDeparturePage(
  payload: DepartureDecisionToken,
  action: 'acknowledge' | 'followup',
  departureId: string,
  token: string,
): string {
  const employeeName = payload.employee_name;
  const lastDayDisplay = payload.last_day_date ? formatDateRange(payload.last_day_date, payload.last_day_date) : null;
  const heading = action === 'acknowledge' ? 'Acknowledge this departure?' : 'Follow up personally?';
  const description = action === 'acknowledge'
    ? lastDayDisplay
      ? `Press the button to record ${escapeText(employeeName)}'s last day as ${escapeText(lastDayDisplay)} and let them know you've got it.`
      : `Press the button to let ${escapeText(employeeName)} know you've got it — you'll set the exact last day in Homebase afterward.`
    : `Press the button and I'll tell ${escapeText(employeeName)} you'll reach out personally. Nothing gets recorded yet.`;
  const buttonLabel = action === 'acknowledge' ? 'Acknowledge' : "I'll follow up";
  const postUrl = `/webhooks/departure?action=${encodeURIComponent(action)}&departureId=${encodeURIComponent(departureId)}&token=${encodeURIComponent(token)}`;
  const body = `${description}
      <form method="POST" action="${postUrl.replace(/&/g, '&amp;')}" style="margin:24px 0 0;">
        <button type="submit" style="background:${BRAND.accent};color:${BRAND.bgBase};border:none;padding:13px 30px;border-radius:9px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;">${escapeText(buttonLabel)}</button>
      </form>
      <div style="margin-top:18px;font-size:13px;color:${BRAND.textSecondary};">Nothing happens until you press the button — you can close this tab to change your mind.</div>`;
  return brandedPage({ title: heading, heading, headingColor: BRAND.textPrimary, icon: '👋', iconColor: BRAND.accent, body });
}

// Core logic, extracted so it's unit-testable without an HTTP layer. Consumes the
// one-time token, performs the acknowledge/followup effect, notifies the employee,
// and returns the branded result page + status. This is the POST (confirm-button)
// path — the GET renders confirmDeparturePage and never lands here.
export async function processDepartureDecision(params: {
  action?: string;
  departureId?: string;
  token?: string;
}): Promise<DepartureDecisionResult> {
  const resolved = await resolveDepartureToken(params);
  if (resolved.kind === 'respond') {
    return { status: resolved.status, html: resolved.html };
  }
  const { payload, tokenSource } = resolved;
  const action = params.action as 'acknowledge' | 'followup';

  const companyId = payload.company_id;
  const employeeName = payload.employee_name;
  const lastDayDisplay = payload.last_day_date ? formatDateRange(payload.last_day_date, payload.last_day_date) : null;

  // Resolve the employee's fresh contacts for the notice (SMS-first, email fallback).
  let phone: string | null = payload.employee_channel === 'sms' ? payload.employee_contact : null;
  let email: string | null = payload.employee_channel === 'email' ? payload.employee_contact : null;
  if (payload.employee_id) {
    const { data: empRow } = await supabase
      .from('employees')
      .select('contact_phone, contact_email')
      .eq('id', payload.employee_id)
      .eq('company_id', companyId)
      .maybeSingle();
    const emp = empRow as { contact_phone: string | null; contact_email: string | null } | null;
    if (emp) {
      phone = emp.contact_phone ?? phone;
      email = emp.contact_email ?? email;
    }
  }
  const smsChannel = await getAegisSmsChannel(companyId);

  try {
    if (action === 'acknowledge') {
      // Record the last day when one was given (the acknowledgment IS the trigger
      // to persist it). When no date was given, we still acknowledge + notify; the
      // manager sets the exact date afterward in Homebase.
      if (payload.last_day_date && payload.employee_id) {
        const { error: updErr } = await supabase
          .from('employees')
          .update({ last_day: payload.last_day_date })
          .eq('id', payload.employee_id)
          .eq('company_id', companyId);
        if (updErr) throw updErr;
      }
      await logActivity({
        company_id: companyId,
        actor: 'manager',
        actor_name: payload.manager_name,
        action: 'departure_acknowledged',
        entity_type: 'employee',
        entity_id: payload.employee_id ?? undefined,
        summary: `${payload.manager_name} acknowledged ${employeeName}'s departure${lastDayDisplay ? ` — last day set to ${lastDayDisplay}` : ' (no date given; last day to be set in Homebase)'}.`,
        metadata: { manager_user_id: payload.manager_user_id, last_day: payload.last_day_date },
      });

      await notifyEmployeeSmsFirst({
        company_id: companyId,
        smsChannel,
        phone,
        email,
        subject: 'Your last day',
        body: lastDayDisplay
          ? `Hi ${firstName(employeeName)} — ${payload.manager_name} saw your note and has your last day (${lastDayDisplay}) recorded. They may reach out with a few questions, but you're all set on our end. Thanks for the heads-up!`
          : `Hi ${firstName(employeeName)} — ${payload.manager_name} saw your note about leaving and has it noted. They may reach out to nail down your exact last day. Thanks for the heads-up!`,
        thread_id: payload.thread_id,
        employee_id: payload.employee_id ?? undefined,
      });

      await deleteTokenRowBySource(tokenSource);
      return {
        status: 200,
        html: brandedPage({
          title: 'Acknowledged',
          heading: 'Acknowledged',
          headingColor: BRAND.accent,
          icon: '✓',
          iconColor: BRAND.accent,
          body: lastDayDisplay
            ? `${escapeText(employeeName)}'s last day is recorded as ${escapeText(lastDayDisplay)}. We've let them know you've got it. They'll drop off future schedules automatically after that date.`
            : `We've let ${escapeText(employeeName)} know you've got it. Set their exact last day in Homebase when you're ready and they'll drop off future schedules automatically after it.`,
        }),
      };
    }

    // followup — record nothing; tell the employee their manager will reach out.
    await logActivity({
      company_id: companyId,
      actor: 'manager',
      actor_name: payload.manager_name,
      action: 'departure_followup_requested',
      entity_type: 'employee',
      entity_id: payload.employee_id ?? undefined,
      summary: `${payload.manager_name} will follow up with ${employeeName} personally about their departure (nothing recorded yet).`,
      metadata: { manager_user_id: payload.manager_user_id, last_day_date: payload.last_day_date },
    });

    await notifyEmployeeSmsFirst({
      company_id: companyId,
      smsChannel,
      phone,
      email,
      subject: 'About your note',
      body: `Hi ${firstName(employeeName)} — ${payload.manager_name} saw your note and would like to talk it through with you directly, so expect them to reach out soon. Thanks!`,
      thread_id: payload.thread_id,
      employee_id: payload.employee_id ?? undefined,
    });

    await deleteTokenRowBySource(tokenSource);
    return {
      status: 200,
      html: brandedPage({
        title: 'Follow up',
        heading: "We'll let them know",
        headingColor: BRAND.accent,
        icon: '✓',
        iconColor: BRAND.accent,
        body: `We've told ${escapeText(employeeName)} you'll reach out personally. Nothing was recorded — set their last day in Homebase whenever you and they land on one.`,
      }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[departure-decision] failed:', msg);
    return { status: 500, html: errorPage('We hit a snag recording that. Please try again, or set the last day directly in Homebase.') };
  }
}

// GET — validate and render the confirm page. Never changes state (N-3).
departureDecisionWebhook.get('/', async (req, res) => {
  const { action, departureId, token } = req.query as Record<string, string>;
  const resolved = await resolveDepartureToken({ action, departureId, token });
  if (resolved.kind === 'respond') {
    res.status(resolved.status).send(resolved.html);
    return;
  }
  res.send(confirmDeparturePage(resolved.payload, action as 'acknowledge' | 'followup', departureId, token));
});

// POST — the confirm button executes.
departureDecisionWebhook.post('/', async (req, res) => {
  const { action, departureId, token } = req.query as Record<string, string>;
  const { status, html } = await processDepartureDecision({ action, departureId, token });
  res.status(status).send(html);
});
