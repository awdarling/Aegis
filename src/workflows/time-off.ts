import { randomUUID } from 'crypto';
import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { reply } from '../messaging/reply';
import { sendEmail } from '../messaging/email';
import { sendSms } from '../messaging/sms';
import { generateReply } from '../ai/claude';
import { runSimulation, getWeekBounds, loadTimeOffPolicies } from '../lib/schedule-simulator';
import { env } from '../config/env';
import type { InboundMessage, VerifiedContact } from '../security/types';
import type { Employee, Policy } from '../db/types';
import type { SimulationResult } from '../lib/schedule-simulator';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PendingTimeOff {
  employee_id: string;
  start_date: string;
  end_date: string;
  reason: string;
  channel: 'sms' | 'email';
  sender: string;
  recipient: string;
  raw_subject?: string;
  thread_id?: string;
  expires_at: string;
}

interface DecisionRecommendation {
  recommendation: 'approve' | 'deny';
  reasoning: string;
  policy_notes: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDateRange(startDate: string, endDate: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  };
  const start = new Date(startDate + 'T12:00:00Z').toLocaleDateString('en-US', opts);
  if (startDate === endDate) return start;
  const end = new Date(endDate + 'T12:00:00Z').toLocaleDateString('en-US', opts);
  return `${start} through ${end}`;
}

function formatShortDate(dateStr: string): string {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

async function clearPendingTimeOff(companyId: string, employeeId: string): Promise<void> {
  await supabase
    .from('aegis_memory')
    .delete()
    .eq('company_id', companyId)
    .eq('source', `pending_to:${employeeId}`);
}

// ── Pending confirmation store ─────────────────────────────────────────────────
// Called by the router before intent classification.

export async function getPendingTimeOff(
  companyId: string,
  employeeId: string
): Promise<(PendingTimeOff & { _memory_id: string }) | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .eq('source', `pending_to:${employeeId}`)
    .maybeSingle();

  if (!data) return null;

  try {
    const row = data as { id: string; content: string };
    const pending = JSON.parse(row.content) as PendingTimeOff;
    if (new Date(pending.expires_at) < new Date()) {
      await supabase.from('aegis_memory').delete().eq('id', row.id);
      return null;
    }
    return { ...pending, _memory_id: row.id };
  } catch {
    return null;
  }
}

// ── AI recommendation ─────────────────────────────────────────────────────────

async function generateTimeOffRecommendation(
  employee: Employee,
  startDate: string,
  endDate: string,
  reason: string,
  stage1: SimulationResult,
  stage2: SimulationResult | null,
  policies: Policy[]
): Promise<DecisionRecommendation> {
  const systemPrompt =
    'You are Aegis, an AI workforce assistant. Analyze a time-off request and provide a recommendation. ' +
    'Respond with ONLY valid JSON, no markdown: ' +
    '{ "recommendation": "approve" | "deny", "reasoning": "2-3 sentences", "policy_notes": "relevant policy points or empty string" }';

  const policyText =
    policies.length > 0
      ? policies
          .map(p => `${p.policy_key}: ${p.policy_value}${p.description ? ` — ${p.description}` : ''}`)
          .join('\n')
      : 'No time-off policies configured.';

  const specialNotesText =
    stage1.special_notes_affecting_period.length > 0
      ? stage1.special_notes_affecting_period
          .map(e => `${e.title}: ${e.staffing_notes ?? e.description ?? ''}`)
          .join('\n')
      : 'None.';

  const context = [
    `Employee: ${employee.name}`,
    `Requested dates: ${startDate} to ${endDate}`,
    `Reason: ${reason}`,
    '',
    'STAGE 1 — Target day(s) simulation:',
    `  Feasible: ${stage1.overall_feasible}`,
    `  Coverage before: ${stage1.coverage_rate_before.toFixed(1)}%`,
    `  Coverage after: ${stage1.coverage_rate_after.toFixed(1)}%`,
    `  Coverage gaps: ${JSON.stringify(stage1.coverage_gaps)}`,
    '',
    stage2
      ? [
          'STAGE 2 — Full week simulation:',
          `  Feasible: ${stage2.overall_feasible}`,
          `  Coverage before: ${stage2.coverage_rate_before.toFixed(1)}%`,
          `  Coverage after: ${stage2.coverage_rate_after.toFixed(1)}%`,
          `  Coverage gaps: ${JSON.stringify(stage2.coverage_gaps)}`,
        ].join('\n')
      : 'STAGE 2: Not run (Stage 1 failed — no need to check full week).',
    '',
    `COMPANY POLICIES:\n${policyText}`,
    '',
    `SPECIAL NOTES / EVENTS FOR THIS PERIOD:\n${specialNotesText}`,
  ].join('\n');

  const responseText = await generateReply(systemPrompt, context, []);

  try {
    return JSON.parse(responseText) as DecisionRecommendation;
  } catch {
    // Structural fallback if Claude returns non-JSON
    const feasible = stage1.overall_feasible && (stage2?.overall_feasible ?? true);
    return {
      recommendation: feasible ? 'approve' : 'deny',
      reasoning: feasible
        ? 'Staffing levels appear sufficient to accommodate this request.'
        : 'This request would create staffing shortfalls that cannot be covered.',
      policy_notes: '',
    };
  }
}

// ── Manager email builder ─────────────────────────────────────────────────────

function buildManagerEmail(params: {
  employeeName: string;
  managerName: string;
  startDate: string;
  endDate: string;
  reason: string;
  stage1: SimulationResult;
  stage2: SimulationResult | null;
  recommendation: DecisionRecommendation;
  approveUrl: string;
  denyUrl: string;
  policies: Policy[];
}): { subject: string; text: string; html: string } {
  const {
    employeeName,
    managerName,
    startDate,
    endDate,
    reason,
    stage1,
    stage2,
    recommendation,
    approveUrl,
    denyUrl,
    policies,
  } = params;

  const dateDisplay = formatDateRange(startDate, endDate);
  const subject = `Time-Off Request — ${employeeName} (${formatShortDate(startDate)}${startDate !== endDate ? ` – ${formatShortDate(endDate)}` : ''})`;

  // Plain text version
  const text = [
    `Hi ${managerName},`,
    '',
    `${employeeName} has submitted a time-off request.`,
    '',
    `Employee:  ${employeeName}`,
    `Dates:     ${dateDisplay}`,
    `Reason:    ${reason}`,
    '',
    '── STAGE 1: TARGET DAY(S) ──',
    `Feasible: ${stage1.overall_feasible ? 'YES' : 'NO'}`,
    `Coverage: ${stage1.coverage_rate_before.toFixed(1)}% → ${stage1.coverage_rate_after.toFixed(1)}%`,
    stage1.coverage_gaps.length > 0
      ? `Gaps: ${stage1.coverage_gaps.map(g => `${g.shift_name} (${g.role}) on ${g.date}, short ${g.shortfall}`).join('; ')}`
      : 'No coverage gaps.',
    '',
    stage2
      ? [
          '── STAGE 2: FULL WEEK ──',
          `Feasible: ${stage2.overall_feasible ? 'YES' : 'NO'}`,
          `Coverage: ${stage2.coverage_rate_before.toFixed(1)}% → ${stage2.coverage_rate_after.toFixed(1)}%`,
          stage2.coverage_gaps.length > 0
            ? `Gaps: ${stage2.coverage_gaps.map(g => `${g.shift_name} (${g.role}) on ${g.date}, short ${g.shortfall}`).join('; ')}`
            : 'No coverage gaps.',
        ].join('\n')
      : '── STAGE 2: NOT RUN (Stage 1 failed) ──',
    '',
    stage1.available_alternates.length > 0
      ? `AVAILABLE ALTERNATES:\n${stage1.available_alternates.map(a => `  ${a.name} — ${a.qualified_roles.join(', ')} — available ${a.available_dates.join(', ')}`).join('\n')}`
      : 'No alternates identified for affected shifts.',
    '',
    stage1.special_notes_affecting_period.length > 0
      ? `SPECIAL NOTES:\n${stage1.special_notes_affecting_period.map(e => `  ${e.title}${e.staffing_notes ? ': ' + e.staffing_notes : ''}`).join('\n')}`
      : '',
    policies.length > 0
      ? `COMPANY POLICIES (time-off):\n${policies.map(p => `  ${p.policy_key}: ${p.policy_value}${p.description ? ' — ' + p.description : ''}`).join('\n')}`
      : '',
    '',
    `RECOMMENDATION: ${recommendation.recommendation.toUpperCase()}`,
    recommendation.reasoning,
    recommendation.policy_notes ? `Policy note: ${recommendation.policy_notes}` : '',
    '',
    `APPROVE: ${approveUrl}`,
    `DENY:    ${denyUrl}`,
    '',
    'These links expire in 7 days. — Aegis',
  ]
    .filter(l => l !== undefined)
    .join('\n');

  // HTML version
  const recColor = recommendation.recommendation === 'approve' ? '#16a34a' : '#dc2626';
  const recLabel = recommendation.recommendation === 'approve' ? 'APPROVE' : 'DENY';

  const gapRows = (sim: SimulationResult) =>
    sim.coverage_gaps.length === 0
      ? '<p style="color:#16a34a;margin:4px 0;">No coverage gaps.</p>'
      : sim.coverage_gaps
          .map(
            g =>
              `<p style="color:#dc2626;margin:4px 0;">&#9888; ${g.shift_name} (${g.role}) on ${g.date} — short ${g.shortfall} employee${g.shortfall !== 1 ? 's' : ''}</p>`
          )
          .join('');

  const alternatesHtml =
    (stage2 ?? stage1).available_alternates.length > 0
      ? `<ul style="margin:8px 0;padding-left:20px;">${(stage2 ?? stage1).available_alternates
          .map(
            a =>
              `<li><strong>${a.name}</strong> — ${a.qualified_roles.join(', ')} — available on ${a.available_dates.map(formatShortDate).join(', ')}</li>`
          )
          .join('')}</ul>`
      : '<p style="color:#6b7280;">No alternates identified for affected shifts.</p>';

  const specialNotesHtml =
    stage1.special_notes_affecting_period.length > 0
      ? `<ul style="margin:8px 0;padding-left:20px;">${stage1.special_notes_affecting_period
          .map(
            e =>
              `<li><strong>${e.title}</strong>${e.staffing_notes ? ': ' + e.staffing_notes : e.description ? ': ' + e.description : ''}</li>`
          )
          .join('')}</ul>`
      : '<p style="color:#6b7280;">None for this period.</p>';

  const policiesHtml =
    policies.length > 0
      ? `<ul style="margin:8px 0;padding-left:20px;">${policies
          .map(
            p =>
              `<li><strong>${p.policy_key}:</strong> ${p.policy_value}${p.description ? ' — ' + p.description : ''}</li>`
          )
          .join('')}</ul>`
      : '<p style="color:#6b7280;">No time-off policies configured.</p>';

  const html = `<!DOCTYPE html>
<html lang="en">
<body style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#111;">

<h2 style="margin:0 0 4px;font-size:20px;">Time-Off Request</h2>
<p style="margin:0 0 24px;color:#6b7280;font-size:14px;">Submitted by ${employeeName} and reviewed by Aegis</p>

<table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
  <tr><td style="padding:8px 12px;background:#f9fafb;font-weight:bold;width:100px;border:1px solid #e5e7eb;">Employee</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">${employeeName}</td></tr>
  <tr><td style="padding:8px 12px;background:#f9fafb;font-weight:bold;border:1px solid #e5e7eb;">Dates</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">${dateDisplay}</td></tr>
  <tr><td style="padding:8px 12px;background:#f9fafb;font-weight:bold;border:1px solid #e5e7eb;">Reason</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">${reason}</td></tr>
</table>

<h3 style="margin:0 0 8px;font-size:15px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;">Stage 1 — Target Day(s)</h3>
<p style="margin:4px 0;">Status: <strong style="color:${stage1.overall_feasible ? '#16a34a' : '#dc2626'};">${stage1.overall_feasible ? '&#10003; Staffable' : '&#10007; Cannot cover'}</strong></p>
<p style="margin:4px 0;color:#6b7280;font-size:13px;">Coverage: ${stage1.coverage_rate_before.toFixed(1)}% &rarr; ${stage1.coverage_rate_after.toFixed(1)}%</p>
${gapRows(stage1)}

${
  stage2
    ? `<h3 style="margin:20px 0 8px;font-size:15px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;">Stage 2 — Full Week</h3>
<p style="margin:4px 0;">Status: <strong style="color:${stage2.overall_feasible ? '#16a34a' : '#dc2626'};">${stage2.overall_feasible ? '&#10003; Staffable' : '&#10007; Cannot cover'}</strong></p>
<p style="margin:4px 0;color:#6b7280;font-size:13px;">Coverage: ${stage2.coverage_rate_before.toFixed(1)}% &rarr; ${stage2.coverage_rate_after.toFixed(1)}%</p>
${gapRows(stage2)}`
    : '<h3 style="margin:20px 0 8px;font-size:15px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;">Stage 2 — Full Week</h3><p style="color:#6b7280;">Not evaluated — Stage 1 already shows this request cannot be covered.</p>'
}

<h3 style="margin:20px 0 8px;font-size:15px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;">Available Alternates</h3>
${alternatesHtml}

<h3 style="margin:20px 0 8px;font-size:15px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;">Special Notes / Events</h3>
${specialNotesHtml}

<h3 style="margin:20px 0 8px;font-size:15px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;">Time-Off Policies</h3>
${policiesHtml}

<div style="background:#f9fafb;border:1px solid #e5e7eb;border-left:4px solid ${recColor};padding:16px;margin:24px 0;border-radius:4px;">
  <p style="margin:0 0 6px;font-weight:bold;font-size:15px;color:${recColor};">Aegis Recommendation: ${recLabel}</p>
  <p style="margin:0 0 6px;">${recommendation.reasoning}</p>
  ${recommendation.policy_notes ? `<p style="margin:0;color:#6b7280;font-size:13px;">${recommendation.policy_notes}</p>` : ''}
</div>

<div style="text-align:center;margin:32px 0;">
  <a href="${approveUrl}" style="background:#16a34a;color:#fff;padding:12px 32px;text-decoration:none;border-radius:6px;font-weight:bold;font-size:15px;margin:0 8px;display:inline-block;">&#10003; Approve</a>
  <a href="${denyUrl}" style="background:#dc2626;color:#fff;padding:12px 32px;text-decoration:none;border-radius:6px;font-weight:bold;font-size:15px;margin:0 8px;display:inline-block;">&#10007; Deny</a>
</div>

<p style="color:#9ca3af;font-size:12px;text-align:center;margin-top:32px;">These links expire in 7 days &bull; Generated by Aegis on behalf of your company</p>
</body>
</html>`;

  return { subject, text, html };
}

// ── Manager notification ───────────────────────────────────────────────────────

async function notifyManager(
  companyId: string,
  employee: Employee,
  pending: PendingTimeOff,
  requestId: string,
  stage1: SimulationResult,
  stage2: SimulationResult | null
): Promise<void> {
  // Find first manager/owner for this company
  const { data: managerData } = await supabase
    .from('users')
    .select('id, email, name, role')
    .eq('company_id', companyId)
    .in('role', ['manager', 'owner'])
    .order('role', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!managerData) {
    console.warn('[time-off] no manager/owner found for company', companyId);
    return;
  }

  const manager = managerData as { id: string; email: string; name: string; role: string };

  // Try to find manager's phone via their employee record
  const { data: managerEmpData } = await supabase
    .from('employees')
    .select('contact_phone')
    .eq('company_id', companyId)
    .eq('contact_email', manager.email)
    .maybeSingle();
  const managerPhone =
    (managerEmpData as { contact_phone: string | null } | null)?.contact_phone ?? null;

  // Find the company's Aegis SMS outbound number
  const { data: channelData } = await supabase
    .from('company_channels')
    .select('channel_value')
    .eq('company_id', companyId)
    .eq('channel_type', 'sms')
    .maybeSingle();
  const aegisSmsNumber =
    (channelData as { channel_value: string } | null)?.channel_value ?? null;

  // Load time-off policies for the email
  const policies = await loadTimeOffPolicies(companyId);

  // Create decision tokens (approve and deny are separate tokens)
  const approveToken = randomUUID();
  const denyToken = randomUUID();
  const tokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const sharedPayload = {
    request_id: requestId,
    company_id: companyId,
    employee_id: employee.id,
    employee_name: employee.name,
    employee_channel: pending.channel,
    employee_contact: pending.sender,
    aegis_sms_channel: aegisSmsNumber,
    expires_at: tokenExpiry,
  };

  await Promise.all([
    supabase.from('aegis_memory').insert({
      company_id: companyId,
      memory_type: 'observation',
      source: `decision_token:${approveToken}`,
      content: JSON.stringify({ ...sharedPayload, action: 'approve' }),
    }),
    supabase.from('aegis_memory').insert({
      company_id: companyId,
      memory_type: 'observation',
      source: `decision_token:${denyToken}`,
      content: JSON.stringify({ ...sharedPayload, action: 'deny' }),
    }),
  ]);

  const baseUrl = env.BASE_URL;
  const approveUrl = `${baseUrl}/webhooks/decision?action=approve&requestId=${requestId}&token=${approveToken}`;
  const denyUrl = `${baseUrl}/webhooks/decision?action=deny&requestId=${requestId}&token=${denyToken}`;

  // Generate AI recommendation
  const recommendation = await generateTimeOffRecommendation(
    employee,
    pending.start_date,
    pending.end_date,
    pending.reason,
    stage1,
    stage2,
    policies
  );

  // Persist recommendation so Homebase can display it
  await supabase
    .from('time_off_requests')
    .update({
      aegis_recommendation: recommendation.recommendation,
      aegis_reasoning: recommendation.reasoning,
    })
    .eq('id', requestId);

  // Build and send manager email
  const { subject, text, html } = buildManagerEmail({
    employeeName: employee.name,
    managerName: manager.name,
    startDate: pending.start_date,
    endDate: pending.end_date,
    reason: pending.reason,
    stage1,
    stage2,
    recommendation,
    approveUrl,
    denyUrl,
    policies,
  });

  await sendEmail({
    to: manager.email,
    subject,
    text,
    html,
    company_id: companyId,
  });

  // SMS alert — notification only, no analysis
  if (managerPhone && aegisSmsNumber) {
    const dateDisplay = formatDateRange(pending.start_date, pending.end_date);
    await sendSms({
      to: managerPhone,
      from: aegisSmsNumber,
      body:
        `${employee.name} submitted a time-off request for ${dateDisplay}. ` +
        `Full details and approval options are in your email from Aegis.`,
      company_id: companyId,
    });
  }
}

// ── Public workflow handlers ───────────────────────────────────────────────────

// Step 1: Employee submits request — parse, store pending, ask for confirmation.
export async function handleSubmitTimeOff(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  const startDate = extracted['start_date'] as string | undefined;
  const endDate = ((extracted['end_date'] ?? extracted['start_date']) as string | undefined);
  const reason = (extracted['reason'] as string | undefined) ?? 'personal reasons';

  if (!startDate) {
    await reply(
      contact,
      message,
      "I'd be happy to help with your time-off request! Could you let me know the specific date(s) you need off and the reason?"
    );
    return;
  }

  const end = endDate ?? startDate;

  // Store pending confirmation (TTL: 1 hour)
  const pendingData: PendingTimeOff = {
    employee_id: contact.employee_id!,
    start_date: startDate,
    end_date: end,
    reason,
    channel: message.channel,
    sender: message.sender,
    recipient: message.recipient,
    raw_subject: message.raw_subject,
    thread_id: message.thread_id,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };

  // Delete any stale pending confirmation before inserting
  await clearPendingTimeOff(contact.company_id, contact.employee_id!);
  await supabase.from('aegis_memory').insert({
    company_id: contact.company_id,
    memory_type: 'observation',
    source: `pending_to:${contact.employee_id}`,
    content: JSON.stringify(pendingData),
  });

  const dateDisplay = formatDateRange(startDate, end);
  await reply(
    contact,
    message,
    `Got it — you're requesting ${dateDisplay} off for ${reason}. Is that correct? (Reply "yes" to confirm or "no" to restate.)`
  );
}

// Step 2: Employee replies yes/no to confirmation — runs simulation and submits.
// Called by the router's pre-classification pending check.
export async function handlePendingTimeOffConfirmation(
  message: InboundMessage,
  contact: VerifiedContact,
  pending: PendingTimeOff
): Promise<void> {
  const body = message.body.trim().toLowerCase();

  const isYes =
    /^(yes|yeah|yep|y\b|correct|confirmed|confirm|that'?s right|right|ok|okay|sure)/.test(body);
  const isNo =
    /^(no|nope|n\b|wrong|incorrect|that'?s wrong|cancel|that'?s not right|nah)/.test(body);

  if (!isYes && !isNo) {
    await reply(
      contact,
      message,
      'Please reply "yes" to confirm your time-off request or "no" to resubmit with correct details.'
    );
    return;
  }

  if (isNo) {
    await clearPendingTimeOff(contact.company_id, contact.employee_id!);
    await reply(
      contact,
      message,
      'No problem! Please restate your time-off request with the correct dates and reason.'
    );
    return;
  }

  // Employee confirmed — clear pending state and proceed
  await clearPendingTimeOff(contact.company_id, contact.employee_id!);

  // Load employee record
  const { data: empData } = await supabase
    .from('employees')
    .select('*')
    .eq('id', contact.employee_id)
    .eq('company_id', contact.company_id)
    .single();

  const employee = empData as Employee | null;
  if (!employee) {
    await reply(
      contact,
      message,
      "I couldn't find your employee record. Please contact your manager directly."
    );
    return;
  }

  // Stage 1: simulate the specific requested day(s)
  let stage1: SimulationResult;
  try {
    stage1 = await runSimulation({
      company_id: contact.company_id,
      period_start: pending.start_date,
      period_end: pending.end_date,
      new_time_off: {
        employee_id: employee.id,
        start_date: pending.start_date,
        end_date: pending.end_date,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'NO_SHIFT_REQUIREMENTS') {
      await reply(
        contact,
        message,
        "Your request has been noted, but the scheduling system doesn't have shift requirements configured yet. " +
          'Please ask your manager to set up shift requirements in Homebase before submitting time-off requests.'
      );
      return;
    }
    throw err;
  }

  // Stage 2: full week — only runs if Stage 1 passes
  let stage2: SimulationResult | null = null;
  if (stage1.overall_feasible) {
    const { weekStart, weekEnd } = getWeekBounds(pending.start_date, pending.end_date);
    stage2 = await runSimulation({
      company_id: contact.company_id,
      period_start: weekStart,
      period_end: weekEnd,
      new_time_off: {
        employee_id: employee.id,
        start_date: pending.start_date,
        end_date: pending.end_date,
      },
    });
  }

  // Log to Homebase — create time_off_request with status: pending
  const { data: torData, error: torError } = await supabase
    .from('time_off_requests')
    .insert({
      employee_id: employee.id,
      company_id: contact.company_id,
      start_date: pending.start_date,
      end_date: pending.end_date,
      reason: pending.reason,
      status: 'pending',
      requested_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (torError || !torData) {
    console.error('[time-off] failed to create time_off_request:', torError);
    await reply(
      contact,
      message,
      'There was an issue saving your request. Please try again or contact your manager directly.'
    );
    return;
  }

  const requestId = (torData as { id: string }).id;

  await logActivity({
    company_id: contact.company_id,
    action: 'time_off_request_created',
    entity_type: 'time_off_request',
    entity_id: requestId,
    summary: `${employee.name} submitted time-off request: ${pending.start_date} to ${pending.end_date}`,
    metadata: {
      reason: pending.reason,
      stage1_feasible: stage1.overall_feasible,
      stage2_feasible: stage2?.overall_feasible ?? null,
      stage1_coverage_after: stage1.coverage_rate_after,
      stage2_coverage_after: stage2?.coverage_rate_after ?? null,
    },
  });

  // Notify manager (non-blocking — errors are caught and logged)
  try {
    await notifyManager(contact.company_id, employee, pending, requestId, stage1, stage2);
  } catch (err) {
    console.error('[time-off] manager notification failed:', err);
    await logActivity({
      company_id: contact.company_id,
      action: 'time_off_manager_notification_failed',
      entity_id: requestId,
      summary: 'Manager notification failed — request is still logged',
      metadata: { error: String(err) },
    });
  }

  const dateDisplay = formatDateRange(pending.start_date, pending.end_date);
  await reply(
    contact,
    message,
    `Your time-off request for ${dateDisplay} has been submitted and is pending manager approval. ` +
      "You'll be notified once a decision has been made."
  );
}

// Manager approval/denial via SMS or email message (redirects to email buttons)
export async function handleApproveTimeOff(
  message: InboundMessage,
  contact: VerifiedContact,
  _extracted: Record<string, unknown>
): Promise<void> {
  await reply(
    contact,
    message,
    'To approve a time-off request, please use the Approve button in your Aegis notification email. If you need help finding it, check your inbox for an email from Aegis.'
  );
}

export async function handleDenyTimeOff(
  message: InboundMessage,
  contact: VerifiedContact,
  _extracted: Record<string, unknown>
): Promise<void> {
  await reply(
    contact,
    message,
    'To deny a time-off request, please use the Deny button in your Aegis notification email. If you need help finding it, check your inbox for an email from Aegis.'
  );
}
