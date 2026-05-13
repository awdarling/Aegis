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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function htmlFromText(text: string): string {
  const escaped = escapeHtml(text);
  const bolded = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const paragraphs = bolded
    .split(/\n{2,}/)
    .map((p) => `<p style="margin: 0 0 12px;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');

  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 24px;">
  ${paragraphs}
  <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e5e5; font-size: 12px; color: #888;">
    Aegis · Quria Solutions · <a href="https://homebase-liart.vercel.app" style="color: #6366f1;">View in Homebase</a>
  </div>
</div>`;
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
      html: options.html ?? htmlFromText(options.text),
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
