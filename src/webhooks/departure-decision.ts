import { Router } from 'express';
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

// Core logic, extracted so it's unit-testable without an HTTP layer. Consumes the
// one-time token, performs the acknowledge/followup effect, notifies the employee,
// and returns the branded result page + status.
export async function processDepartureDecision(params: {
  action?: string;
  departureId?: string;
  token?: string;
}): Promise<DepartureDecisionResult> {
  const { action, departureId, token } = params;

  if (!action || !departureId || !token) {
    return { status: 400, html: errorPage('This link is missing information. Please use the buttons from your Aegis email.') };
  }
  if (action !== 'acknowledge' && action !== 'followup') {
    return { status: 400, html: errorPage('Unknown action. Please use the Acknowledge or follow-up button from your email.') };
  }

  const { data: tokenData } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('source', `departure_token:${token}`)
    .maybeSingle();

  if (!tokenData) {
    return { status: 404, html: errorPage('This link has already been used or has expired. You can set or change a last day anytime in Homebase.') };
  }

  let payload: DepartureDecisionToken;
  try {
    payload = JSON.parse((tokenData as { content: string }).content) as DepartureDecisionToken;
  } catch {
    return { status: 500, html: errorPage('An internal error occurred. Please try again.') };
  }

  if (new Date(payload.expires_at) < new Date()) {
    await supabase.from('aegis_memory').delete().eq('source', `departure_token:${token}`);
    return { status: 410, html: errorPage('This link has expired. You can set the last day directly in Homebase.') };
  }
  if (payload.departure_id !== departureId) {
    return { status: 400, html: errorPage('This link does not match the request. Please use the buttons from your Aegis email.') };
  }

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

      await supabase.from('aegis_memory').delete().eq('source', `departure_token:${token}`);
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

    await supabase.from('aegis_memory').delete().eq('source', `departure_token:${token}`);
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

departureDecisionWebhook.get('/', async (req, res) => {
  const { action, departureId, token } = req.query as Record<string, string>;
  const { status, html } = await processDepartureDecision({ action, departureId, token });
  res.status(status).send(html);
});
