import { env } from '../config/env';
import { supabase } from '../db/client';
import { saveConversation } from '../logger/conversation';
import { sendTelnyxMessage } from './telnyx';
import { canSmsEmployee } from './consent';

interface SmsOptions {
  to: string;
  from: string; // the tenant's own Telnyx number (the company's dedicated line)
  body: string;
  company_id: string;
  // ── Consent (N3) ───────────────────────────────────────────────────────────
  // The recipient employee whose consent gates this send. REQUIRED for any SMS
  // to a team member, unless allowPreConsent is set. When present, the send is
  // blocked (returns false → email fallback) unless the employee's durable
  // consent state permits it (see messaging/consent.ts).
  employee_id?: string;
  // Bypass the employee consent gate. Set ONLY when the caller has already
  // established the send is legitimately outside the employee opt-in regime:
  //   (a) the onboarding opt-in INVITATION itself + onboarding's own guarded
  //       flow (onboarding is the consent authority for its own session and
  //       already gates on opt_in_confirmed), and
  //   (b) sends to a MANAGER / quria-admin recipient (client staff operating the
  //       system — covered by the owner's subscription agreement, not the
  //       employee opt-in regime; a STOP'd number is carrier-suppressed anyway).
  // Never set this for an automated employee notification.
  allowPreConsent?: boolean;
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

  // ── Consent gate (N3) — the single chokepoint. ────────────────────────────
  // Every automated SMS to an employee must clear this. Exactly one class of
  // send bypasses it: allowPreConsent (the onboarding opt-in invitation + its
  // own guarded flow, and manager/quria-admin recipients — see SmsOptions).
  // A send that identifies no employee and is not marked allowPreConsent cannot
  // have its consent verified, so it is REFUSED (fail closed) rather than
  // silently delivered — this is the guarantee that closes the hole for every
  // present and future caller.
  if (!options.allowPreConsent) {
    if (!options.employee_id) {
      console.error(
        `[sms] refusing to send for company ${options.company_id}: no employee_id and ` +
          `allowPreConsent not set — cannot verify consent (fail closed).`
      );
      return false;
    }
    const consented = await canSmsEmployee(options.company_id, options.employee_id);
    if (!consented) {
      console.warn(
        `[sms] blocked: employee ${options.employee_id} (company ${options.company_id}) ` +
          `has not consented to SMS — falling back to email path.`
      );
      return false;
    }
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
