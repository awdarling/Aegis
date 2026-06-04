import { supabase } from '../db/client';
import { sendSms } from './sms';
import { sendEmail } from './email';
import type { InboundMessage, VerifiedContact } from '../security/types';

// Collapse any chain of leading "Re:" (case/space-insensitive) to a single
// "Re: " — clients otherwise stack them on each round-trip ("Re: Re: Re:").
export function normalizeReSubject(raw: string): string {
  const stripped = raw.replace(/^(?:\s*re\s*:\s*)+/i, '').trim();
  return `Re: ${stripped}`;
}

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
      ? normalizeReSubject(originalMessage.raw_subject)
      : 'Re: Your message to Aegis',
    text,
    html,
    company_id: contact.company_id,
    thread_id: originalMessage.thread_id,
  });
}

// In-thread acknowledgment for email-only intents (no-op on SMS). Callers
// own the body text and any post-send delay so different intents can tune
// timing independently.
export async function sendInThreadAck(params: {
  message: InboundMessage;
  contact: VerifiedContact;
  bodyText: string;
}): Promise<void> {
  if (params.message.channel !== 'email') return;

  const subject = params.message.raw_subject
    ? normalizeReSubject(params.message.raw_subject)
    : 'Re: Your message to Aegis';

  await sendEmail({
    to: params.message.sender,
    subject,
    text: params.bodyText,
    company_id: params.contact.company_id,
    thread_id: params.message.thread_id,
  });

  console.log('[ack] sent in-thread reply', {
    to: params.message.sender,
    thread_id: params.message.thread_id,
  });
}
