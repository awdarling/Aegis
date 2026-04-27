import { sendSms } from './sms';
import { sendEmail } from './email';
import type { InboundMessage, VerifiedContact } from '../security/types';

export async function reply(
  contact: VerifiedContact,
  originalMessage: InboundMessage,
  text: string,
  html?: string
): Promise<void> {
  if (originalMessage.channel === 'sms') {
    await sendSms({
      to: originalMessage.sender,
      from: originalMessage.recipient,
      body: text,
      company_id: contact.company_id,
    });
  } else {
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
}
