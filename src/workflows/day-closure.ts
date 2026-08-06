import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { notifyEmployeeSmsFirst, getAegisSmsChannel } from '../messaging/notify';
import { textOpener } from '../messaging/greeting';
import { reply } from '../messaging/reply';
import type { InboundMessage, VerifiedContact } from '../security/types';

function formatClosureDate(dateStr: string): string {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

// Triggered when Homebase posts a closure notification request via the webhook.
// Sends the notification to the named employee over their available channel and
// logs the action. The inbound message is programmatic — no reply to the
// manager (the Homebase API handles user-facing feedback).
export async function handleNotifyDayClosure(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  const date = extracted['date'] as string | undefined;
  const employeeName = extracted['employee_name'] as string | undefined;
  const employeePhone = (extracted['employee_phone'] as string | null | undefined) ?? null;
  const employeeEmail = (extracted['employee_email'] as string | null | undefined) ?? null;
  const shiftName = (extracted['shift_name'] as string | null | undefined) ?? null;
  const companyName = (extracted['company_name'] as string | undefined) ?? 'Your employer';

  if (!date || !employeeName) {
    console.error('[day-closure] missing required fields:', { date, employeeName });
    return;
  }

  const formattedDate = formatClosureDate(date);
  const shiftPhrase = shiftName ? `${shiftName} shift` : 'shift';
  const body =
    `${textOpener(employeeName)}${companyName} will be closed on ${formattedDate}. ` +
    `Your ${shiftPhrase} has been cancelled. We'll see you for your next scheduled shift. — Aegis`;

  // SMS-first for phone-holders, email fallback (Batch-1 F8) — via the shared
  // notifier, which also falls back to email if the SMS send fails.
  const smsChannel = await getAegisSmsChannel(contact.company_id);
  const used = await notifyEmployeeSmsFirst({
    company_id: contact.company_id,
    smsChannel,
    phone: employeePhone,
    email: employeeEmail,
    body,
    subject: `${companyName} — Closed ${formattedDate}`,
  });

  if (used === 'none') {
    await reply(
      contact,
      message,
      `Could not notify ${employeeName} — no contact info on file.`
    );
    return;
  }

  await logActivity({
    company_id: contact.company_id,
    actor: 'aegis',
    action: 'closure_notification_sent',
    summary: `Closure notification sent to ${employeeName} for ${formattedDate}`,
    metadata: {
      date,
      employee_name: employeeName,
      shift_name: shiftName,
      channel: used,
    },
  });
}

// ── Deterministic day-closure fan-out (Batch-1 F8) ─────────────────────────────
//
// The robust path Homebase's "Close day" calls: given the schedule + the closed
// date, Aegis OWNS the roster — it reads the day's assignments, resolves each
// employee's contacts + the tenant SMS number, and notifies EVERY scheduled
// employee SMS-first + email fallback (SMS spec §3.8 → mid-week-change rule
// §3.6: everyone on that day gets their delta). Previously Homebase impersonated
// the manager over the public /webhooks/sms|email with a "Send this message to
// X" body and relied on the intent classifier to deliver it — fragile and
// signature-rejected in prod, so "Close day" notified nobody. This function is
// deterministic: no classifier, no impersonation, no silent drop.
export interface DayClosureNotifyResult {
  notified: number;
  total_scheduled: number;
  texted: number;
  emailed: number;
  failures: string[];
}

export async function notifyDayClosureCore(
  companyId: string,
  scheduleId: string,
  date: string,
): Promise<DayClosureNotifyResult> {
  type ScheduleData = { assignments?: Array<{ employee_id: string; date: string; shift_name: string }> };

  const { data: scheduleRow, error: schedErr } = await supabase
    .from('schedules')
    .select('id, company_id, data')
    .eq('id', scheduleId)
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .single();
  if (schedErr || !scheduleRow) {
    throw new Error(`schedule ${scheduleId} not found for company ${companyId}: ${schedErr?.message ?? 'no row'}`);
  }

  const scheduleData = (scheduleRow as { data: ScheduleData | null }).data;
  const dayAssignments = (scheduleData?.assignments ?? []).filter(a => a.date === date);
  if (dayAssignments.length === 0) {
    return { notified: 0, total_scheduled: 0, texted: 0, emailed: 0, failures: [] };
  }

  const employeeIds = Array.from(new Set(dayAssignments.map(a => a.employee_id)));
  const [{ data: employeeRows }, { data: companyRow }, smsChannel] = await Promise.all([
    supabase.from('employees').select('id, name, contact_phone, contact_email').in('id', employeeIds),
    supabase.from('companies').select('name').eq('id', companyId).maybeSingle(),
    getAegisSmsChannel(companyId),
  ]);
  const employees = (employeeRows ?? []) as Array<{ id: string; name: string; contact_phone: string | null; contact_email: string | null }>;
  const companyName = (companyRow as { name?: string } | null)?.name ?? 'Your employer';
  const formattedDate = formatClosureDate(date);

  // Which shift(s) each employee had that day, for a specific closure message.
  const shiftsByEmployee = new Map<string, string[]>();
  for (const a of dayAssignments) {
    const list = shiftsByEmployee.get(a.employee_id) ?? [];
    if (!list.includes(a.shift_name)) list.push(a.shift_name);
    shiftsByEmployee.set(a.employee_id, list);
  }

  let notified = 0;
  let texted = 0;
  let emailed = 0;
  const failures: string[] = [];

  for (const emp of employees) {
    const shifts = shiftsByEmployee.get(emp.id) ?? [];
    const shiftPhrase = shifts.length === 0 ? 'shift' : `${shifts.join(' and ')} shift`;
    const body =
      `${textOpener(emp.name)}${companyName} will be closed on ${formattedDate}. ` +
      `Your ${shiftPhrase} has been cancelled. We'll see you for your next scheduled shift. — Aegis`;

    const used = await notifyEmployeeSmsFirst({
      company_id: companyId,
      smsChannel,
      phone: emp.contact_phone,
      email: emp.contact_email,
      body,
      subject: `${companyName} — Closed ${formattedDate}`,
    });

    if (used === 'sms') { notified++; texted++; }
    else if (used === 'email') { notified++; emailed++; }
    else failures.push(`${emp.name} (no phone or email on file)`);
  }

  await logActivity({
    company_id: companyId,
    actor: 'aegis',
    action: 'closure_notifications_sent',
    entity_type: 'schedule',
    entity_id: scheduleId,
    summary: `Closure notifications sent to ${notified} of ${employees.length} scheduled employee(s) for ${formattedDate} (${texted} SMS, ${emailed} email)`,
    metadata: { date, notified, texted, emailed, total_scheduled: employees.length, failures: failures.length > 0 ? failures : null },
  });

  return { notified, total_scheduled: employees.length, texted, emailed, failures };
}
