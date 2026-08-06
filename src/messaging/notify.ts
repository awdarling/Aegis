import { supabase } from '../db/client';
import { sendSms } from './sms';
import { sendEmail } from './email';
import { env } from '../config/env';

// ── The cross-cutting SMS-first rule (one fact, one place) ────────────────────
//
// SMS System Specification §2.3 / §3.2 / §3.3 / §3.6 and the Batch-1 design
// principle: when EMAIL_ONLY=false, any employee who has a contact_phone is
// notified by SMS, with EMAIL as the FALLBACK — on send failure, or when there
// is no phone. Never email-by-default for a phone-holder. Managers/quria approve
// by email/Homebase; employees live on SMS.
//
// Several workflow send-paths implemented this rule ad hoc (decision.ts
// notifyEmployeeDecision, shift-swap sendSwapNotice) while others drifted to
// email-first (time-off pickDecisionRoute, availability notify, emergency
// coverage dispatchOutreach, day closure). This module is the single home for
// the rule so every notify path agrees and a future refactor can't silently
// re-introduce email-by-default. (DRIFT_REGISTER §H — Batch 1.)

export type NotifyChannel = 'sms' | 'email' | 'none';

// Resolve a company's Aegis outbound SMS number (company_channels,
// channel_type='sms'), or null when the tenant has none configured. Number-
// agnostic: each tenant's own Telnyx number lives here, resolved per-tenant.
export async function getAegisSmsChannel(companyId: string): Promise<string | null> {
  const { data } = await supabase
    .from('company_channels')
    .select('channel_value')
    .eq('company_id', companyId)
    .eq('channel_type', 'sms')
    .maybeSingle();
  return (data as { channel_value: string } | null)?.channel_value ?? null;
}

// THE employee-facing SMS-first notifier. Prefers SMS for a phone-holder when
// EMAIL_ONLY=false and the tenant has an Aegis SMS number; falls back to email
// on send failure or when SMS isn't possible. Returns the channel actually used
// ('none' when the employee is unreachable, so callers can log honestly).
export async function notifyEmployeeSmsFirst(opts: {
  company_id: string;
  smsChannel: string | null;
  phone: string | null;
  email: string | null;
  body: string;
  subject: string;
  thread_id?: string | null;
}): Promise<NotifyChannel> {
  if (!env.EMAIL_ONLY && opts.phone && opts.smsChannel) {
    const ok = await sendSms({ to: opts.phone, from: opts.smsChannel, body: opts.body, company_id: opts.company_id });
    if (ok) return 'sms';
    console.warn(`[notify] SMS send failed for company ${opts.company_id}; falling back to email`);
  }
  if (opts.email) {
    await sendEmail({
      to: opts.email,
      subject: opts.subject,
      text: opts.body,
      company_id: opts.company_id,
      thread_id: opts.thread_id ?? undefined,
    });
    return 'email';
  }
  console.error(`[notify] no channel available to deliver notice for company ${opts.company_id}`);
  return 'none';
}
