// From is always the authenticated apex sender (env.SENDGRID_FROM_EMAIL, e.g.
// aegis@quriasolutions.com) so SPF/DKIM/DMARC stay aligned for every tenant.
// Reply-To is per-tenant: company_channels.channel_value when present, else
// AEGIS_REPLY_TO_EMAIL — that's how replies route back via SendGrid Inbound
// Parse on the tenant's subdomain.
import sgMail from '@sendgrid/mail';
import { env } from '../config/env';
import { supabase } from '../db/client';
import { saveConversation } from '../logger/conversation';
import { BRAND, brandedEmailShell, quriaLogoInlineAttachment, QURIA_LOGO_CID } from './brand';

sgMail.setApiKey(env.SENDGRID_API_KEY);

const FALLBACK_REPLY_TO_EMAIL = process.env.AEGIS_REPLY_TO_EMAIL ?? 'aegis@aegis.quriasolutions.com';

// A single file to attach. `content` is the raw (un-encoded) file body; sendEmail
// base64-encodes it before handing it to SendGrid. `type` is the MIME type
// (e.g. 'text/html', 'application/pdf'); `disposition` defaults to 'attachment'.
export interface EmailAttachment {
  filename: string;
  content: string | Buffer;
  type?: string;
  disposition?: 'attachment' | 'inline';
  /** Required by SendGrid only for inline images referenced via cid: in the HTML. */
  content_id?: string;
}

interface EmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
  company_id: string;
  thread_id?: string;
  attachments?: EmailAttachment[];
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
    .map((p) => `<p style="margin:0 0 14px;color:${BRAND.textPrimary};">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');

  // Every simple reply now rides the same Quria dark shell as the rich
  // workflow emails, so branding is consistent across all outbound mail.
  return brandedEmailShell({ bodyHtml: paragraphs });
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

  const html = options.html ?? htmlFromText(options.text);

  // Every branded email references the logo as `cid:quria-logo`. Attach the
  // inline logo image whenever the HTML uses it (and a caller hasn't already
  // supplied it), so the mark renders in-client without external hosting.
  const attachments: EmailAttachment[] = [...(options.attachments ?? [])];
  const usesLogoCid = html.includes(`cid:${QURIA_LOGO_CID}`);
  const alreadyHasLogo = attachments.some((a) => a.content_id === QURIA_LOGO_CID);
  if (usesLogoCid && !alreadyHasLogo) {
    attachments.push(quriaLogoInlineAttachment());
  }

  // Map our EmailAttachment shape onto SendGrid's. SendGrid expects the file
  // body as a base64 string, so we encode here — callers pass raw text/Buffer.
  const sgAttachments = attachments.map((a) => ({
    filename: a.filename,
    content: Buffer.isBuffer(a.content)
      ? a.content.toString('base64')
      : Buffer.from(a.content, 'utf-8').toString('base64'),
    type: a.type ?? 'application/octet-stream',
    disposition: a.disposition ?? 'attachment',
    ...(a.content_id ? { content_id: a.content_id } : {}),
  }));

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
      html,
      ...(sgAttachments && sgAttachments.length > 0
        ? { attachments: sgAttachments }
        : {}),
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
