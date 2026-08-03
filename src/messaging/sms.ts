import { env } from '../config/env';
import { supabase } from '../db/client';
import { saveConversation } from '../logger/conversation';
import { sendTelnyxMessage } from './telnyx';

interface SmsOptions {
  to: string;
  from: string; // the tenant's own Telnyx number (the company's dedicated line)
  body: string;
  company_id: string;
}

// Resolve a tenant's own SMS sending number from config (company_channels).
// This is the number-agnostic, per-client resolution required by the platform:
// each company has its OWN Telnyx number, stored as its `sms` channel row.
// Returns null if the tenant has no SMS number configured.
export async function getTenantSmsNumber(companyId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('company_channels')
    .select('channel_value')
    .eq('company_id', companyId)
    .eq('channel_type', 'sms')
    .maybeSingle();

  if (error) {
    console.error('[sms] tenant SMS number lookup failed:', error.message);
    return null;
  }
  return (data as { channel_value: string } | null)?.channel_value ?? null;
}

export async function sendSms(options: SmsOptions): Promise<boolean> {
  // Hard email-only guard. While EMAIL_ONLY is on, no SMS is ever sent regardless
  // of caller — the single choke point that guarantees the SMS system is dormant
  // until the consent chain clears. Returns false so any email fallback path
  // behaves exactly as if the send had failed.
  if (env.EMAIL_ONLY) {
    console.warn('[sms] EMAIL_ONLY mode — SMS disabled; skipping send.');
    return false;
  }
  if (!env.TELNYX_API_KEY) {
    console.warn('[sms] Telnyx not configured — SMS disabled (email-first mode). Skipping send.');
    return false;
  }

  // The tenant's own number: prefer the caller-supplied `from` (a reply always
  // carries the number the inbound arrived on), else resolve it per-tenant from
  // config. Never a hardcoded or global number.
  const fromNumber = options.from || (await getTenantSmsNumber(options.company_id));
  if (!fromNumber) {
    console.error(
      `[sms] no SMS number for company ${options.company_id} — cannot send (configure its company_channels sms row).`
    );
    return false;
  }

  const result = await sendTelnyxMessage({
    from: fromNumber,
    to: options.to,
    text: options.body,
  });

  if (!result.ok) {
    console.error('[sms] send failed:', result.error);
    // Make the failure visible in the DB, not just the console — a send that never
    // reaches a phone was previously invisible except in server stdout. Marked
    // distinctly so it can never be mistaken for a delivered message.
    await saveConversation({
      company_id: options.company_id,
      channel: 'sms',
      direction: 'outbound',
      content: `[SEND FAILED — ${result.error}] ${options.body}`,
      from_address: fromNumber,
      to_address: options.to,
    });
    return false;
  }

  await saveConversation({
    company_id: options.company_id,
    channel: 'sms',
    direction: 'outbound',
    content: options.body,
    from_address: fromNumber,
    to_address: options.to,
  });
  return true;
}
