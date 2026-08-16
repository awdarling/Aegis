// ── Employee departure / last-day signal → manager alert (NextBuild Feature B) ──
//
// An employee tells Aegis they're leaving ("my last day is Aug 30", "putting in my
// two weeks", "I quit"). Aegis does NOT act on it: employment status never rides an
// employee's inbound message (house rule — matches the inbox-only availability
// precedent). Instead it:
//   1) acknowledges the employee,
//   2) alerts the MANAGER (email is the GUARANTEED channel; SMS is additive), and
//   3) writes NOTHING to `employees` — only a `departure_signal_flagged` activity row.
//
// The MANAGER acknowledges by SETTING the last day (Soteria "set <name>'s last day"
// or the Employees tab). That deliberate act is the only trigger that persists it; a
// daily job then deactivates the employee once the day passes.
//
// Recipient resolution mirrors time-off.ts notifyManager: first manager/owner user →
// their PERSONAL phone via employees.contact_phone joined on contact_email → the
// tenant Aegis outbound number via getAegisSmsChannel. It deliberately does NOT use
// payroll.ts getManagerSmsChannel, which returns the Aegis outbound number (not the
// manager's phone) — a latent bug we must not inherit.

import { randomUUID } from 'crypto';
import { supabase } from '../db/client';
import { env } from '../config/env';
import { reply } from '../messaging/reply';
import { sendEmail } from '../messaging/email';
import { sendSms } from '../messaging/sms';
import { managerAlertSms } from '../messaging/greeting';
import { getAegisSmsChannel } from '../messaging/notify';
import { brandedEmailShell, brandedButtonRow, BRAND } from '../messaging/brand';
import { logActivity } from '../logger/activity-log';
import { formatDateRange } from './time-off';
import type { InboundMessage, VerifiedContact } from '../security/types';

// The persisted magic-link payload the manager's Acknowledge / Follow-up buttons
// carry. Stored in aegis_memory under source `departure_token:<token>`; consumed
// once by the /webhooks/departure route (src/webhooks/departure-decision.ts).
export interface DepartureDecisionToken {
  departure_id: string;
  company_id: string;
  employee_id: string | null;
  employee_name: string;
  employee_contact: string;              // the sender they messaged from (SMS number / email)
  employee_channel: 'sms' | 'email';
  employee_recipient: string;            // the Aegis channel value they messaged
  last_day_date: string | null;          // YYYY-MM-DD, or null when no date was given
  note: string | null;
  manager_name: string;
  manager_user_id: string | null;
  thread_id: string | null;
  raw_subject: string | null;
  expires_at: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function handleReportDeparture(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  const companyId = contact.company_id;
  const employeeName = contact.name;

  const rawLastDay = typeof extracted.last_day_date === 'string' ? extracted.last_day_date.trim() : '';
  const lastDayDate = /^\d{4}-\d{2}-\d{2}$/.test(rawLastDay) ? rawLastDay : null;
  const note = typeof extracted.note === 'string' && extracted.note.trim() ? extracted.note.trim() : null;
  const lastDayDisplay = lastDayDate ? formatDateRange(lastDayDate, lastDayDate) : null;

  // Resolve the manager/owner to notify (first, deterministic — mirrors time-off).
  const { data: managerData } = await supabase
    .from('users')
    .select('id, email, name, role')
    .eq('company_id', companyId)
    .in('role', ['manager', 'owner'])
    .order('role', { ascending: true })
    .limit(1)
    .maybeSingle();
  const manager = managerData as { id: string; email: string; name: string; role: string } | null;

  // ALWAYS record the signal (no employee write) — even if no manager is reachable,
  // so it's visible in the activity feed.
  await logActivity({
    company_id: companyId,
    action: 'departure_signal_flagged',
    entity_type: 'employee',
    entity_id: contact.employee_id ?? undefined,
    summary: `${employeeName} signaled a departure${lastDayDisplay ? ` (last day ${lastDayDisplay})` : ' (no date given)'}${note ? ` — ${note}` : ''}. Manager alerted; awaiting acknowledgment.`,
    metadata: {
      employee_id: contact.employee_id ?? null,
      last_day_date: lastDayDate,
      note,
      raw_message: message.body,
      source_channel: message.channel,
    },
  });

  if (!manager) {
    console.warn('[departure] no manager/owner found for company', companyId);
    await reply(
      contact,
      message,
      `Thanks for letting me know${lastDayDisplay ? ` — I've noted your last day as ${lastDayDisplay}` : ''}. I wasn't able to reach a manager automatically, so please also tell them directly so they can get everything sorted.`
    );
    return;
  }

  // The manager's PERSONAL phone (employees row on contact_email) — NOT the Aegis
  // outbound number. Null when the manager has no employee row / no phone on file.
  const { data: managerEmpData } = await supabase
    .from('employees')
    .select('contact_phone')
    .eq('company_id', companyId)
    .eq('contact_email', manager.email)
    .maybeSingle();
  const managerPhone = (managerEmpData as { contact_phone: string | null } | null)?.contact_phone ?? null;
  const aegisSmsNumber = await getAegisSmsChannel(companyId);

  // ── Mint the one-tap Acknowledge / Follow-up magic-link token ───────────────
  // ONE token carries the whole context; the URL's `action` selects the branch.
  // Neither branch is destructive (Acknowledge writes a clearable last_day;
  // Follow-up writes nothing), so a single token for both buttons is safe.
  const departureId = randomUUID();
  const token = randomUUID();
  const tokenPayload: DepartureDecisionToken = {
    departure_id: departureId,
    company_id: companyId,
    employee_id: contact.employee_id ?? null,
    employee_name: employeeName,
    employee_contact: message.sender,
    employee_channel: message.channel === 'sms' ? 'sms' : 'email',
    employee_recipient: message.recipient,
    last_day_date: lastDayDate,
    note,
    manager_name: manager.name,
    manager_user_id: manager.id,
    thread_id: message.thread_id ?? null,
    raw_subject: message.raw_subject ?? null,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
  await supabase.from('aegis_memory').insert({
    company_id: companyId,
    memory_type: 'observation',
    source: `departure_token:${token}`,
    content: JSON.stringify(tokenPayload),
  });

  const baseUrl = env.BASE_URL;
  const ackUrl = `${baseUrl}/webhooks/departure?action=acknowledge&departureId=${departureId}&token=${token}`;
  const followupUrl = `${baseUrl}/webhooks/departure?action=followup&departureId=${departureId}&token=${token}`;

  // ── Manager EMAIL — the guaranteed channel, now with two one-tap buttons ─────
  const dateLine = lastDayDisplay
    ? `Their stated last working day is <strong>${esc(lastDayDisplay)}</strong>.`
    : `They did not give a specific last day (e.g. "two weeks' notice").`;
  const noteLine = note ? `<p style="margin:0 0 16px;font-size:16px;color:${BRAND.textPrimary};line-height:1.65;">They mentioned: "${esc(note)}".</p>` : '';
  const ackExplains = lastDayDisplay
    ? `<strong>Acknowledge</strong> records ${esc(lastDayDisplay)} as their last day in Homebase and lets them know you've got it.`
    : `<strong>Acknowledge</strong> lets them know you've got it — since they didn't give a date, set the exact last day afterward in Homebase (tell Soteria &ldquo;set ${esc(employeeName)}'s last day to &lt;date&gt;&rdquo; or use the Employees tab).`;

  const subject = `${employeeName} may be leaving${lastDayDisplay ? ` — last day ${lastDayDisplay}` : ''}`;
  const text =
    `${employeeName} told Aegis they're planning to leave${lastDayDisplay ? `, with a last working day of ${lastDayDisplay}` : ` (no specific date given yet)`}.` +
    `${note ? ` They mentioned: "${note}".` : ''}\n\n` +
    `I haven't changed anything about their record — resignations aren't something I act on from a text; your response is what makes it official. Two options, and either way ${employeeName} hears back from me:\n` +
    `• Acknowledge${lastDayDisplay ? ` (records ${lastDayDisplay} as their last day)` : ''}: ${ackUrl}\n` +
    `• I'll follow up personally (I'll tell them you'll reach out; nothing is recorded yet): ${followupUrl}\n\n` +
    `You can also always set or change a last day directly in Homebase.`;

  const html = brandedEmailShell({
    preheader: `${employeeName} signaled a departure — Acknowledge or follow up personally`,
    bodyHtml:
      `<p style="margin:0 0 16px;font-size:16px;color:${BRAND.textPrimary};line-height:1.65;">Hi ${esc(manager.name)},</p>` +
      `<p style="margin:0 0 16px;font-size:16px;color:${BRAND.textPrimary};line-height:1.65;">${esc(employeeName)} told Aegis they're planning to leave. ${dateLine}</p>` +
      noteLine +
      `<p style="margin:0 0 16px;font-size:16px;color:${BRAND.textPrimary};line-height:1.65;">I haven't changed anything about their record — resignations aren't something I act on from a text; your response is what makes it official. Either way, ${esc(employeeName)} hears back from me.</p>` +
      brandedButtonRow([
        { url: ackUrl, label: 'Acknowledge', variant: 'primary' },
        { url: followupUrl, label: "I'll follow up personally", variant: 'secondary' },
      ]) +
      `<p style="margin:6px 0 0;font-size:13px;color:${BRAND.textSecondary};line-height:1.6;">${ackExplains} <strong>I'll follow up personally</strong> tells ${esc(employeeName)} you'll reach out and records nothing yet. You can also set or change a last day anytime in Homebase.</p>` +
      `<p style="margin:22px 0 0;color:${BRAND.textSecondary};">— Aegis</p>`,
  });

  await sendEmail({ to: manager.email, subject, text, html, company_id: companyId });

  // ── Manager SMS — additive, skipped in email-only mode or without a phone/number ─
  if (!env.EMAIL_ONLY && managerPhone && aegisSmsNumber) {
    const summary = `${employeeName} says they're leaving${lastDayDisplay ? ` — last day ${lastDayDisplay}` : ` (no date yet)`}.`;
    await sendSms({
      // Recipient is the MANAGER (not under the employee opt-in regime).
      allowPreConsent: true,
      to: managerPhone,
      from: aegisSmsNumber,
      body: managerAlertSms({ managerName: manager.name, summary, inbox: 'action' }),
      company_id: companyId,
    });
  }

  // ── Acknowledge the employee (no employment write) ──────────────────────────
  await reply(
    contact,
    message,
    lastDayDisplay
      ? `Thanks for letting me know — I've noted your last day as ${lastDayDisplay} and passed it along to ${manager.name}. They'll follow up to confirm everything. Take care!`
      : `Thanks for letting me know — I've passed it along to ${manager.name}, and they'll follow up with you to sort out the details. Take care!`
  );
}
