import { supabase } from '../db/client';
import type { Channel, InboundMessage, VerifiedContact } from './types';
import { checkQuriaStaff } from './quria-verification';

// Step 1: Given the inbound recipient channel value, resolve the company_id.
// Returns null if no matching channel is configured — caller logs and drops.
//
// Required DB row for email routing:
// INSERT INTO company_channels (company_id, channel_type, channel_value, is_active)
// VALUES ('<watermark_id>', 'email', 'aegis@quriasolutions.com', true);
async function resolveCompanyId(
  channelType: Channel,
  channelValue: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('company_channels')
    .select('company_id')
    .eq('channel_type', channelType)
    .eq('channel_value', channelValue)
    .maybeSingle();

  if (error) {
    console.error('[verification] company_channels lookup error:', error.message);
    return null;
  }
  if (data?.company_id) return data.company_id;

  // Email fallback: if no exact match for the recipient address, route to the
  // sole email-configured company when exactly one exists. Prevents silent
  // drops during early testing when the company_channels row may not yet be
  // set up. Only triggers for email (SMS routing is strict — wrong number
  // should never land in someone else's tenant).
  if (channelType === 'email') {
    const { data: emailChannels, error: fallbackErr } = await supabase
      .from('company_channels')
      .select('company_id')
      .eq('channel_type', 'email');

    if (fallbackErr) {
      console.error('[verification] email fallback lookup error:', fallbackErr.message);
      return null;
    }

    const uniqueCompanies = new Set(
      ((emailChannels ?? []) as { company_id: string }[]).map((r) => r.company_id)
    );

    if (uniqueCompanies.size === 1) {
      const fallbackCompanyId = [...uniqueCompanies][0];
      console.warn(
        `[verification] email fallback: no exact match for ${channelValue}, ` +
          `routing to sole email-configured company ${fallbackCompanyId}`
      );
      return fallbackCompanyId;
    }
  }

  return null;
}

// Step 2: Given a normalized sender identifier and company_id, find the contact.
// Queries employees (contact_phone, contact_email) and users (email) in parallel.
// Returns a VerifiedContact or null.
async function lookupContact(
  sender: string,
  companyId: string,
  channel: Channel
): Promise<VerifiedContact | null> {
  const [empResult, userResult] = await Promise.all([
    supabase
      .from('employees')
      .select('id, name, contact_phone, contact_email, company_id, active, aegis_access')
      .eq('company_id', companyId)
      .or(`contact_phone.eq.${sender},contact_email.eq.${sender}`)
      .eq('active', true)
      .maybeSingle(),
    supabase
      .from('users')
      .select('id, name, email, company_id')
      .eq('company_id', companyId)
      .eq('email', sender)
      .maybeSingle(),
  ]);

  if (empResult.data) {
    // aegis_access is the Homebase "Aegis Access" dial — source of truth for
    // Aegis authority, deliberately separate from users.role. Unknown/null
    // values default to 'employee' (least privilege).
    const access = empResult.data.aegis_access ?? 'employee';
    if (access === 'blocked') return null;

    return {
      role: access === 'manager' ? 'manager' : 'employee',
      company_id: companyId,
      employee_id: empResult.data.id,
      user_id: userResult.data?.id ?? null,
      name: empResult.data.name,
      matched_identifier: sender,
      channel,
    };
  }

  if (userResult.data) {
    return {
      role: 'manager',
      company_id: companyId,
      employee_id: null,
      user_id: userResult.data.id,
      name: userResult.data.name,
      matched_identifier: sender,
      channel,
    };
  }

  return null;
}

// Logs unknown or suspicious inbound attempts to security_events.
// company_id may be null if the recipient matched no configured channel.
async function logSecurityEvent(
  eventType: 'unknown_sender' | 'company_match_no_employee' | 'unauthorized_action' | 'suspicious_pattern',
  message: InboundMessage,
  companyId: string | null
): Promise<void> {
  const preview = message.body.slice(0, 200);
  const { error } = await supabase.from('security_events').insert({
    event_type: eventType,
    channel: message.channel,
    sender_contact: message.sender,
    message_preview: preview,
    resolution: 'blocked',
    company_id: companyId,
  });
  if (error) {
    console.error('[security] failed to write security_event:', error.message);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export type VerificationResult =
  | { ok: true; contact: VerifiedContact }
  | { ok: false; reason: 'unknown_channel' | 'unknown_sender' };

// Main verification gate. Call this before any business logic.
// Returns ok:false and has already logged to security_events — caller must
// return 200 with an empty body and halt all further processing.
export async function verifySender(message: InboundMessage): Promise<VerificationResult> {
  // 1. Resolve company from the inbound recipient channel
  const companyId = await resolveCompanyId(message.channel, message.recipient);

  if (!companyId) {
    await logSecurityEvent('unknown_sender', message, null);
    return { ok: false, reason: 'unknown_channel' };
  }

  // 2. Check if sender is a Quria staff member (cross-company admin access)
  const quriaStaff = await checkQuriaStaff({ channel: message.channel, identifier: message.sender });
  if (quriaStaff && quriaStaff.active) {
    return {
      ok: true,
      contact: {
        role: 'quria_admin',
        company_id: companyId,
        employee_id: null,
        user_id: null,
        name: quriaStaff.name,
        matched_identifier: message.sender,
        channel: message.channel,
        quria_staff_email: quriaStaff.email,
      },
    };
  }

  // 3. Look up the sender as a normal employee or manager within that company
  const contact = await lookupContact(message.sender, companyId, message.channel);

  if (!contact) {
    await logSecurityEvent('unknown_sender', message, companyId);
    return { ok: false, reason: 'unknown_sender' };
  }

  return { ok: true, contact };
}

// Specialized check for facilitated swap responses.
// Verifies that the responding sender is the exact number/email Aegis contacted.
// Uses aegis_conversations to find the most recent outbound message to the expected recipient.
export async function verifySwapRespondent(
  message: InboundMessage,
  expectedRecipient: string,
  swapRequestId: string
): Promise<boolean> {
  if (message.sender !== expectedRecipient) {
    await logSecurityEvent('suspicious_pattern', message, null);
    return false;
  }

  // Confirm Aegis actually sent an outbound swap message to this number for this request
  const { data } = await supabase
    .from('aegis_conversations')
    .select('id')
    .eq('direction', 'outbound')
    .eq('to_address', expectedRecipient)
    .contains('thread_id', swapRequestId)
    .limit(1)
    .maybeSingle();

  return data !== null;
}
