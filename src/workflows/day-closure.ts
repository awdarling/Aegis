import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { sendSms } from '../messaging/sms';
import { sendEmail } from '../messaging/email';
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
    `Hi ${employeeName}, ${companyName} will be closed on ${formattedDate}. ` +
    `Your ${shiftPhrase} has been cancelled. We'll see you for your next scheduled shift. — Aegis`;

  if (employeePhone) {
    const { data: channelData } = await supabase
      .from('company_channels')
      .select('channel_value')
      .eq('company_id', contact.company_id)
      .eq('channel_type', 'sms')
      .maybeSingle();
    const aegisSmsNumber = (channelData as { channel_value: string } | null)?.channel_value ?? '';

    await sendSms({
      to: employeePhone,
      from: aegisSmsNumber,
      body,
      company_id: contact.company_id,
    });
  } else if (employeeEmail) {
    await sendEmail({
      to: employeeEmail,
      subject: `${companyName} — Closed ${formattedDate}`,
      text: body,
      company_id: contact.company_id,
    });
  } else {
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
      channel: employeePhone ? 'sms' : 'email',
    },
  });
}
