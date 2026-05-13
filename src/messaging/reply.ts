import { supabase } from '../db/client';
import { sendSms } from './sms';
import { sendEmail } from './email';
import type { InboundMessage, VerifiedContact } from '../security/types';

async function lookupContactEmail(contact: VerifiedContact): Promise<string | null> {
  if (contact.role === 'quria_admin') {
    return contact.quria_staff_email ?? null;
  }
  if (contact.employee_id) {
    const { data } = await supabase
      .from('employees')
      .select('contact_email')
      .eq('id', contact.employee_id)
      .maybeSingle();
    return (data as { contact_email: string | null } | null)?.contact_email ?? null;
  }
  if (contact.user_id) {
    const { data } = await supabase
      .from('users')
      .select('email')
      .eq('id', contact.user_id)
      .maybeSingle();
    return (data as { email: string | null } | null)?.email ?? null;
  }
  return null;
}

export async function reply(
  contact: VerifiedContact,
  originalMessage: InboundMessage,
  text: string,
  html?: string
): Promise<void> {
  if (originalMessage.channel === 'sms') {
    const sent = await sendSms({
      to: originalMessage.sender,
      from: originalMessage.recipient,
      body: text,
      company_id: contact.company_id,
    });
    if (sent) return;

    const fallbackEmail = await lookupContactEmail(contact);
    if (!fallbackEmail) {
      console.warn('[reply] SMS send failed and no email fallback for', contact.matched_identifier);
      return;
    }
    console.warn('[reply] SMS send failed; falling back to email', fallbackEmail);
    await sendEmail({
      to: fallbackEmail,
      subject: 'Message from Aegis',
      text,
      html,
      company_id: contact.company_id,
    });
    return;
  }

  await sendEmail({
    to: originalMessage.sender,
    subject: originalMessage.raw_subject
      ? `Re: ${originalMessage.raw_subject}`
      : 'Re: Your message to Aegis',
    text,
    html,
    company_id: contact.company_id,
    thread_id: originalMessage.thread_id,
  });
}
