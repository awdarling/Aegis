import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { coerceJsonObject } from '../utils/coerce-json';
import { reply } from '../messaging/reply';
import { sendEmail } from '../messaging/email';
import { sendSms } from '../messaging/sms';
import { notifyEmployeeSmsFirst } from '../messaging/notify';
import { env } from '../config/env';
import { generateReply } from '../ai/claude';
import type { InboundMessage, VerifiedContact } from '../security/types';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BroadcastSession {
  company_id: string;
  admin_contact: string;
  admin_channel: 'sms' | 'email';
  admin_sender: string;
  admin_recipient: string;
  // Who is sending — the actual manager's or quria admin's name (employee-facing
  // attribution: "<SenderName>: <message>", not the company name — Batch-1 F4) and
  // their role (for the activity-log actor).
  sender_name: string;
  sender_role: 'manager' | 'quria_admin';
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
  const isQuria = contact.role === 'quria_admin';

  // Step 1: Extract broadcast parameters from the message
  const extractSystem =
    `You are extracting parameters from a broadcast message request sent by a ${isQuria ? 'Quria administrator' : 'manager'}. ` +
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

  // A manager may broadcast to their OWN company — all staff, their employees, a
  // role, or specific people — but targeting MANAGERS specifically stays a
  // quria-admin action (Batch-1 F4). Redirect rather than silently widening scope.
  if (!isQuria && params.target_type === 'managers') {
    await reply(
      contact,
      message,
      "Messaging the management team specifically is a Quria-admin action. You can message all staff, your employees, a specific role, or named people — tell me which and I'll set it up.",
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
    sender_name: contact.name?.trim() || (isQuria ? 'Quria' : companyName),
    sender_role: isQuria ? 'quria_admin' : 'manager',
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
    session.channel === 'both' ? 'Text + email' :
    session.channel === 'email' ? 'Email' : 'Text (email if no mobile on file)';

  const recipientCount = `${recipients.length} ${recipients.length === 1 ? 'teammate' : 'teammates'}`;
  await reply(
    contact,
    message,
    `Here's what I'll send to ${recipientCount} at ${companyName}:\n\n` +
    `"${session.message_text}"\n\n` +
    `To: ${previewNames}${overflow}\n` +
    `How: ${channelLabel}\n\n` +
    `Reply YES to send it, or NO to call it off.`
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
  // Employee-facing attribution is the SENDER's name (the manager or quria admin),
  // not the company name (Batch-1 F4). Fall back to the company name only if a
  // sender name somehow wasn't captured (older sessions).
  const senderName = session.sender_name?.trim() || companyName;

  let sentSms = 0;
  let sentEmail = 0;
  // Two distinct failure buckets so the manager gets an honest report (Batch-1.5
  // #13): "noContact" = nobody to reach (no phone AND no email on file); "failed"
  // = had a contact method but the send didn't go through.
  const noContact: string[] = [];
  const deliveryFailed: string[] = [];

  const outBody = `${senderName}: ${session.message_text}`;
  const outSubject = `Message from ${senderName}`;

  for (const recipient of session.resolved_recipients) {
    // Explicit "email" broadcast → email only. Explicit "both" → text AND email.
    // Everything else (the default / "sms") → SMS-first with email fallback, so an
    // email-only teammate is reached by email instead of being dropped as "no
    // contact info" (Batch-1.5 #13 root cause).
    if (session.channel === 'email') {
      if (!recipient.email) { noContact.push(recipient.name); continue; }
      const ok = await sendEmail({ to: recipient.email, subject: outSubject, text: outBody, company_id: session.company_id });
      if (ok) sentEmail++; else deliveryFailed.push(recipient.name);
      continue;
    }

    if (session.channel === 'both') {
      let any = false;
      if (!env.EMAIL_ONLY && recipient.phone && aegisSmsNumber) {
        const ok = await sendSms({ to: recipient.phone, from: aegisSmsNumber, body: outBody, company_id: session.company_id, employee_id: recipient.employee_id });
        if (ok) { sentSms++; any = true; }
      }
      if (recipient.email) {
        const ok = await sendEmail({ to: recipient.email, subject: outSubject, text: outBody, company_id: session.company_id });
        if (ok) { sentEmail++; any = true; }
      }
      if (!any) {
        (recipient.phone || recipient.email ? deliveryFailed : noContact).push(recipient.name);
      }
      continue;
    }

    // Default / "sms": one message per recipient, SMS-first + email fallback.
    const used = await notifyEmployeeSmsFirst({
      company_id: session.company_id,
      smsChannel: aegisSmsNumber,
      phone: recipient.phone,
      email: recipient.email,
      body: outBody,
      subject: outSubject,
      employee_id: recipient.employee_id,
    });
    if (used === 'sms') sentSms++;
    else if (used === 'email') sentEmail++;
    else (recipient.phone || recipient.email ? deliveryFailed : noContact).push(recipient.name);
  }

  const failed = [...noContact, ...deliveryFailed];

  // Log to activity_log
  const preview = session.message_text.length > 50
    ? `${session.message_text.slice(0, 50)}...`
    : session.message_text;

  const actor = session.sender_role === 'quria_admin' ? 'quria_admin' : 'manager';
  await logActivity({
    company_id: session.company_id,
    actor,
    actor_name: senderName,
    action: session.sender_role === 'quria_admin' ? 'quria_broadcast_sent' : 'manager_broadcast_sent',
    summary: `${session.sender_role === 'quria_admin' ? 'Quria' : 'Manager'} broadcast by ${senderName} sent to ${session.resolved_recipients.length} recipients at ${companyName}: "${preview}"`,
    metadata: {
      sender_name: senderName,
      sender_role: session.sender_role,
      target_type: session.target_type,
      message_text: session.message_text,
      recipients_count: session.resolved_recipients.length,
      sent_sms: sentSms,
      sent_email: sentEmail,
      failed_count: failed.length,
      failed_names: failed,
      no_contact_names: noContact,
      delivery_failed_names: deliveryFailed,
    },
  });

  // Reply to admin — warm, and honest about who (if anyone) didn't get it.
  const reached = sentSms + sentEmail;
  const parts: string[] = [];
  if (sentSms > 0) parts.push(`${sentSms} by text`);
  if (sentEmail > 0) parts.push(`${sentEmail} by email`);
  const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  const headline =
    reached > 0
      ? `Done — your message went out to ${reached} ${reached === 1 ? 'teammate' : 'teammates'}${breakdown}.`
      : `I couldn't reach anyone with that broadcast.`;

  const noContactLine =
    noContact.length > 0
      ? `\n${noContact.length} ${noContact.length === 1 ? 'has' : 'have'} no phone or email on file: ${noContact.join(', ')}.`
      : '';
  const failedLine =
    deliveryFailed.length > 0
      ? `\n${deliveryFailed.length} couldn't be reached just now (delivery failed): ${deliveryFailed.join(', ')}.`
      : '';

  await reply(contact, message, `${headline}${noContactLine}${failedLine}`);
}
