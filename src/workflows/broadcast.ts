import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { coerceJsonObject } from '../utils/coerce-json';
import { reply } from '../messaging/reply';
import { sendEmail } from '../messaging/email';
import { sendSms } from '../messaging/sms';
import { generateReply } from '../ai/claude';
import type { InboundMessage, VerifiedContact } from '../security/types';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BroadcastSession {
  company_id: string;
  admin_contact: string;
  admin_channel: 'sms' | 'email';
  admin_sender: string;
  admin_recipient: string;
  message_text: string;
  target_type: 'all' | 'managers' | 'employees' | 'role' | 'specific';
  target_role: string | null;
  target_ids: string[];
  channel: 'sms' | 'email' | 'both';
  resolved_recipients: Array<{
    employee_id: string;
    name: string;
    phone: string | null;
    email: string | null;
  }>;
  expires_at: string;
}

const MANAGER_ROLES = ['Manager', 'Assistant Manager'];

// ── Session store ─────────────────────────────────────────────────────────────

function sessionSource(adminContact: string): string {
  return `broadcast_session:${adminContact}`;
}

export async function getActiveBroadcastSession(
  companyId: string,
  adminContact: string
): Promise<(BroadcastSession & { _memory_id: string }) | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .eq('source', sessionSource(adminContact))
    .maybeSingle();

  if (!data) return null;
  try {
    const row = data as { id: string; content: string };
    const session = JSON.parse(row.content) as BroadcastSession;
    if (new Date(session.expires_at) < new Date()) {
      await supabase.from('aegis_memory').delete().eq('id', row.id);
      return null;
    }
    return { ...session, _memory_id: row.id };
  } catch {
    return null;
  }
}

async function storeBroadcastSession(session: BroadcastSession): Promise<void> {
  await supabase
    .from('aegis_memory')
    .delete()
    .eq('company_id', session.company_id)
    .eq('source', sessionSource(session.admin_contact));
  await supabase.from('aegis_memory').insert({
    company_id: session.company_id,
    memory_type: 'observation',
    source: sessionSource(session.admin_contact),
    content: JSON.stringify(session),
  });
}

async function clearBroadcastSession(companyId: string, adminContact: string): Promise<void> {
  await supabase
    .from('aegis_memory')
    .delete()
    .eq('company_id', companyId)
    .eq('source', sessionSource(adminContact));
}

// ── Recipient resolution ──────────────────────────────────────────────────────

async function resolveRecipients(
  companyId: string,
  targetType: BroadcastSession['target_type'],
  targetRole: string | null,
  targetNames: string[] | null
): Promise<BroadcastSession['resolved_recipients']> {
  type EmpRow = { id: string; name: string; contact_phone: string | null; contact_email: string | null; primary_role: string };
  type UserRow = { id: string; name: string; email: string };

  if (targetType === 'all') {
    const { data } = await supabase
      .from('employees')
      .select('id, name, contact_phone, contact_email')
      .eq('company_id', companyId)
      .eq('active', true);
    return (data ?? []).map((e: { id: string; name: string; contact_phone: string | null; contact_email: string | null }) => ({
      employee_id: e.id,
      name: e.name,
      phone: e.contact_phone,
      email: e.contact_email,
    }));
  }

  if (targetType === 'managers') {
    // Employees with management primary roles
    const { data: empData } = await supabase
      .from('employees')
      .select('id, name, contact_phone, contact_email, primary_role')
      .eq('company_id', companyId)
      .eq('active', true)
      .in('primary_role', MANAGER_ROLES);

    const empRecipients = (empData ?? []).map((e: EmpRow) => ({
      employee_id: e.id,
      name: e.name,
      phone: e.contact_phone,
      email: e.contact_email,
    }));

    // Also include users with manager/owner role not already in employee list
    const empEmails = new Set(empRecipients.map(r => r.email).filter(Boolean));
    const { data: userData } = await supabase
      .from('users')
      .select('id, name, email')
      .eq('company_id', companyId)
      .in('role', ['manager', 'owner']);

    const extraRecipients = (userData ?? [])
      .filter((u: UserRow) => !empEmails.has(u.email))
      .map((u: UserRow) => ({
        employee_id: u.id,
        name: u.name,
        phone: null as string | null,
        email: u.email,
      }));

    return [...empRecipients, ...extraRecipients];
  }

  if (targetType === 'employees') {
    const { data } = await supabase
      .from('employees')
      .select('id, name, contact_phone, contact_email, primary_role')
      .eq('company_id', companyId)
      .eq('active', true);
    return (data ?? [])
      .filter((e: EmpRow) => !MANAGER_ROLES.includes(e.primary_role))
      .map((e: EmpRow) => ({
        employee_id: e.id,
        name: e.name,
        phone: e.contact_phone,
        email: e.contact_email,
      }));
  }

  if (targetType === 'role' && targetRole) {
    const { data } = await supabase
      .from('employees')
      .select('id, name, contact_phone, contact_email, primary_role, qualified_roles')
      .eq('company_id', companyId)
      .eq('active', true)
      .or(`primary_role.eq.${targetRole},qualified_roles.cs.{${targetRole}}`);
    return (data ?? []).map((e: EmpRow) => ({
      employee_id: e.id,
      name: e.name,
      phone: e.contact_phone,
      email: e.contact_email,
    }));
  }

  if (targetType === 'specific' && targetNames && targetNames.length > 0) {
    const results: BroadcastSession['resolved_recipients'] = [];
    for (const name of targetNames) {
      const { data } = await supabase
        .from('employees')
        .select('id, name, contact_phone, contact_email')
        .eq('company_id', companyId)
        .eq('active', true)
        .ilike('name', `%${name}%`)
        .limit(1)
        .maybeSingle();
      if (data) {
        const row = data as { id: string; name: string; contact_phone: string | null; contact_email: string | null };
        results.push({
          employee_id: row.id,
          name: row.name,
          phone: row.contact_phone,
          email: row.contact_email,
        });
      }
    }
    return results;
  }

  return [];
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function handleBroadcast(
  message: InboundMessage,
  contact: VerifiedContact,
  _extracted: Record<string, unknown>
): Promise<void> {
  // Step 1: Extract broadcast parameters from the message
  const extractSystem =
    'You are extracting parameters from a broadcast message request sent by a Quria administrator. ' +
    'Return ONLY valid JSON: ' +
    '{ "message_text": "exact message to send", "target_type": "all|managers|employees|role|specific", ' +
    '"target_role": "RoleName or null", "target_names": ["Name1"] or null, "channel": "sms|email|both" }. ' +
    'Default channel to "sms" if not specified. ' +
    '"managers" = management staff only. "employees" = non-management staff only. ' +
    '"role" = specific job role (use target_role). "specific" = named individuals (use target_names). ' +
    '"all" = entire company.';

  const extractText = await generateReply(extractSystem, message.body, []);

  let params: {
    message_text: string;
    target_type: BroadcastSession['target_type'];
    target_role: string | null;
    target_names: string[] | null;
    channel: 'sms' | 'email' | 'both';
  };

  const parsedParams = coerceJsonObject<typeof params>(extractText);
  if (parsedParams) {
    params = parsedParams;
  } else {
    await reply(
      contact,
      message,
      "I couldn't parse that broadcast request. Try: \"Send 'Message text here' to all staff via SMS.\""
    );
    return;
  }

  // Step 2: Look up company name
  const { data: companyData } = await supabase
    .from('companies')
    .select('name')
    .eq('id', contact.company_id)
    .single();
  const companyName = (companyData as { name: string } | null)?.name ?? 'Your Company';

  // Step 3: Resolve recipients
  const recipients = await resolveRecipients(
    contact.company_id,
    params.target_type,
    params.target_role ?? null,
    params.target_names ?? null
  );

  if (recipients.length === 0) {
    await reply(
      contact,
      message,
      'No recipients found matching that criteria. Please check the target and try again.'
    );
    return;
  }

  // Step 4: Store session (TTL: 30 minutes)
  const session: BroadcastSession = {
    company_id: contact.company_id,
    admin_contact: contact.matched_identifier,
    admin_channel: contact.channel,
    admin_sender: message.sender,
    admin_recipient: message.recipient,
    message_text: params.message_text,
    target_type: params.target_type,
    target_role: params.target_role ?? null,
    target_ids: recipients.map(r => r.employee_id),
    channel: params.channel ?? 'sms',
    resolved_recipients: recipients,
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
  await storeBroadcastSession(session);

  // Step 5: Send confirmation preview to admin
  const previewNames = recipients.slice(0, 5).map(r => r.name).join(', ');
  const overflow = recipients.length > 5 ? `, and ${recipients.length - 5} more` : '';
  const channelLabel =
    session.channel === 'both' ? 'SMS + Email' :
    session.channel === 'email' ? 'Email' : 'SMS';

  await reply(
    contact,
    message,
    `Sending to ${recipients.length} recipient${recipients.length !== 1 ? 's' : ''} at ${companyName}:\n\n` +
    `'${session.message_text}'\n\n` +
    `Recipients: ${previewNames}${overflow}\n` +
    `Channel: ${channelLabel}\n\n` +
    `Reply YES to send or NO to cancel.`
  );
}

export async function handleBroadcastConfirmation(
  message: InboundMessage,
  contact: VerifiedContact,
  session: BroadcastSession & { _memory_id?: string }
): Promise<void> {
  const body = message.body.trim().toLowerCase();
  const isYes = /^(yes|yeah|yep|y\b|confirm|send|go ahead|do it|ok|okay|sure)/.test(body);
  const isNo = /^(no|nope|n\b|cancel|stop|abort)/.test(body);

  if (!isYes && !isNo) {
    await reply(contact, message, 'Reply YES to send the broadcast or NO to cancel.');
    return;
  }

  await clearBroadcastSession(contact.company_id, contact.matched_identifier);

  if (isNo) {
    await reply(contact, message, 'Broadcast cancelled.');
    return;
  }

  // Look up company name and outbound SMS number
  const [companyRes, channelRes] = await Promise.all([
    supabase.from('companies').select('name').eq('id', session.company_id).single(),
    supabase
      .from('company_channels')
      .select('channel_value')
      .eq('company_id', session.company_id)
      .eq('channel_type', 'sms')
      .maybeSingle(),
  ]);

  const companyName = (companyRes.data as { name: string } | null)?.name ?? 'Your Company';
  const aegisSmsNumber =
    (channelRes.data as { channel_value: string } | null)?.channel_value ?? null;

  let sentSms = 0;
  let sentEmail = 0;
  const failed: string[] = [];

  for (const recipient of session.resolved_recipients) {
    const wantSms = session.channel !== 'email';
    const wantEmail = session.channel !== 'sms';

    const canSms = wantSms && !!recipient.phone && !!aegisSmsNumber;
    const canEmail = wantEmail && !!recipient.email;

    if (!canSms && !canEmail) {
      failed.push(recipient.name);
      continue;
    }

    if (canSms) {
      await sendSms({
        to: recipient.phone!,
        from: aegisSmsNumber!,
        body: `${companyName}: ${session.message_text}`,
        company_id: session.company_id,
      });
      sentSms++;
    }

    if (canEmail) {
      await sendEmail({
        to: recipient.email!,
        subject: `Message from ${companyName}`,
        text: session.message_text,
        company_id: session.company_id,
      });
      sentEmail++;
    }
  }

  // Log to activity_log
  const preview = session.message_text.length > 50
    ? `${session.message_text.slice(0, 50)}...`
    : session.message_text;

  await logActivity({
    company_id: session.company_id,
    actor: 'quria_admin',
    action: 'quria_broadcast_sent',
    summary: `Quria broadcast sent to ${session.resolved_recipients.length} recipients at ${companyName}: "${preview}"`,
    metadata: {
      target_type: session.target_type,
      message_text: session.message_text,
      recipients_count: session.resolved_recipients.length,
      sent_sms: sentSms,
      sent_email: sentEmail,
      failed_count: failed.length,
      failed_names: failed,
    },
  });

  // Reply to admin
  const failedLine =
    failed.length > 0
      ? `\n${failed.length} could not be reached (no contact info): ${failed.join(', ')}`
      : '';

  await reply(
    contact,
    message,
    `Sent. ${sentSms} SMS delivered, ${sentEmail} emails sent.${failedLine}`
  );
}
