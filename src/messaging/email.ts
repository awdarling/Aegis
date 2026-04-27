import sgMail from '@sendgrid/mail';
import { env } from '../config/env';
import { saveConversation } from '../logger/conversation';

sgMail.setApiKey(env.SENDGRID_API_KEY);

interface EmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
  company_id: string;
  thread_id?: string;
}

export async function sendEmail(options: EmailOptions): Promise<void> {
  try {
    await sgMail.send({
      to: options.to,
      from: {
        email: env.SENDGRID_FROM_EMAIL,
        name: env.SENDGRID_FROM_NAME,
      },
      subject: options.subject,
      text: options.text,
      html: options.html ?? `<p>${options.text.replace(/\n/g, '<br>')}</p>`,
      ...(options.thread_id
        ? {
            headers: {
              'In-Reply-To': options.thread_id,
              References: options.thread_id,
            },
          }
        : {}),
    });

    await saveConversation({
      company_id: options.company_id,
      channel: 'email',
      direction: 'outbound',
      content: options.text,
      from_address: env.SENDGRID_FROM_EMAIL,
      to_address: options.to,
      subject: options.subject,
      thread_id: options.thread_id,
    });
  } catch (err) {
    console.error('[email] send failed:', err);
  }
}
