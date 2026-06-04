// From is always the authenticated apex sender (env.SENDGRID_FROM_EMAIL, e.g.
// aegis@quriasolutions.com) so SPF/DKIM/DMARC stay aligned for every tenant.
// Reply-To is per-tenant: company_channels.channel_value when present, else
// AEGIS_REPLY_TO_EMAIL — that's how replies route back via SendGrid Inbound
// Parse on the tenant's subdomain.
import sgMail from '@sendgrid/mail';
import { env } from '../config/env';
import { supabase } from '../db/client';
import { saveConversation } from '../logger/conversation';

sgMail.setApiKey(env.SENDGRID_API_KEY);

const FALLBACK_REPLY_TO_EMAIL = process.env.AEGIS_REPLY_TO_EMAIL ?? 'aegis@aegis.quriasolutions.com';

interface EmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
  company_id: string;
  thread_id?: string;
}

async function resolveTenantEmailAddress(companyId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('company_channels')
    .select('channel_value')
    .eq('company_id', companyId)
    .eq('channel_type', 'email')
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn('[email] company_channels lookup error:', error.message);
    return null;
  }
  return (data as { channel_value: string } | null)?.channel_value ?? null;
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
    Aegis · Quria Solutions
  </div>
</div>`;
}

export async function sendEmail(options: EmailOptions): Promise<void> {
  const tenantReplyTo = await resolveTenantEmailAddress(options.company_id);
  if (!tenantReplyTo) {
    console.warn(
      `[email] no company_channels email row for company_id ${options.company_id}; ` +
      `falling back to AEGIS_REPLY_TO_EMAIL`
    );
  }
  const replyToAddress = tenantReplyTo ?? FALLBACK_REPLY_TO_EMAIL;

  try {
    await sgMail.send({
      to: options.to,
      from: {
        email: env.SENDGRID_FROM_EMAIL,
        name: env.SENDGRID_FROM_NAME,
      },
      replyTo: replyToAddress,
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
