import { randomUUID } from 'crypto';
import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { reply, normalizeReSubject } from '../messaging/reply';
import { sendEmail } from '../messaging/email';
import { sendSms } from '../messaging/sms';
import { classifyIntent, generateReply } from '../ai/claude';
import { runSimulation, getWeekBounds, loadTimeOffPolicies as loadAllTimeOffPolicies } from '../lib/schedule-simulator';
import { computeTimeOffViolations } from '../lib/time-off-policies';
import { env } from '../config/env';
import { buildTimeOffManagerEmail, type TimeOffRecommendation } from './time-off-manager-email';
import type { InboundMessage, VerifiedContact } from '../security/types';
import type { Employee, PartialDayDetail, Policy, TimeOffRequest } from '../db/types';
import type { SimulationResult } from '../lib/schedule-simulator';
import type { TimeOffViolations } from '../lib/time-off-policies';

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
  time_off_type: 'full_day' | 'partial';
  partial_days: PartialDayDetail[] | null;
}

interface ExtractedDateEntry {
  start_date: string;
  end_date?: string | null;
  time_off_type?: 'full_day' | 'partial' | null;
  period_label?: 'morning' | 'afternoon' | 'evening' | null;
  start_time?: string | null;
  end_time?: string | null;
}

const PERIOD_TIMES: Record<'morning' | 'afternoon' | 'evening', { start: string; end: string }> = {
  morning: { start: '09:00', end: '13:00' },
  afternoon: { start: '13:00', end: '17:00' },
  evening: { start: '17:00', end: '21:00' },
};

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

function eachDateInRange(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  const cur = new Date(startDate + 'T12:00:00Z');
  const stop = new Date(endDate + 'T12:00:00Z');
  while (cur.getTime() <= stop.getTime()) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function resolvePartialWindow(entry: ExtractedDateEntry): { start_time: string; end_time: string } | null {
  if (entry.start_time && entry.end_time) {
    return { start_time: entry.start_time, end_time: entry.end_time };
  }
  if (entry.period_label && PERIOD_TIMES[entry.period_label]) {
    const period = PERIOD_TIMES[entry.period_label];
    return { start_time: period.start, end_time: period.end };
  }
  return null;
}

function normalizeExtractedDates(extracted: Record<string, unknown>): ExtractedDateEntry[] {
  const rawDates = extracted['dates'];
  if (Array.isArray(rawDates)) {
    return rawDates as ExtractedDateEntry[];
  }
  // Legacy fallback: top-level start_date/end_date with no partial info.
  const startDate = extracted['start_date'] as string | undefined;
  if (startDate) {
    return [
      {
        start_date: startDate,
        end_date: (extracted['end_date'] as string | undefined) ?? startDate,
        time_off_type: 'full_day',
        period_label: null,
        start_time: null,
        end_time: null,
      },
    ];
  }
  return [];
}

interface ParsedRequest {
  start_date: string;
  end_date: string;
  time_off_type: 'full_day' | 'partial';
  partial_days: PartialDayDetail[] | null;
}

function parseRequest(entries: ExtractedDateEntry[]): ParsedRequest | null {
  if (entries.length === 0) return null;

  const allDates: string[] = [];
  const partialDays: PartialDayDetail[] = [];
  let anyPartial = false;

  for (const entry of entries) {
    const start = entry.start_date;
    const end = entry.end_date ?? start;
    if (!start) continue;

    const dates = eachDateInRange(start, end);
    allDates.push(...dates);

    if (entry.time_off_type === 'partial') {
      anyPartial = true;
      const window = resolvePartialWindow(entry);
      // If we can't resolve a window for a partial entry, fall back to full_day for
      // those dates so we don't drop the request entirely.
      if (!window) continue;
      for (const date of dates) {
        partialDays.push({
          date,
          type: 'custom_hours',
          shift_id: null,
          shift_name: null,
          start_time: window.start_time,
          end_time: window.end_time,
        });
      }
    }
  }

  if (allDates.length === 0) return null;
  allDates.sort();

  return {
    start_date: allDates[0],
    end_date: allDates[allDates.length - 1],
    time_off_type: anyPartial && partialDays.length > 0 ? 'partial' : 'full_day',
    partial_days: anyPartial && partialDays.length > 0 ? partialDays : null,
  };
}

function formatTimeRange(start: string, end: string): string {
  return `${start}–${end}`;
}

function formatRequestSummary(parsed: ParsedRequest): string {
  const range = formatDateRange(parsed.start_date, parsed.end_date);
  if (parsed.time_off_type === 'full_day' || !parsed.partial_days || parsed.partial_days.length === 0) {
    return range;
  }
  // Compact summary: if all partial_days share one window, show once.
  const windows = new Set(
    parsed.partial_days.map(d => `${d.start_time ?? ''}|${d.end_time ?? ''}`)
  );
  if (windows.size === 1) {
    const sample = parsed.partial_days[0];
    if (sample.start_time && sample.end_time) {
      return `${range} (${formatTimeRange(sample.start_time, sample.end_time)})`;
    }
  }
  const perDay = parsed.partial_days
    .map(d =>
      d.start_time && d.end_time
        ? `${formatShortDate(d.date)} ${formatTimeRange(d.start_time, d.end_time)}`
        : formatShortDate(d.date)
    )
    .join(', ');
  return `${range} — partial (${perDay})`;
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

// Returns the bullet lines for the Policy Considerations section, or [] when
// the section should be omitted entirely (no violations, or no policies set).
function formatViolationLines(violations: TimeOffViolations | null): string[] {
  if (!violations) return [];
  const lines: string[] = [];
  if (violations.consecutiveDays?.exceeded) {
    const v = violations.consecutiveDays;
    lines.push(
      `Consecutive days off: ${v.totalSpan}-day contiguous block (combined with adjacent approved TOs), exceeding the ${v.limit}-day company limit.`
    );
  }
  if (violations.notice?.insufficient) {
    const v = violations.notice;
    const dayWord = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
    lines.push(
      `Notice period: Submitted ${dayWord(v.daysGiven)} before start date, less than the ${dayWord(v.daysRequired)} minimum.`
    );
  }
  return lines;
}

function buildManagerEmail(params: {
  employeeName: string;
  managerName: string;
  startDate: string;
  endDate: string;
  reason: string;
  stage1: SimulationResult | null;
  stage2: SimulationResult | null;
  recommendation: DecisionRecommendation | null;
  approveUrl: string;
  denyUrl: string;
  policies: Policy[];
  violations: TimeOffViolations | null;
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
    violations,
  } = params;
  const violationLines = formatViolationLines(violations);

  const dateDisplay = formatDateRange(startDate, endDate);
  const subject = `Time-Off Request — ${employeeName} (${formatShortDate(startDate)}${startDate !== endDate ? ` – ${formatShortDate(endDate)}` : ''})`;

  // Plain text version. Sim/alternates/recommendation sections are only
  // rendered when the simulator ran (stage1 non-null).
  const text = [
    `Hi ${managerName},`,
    '',
    `${employeeName} has submitted a time-off request.`,
    '',
    ...(violationLines.length > 0
      ? [
          '── POLICY CONSIDERATIONS ──',
          ...violationLines.map(l => `• ${l}`),
          '',
        ]
      : []),
    `Employee:  ${employeeName}`,
    `Dates:     ${dateDisplay}`,
    `Reason:    ${reason}`,
    '',
    ...(stage1
      ? [
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
        ]
      : []),
    policies.length > 0
      ? `COMPANY POLICIES (time-off):\n${policies.map(p => `  ${p.policy_key}: ${p.policy_value}${p.description ? ' — ' + p.description : ''}`).join('\n')}`
      : '',
    '',
    ...(recommendation
      ? [
          `RECOMMENDATION: ${recommendation.recommendation.toUpperCase()}`,
          recommendation.reasoning,
          recommendation.policy_notes ? `Policy note: ${recommendation.policy_notes}` : '',
          '',
        ]
      : []),
    `APPROVE: ${approveUrl}`,
    `DENY:    ${denyUrl}`,
    '',
    'These links expire in 7 days. — Aegis',
  ]
    .filter(l => l !== undefined)
    .join('\n');

  // HTML version
  const recColor = recommendation && recommendation.recommendation === 'approve' ? '#16a34a' : '#dc2626';
  const recLabel = recommendation && recommendation.recommendation === 'approve' ? 'APPROVE' : 'DENY';

  const gapRows = (sim: SimulationResult) =>
    sim.coverage_gaps.length === 0
      ? '<p style="color:#16a34a;margin:4px 0;">No coverage gaps.</p>'
      : sim.coverage_gaps
          .map(
            g =>
              `<p style="color:#dc2626;margin:4px 0;">&#9888; ${g.shift_name} (${g.role}) on ${g.date} — short ${g.shortfall} employee${g.shortfall !== 1 ? 's' : ''}</p>`
          )
          .join('');

  const altSource = stage2 ?? stage1;
  const alternatesHtml = altSource
    ? altSource.available_alternates.length > 0
      ? `<ul style="margin:8px 0;padding-left:20px;">${altSource.available_alternates
          .map(
            a =>
              `<li><strong>${a.name}</strong> — ${a.qualified_roles.join(', ')} — available on ${a.available_dates.map(formatShortDate).join(', ')}</li>`
          )
          .join('')}</ul>`
      : '<p style="color:#6b7280;">No alternates identified for affected shifts.</p>'
    : '';

  const specialNotesHtml = stage1
    ? stage1.special_notes_affecting_period.length > 0
      ? `<ul style="margin:8px 0;padding-left:20px;">${stage1.special_notes_affecting_period
          .map(
            e =>
              `<li><strong>${e.title}</strong>${e.staffing_notes ? ': ' + e.staffing_notes : e.description ? ': ' + e.description : ''}</li>`
          )
          .join('')}</ul>`
      : '<p style="color:#6b7280;">None for this period.</p>'
    : '';

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

${
  violationLines.length > 0
    ? `<div style="background:#fffbeb;border:1px solid #fde68a;border-left:4px solid #d97706;padding:14px 16px;margin:0 0 24px;border-radius:4px;">
  <p style="margin:0 0 8px;font-weight:bold;font-size:14px;color:#92400e;">&#9888; Policy Considerations</p>
  <ul style="margin:0;padding-left:20px;color:#92400e;font-size:14px;">${violationLines.map(l => `<li style="margin:2px 0;">${l}</li>`).join('')}</ul>
</div>`
    : ''
}

<table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
  <tr><td style="padding:8px 12px;background:#f9fafb;font-weight:bold;width:100px;border:1px solid #e5e7eb;">Employee</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">${employeeName}</td></tr>
  <tr><td style="padding:8px 12px;background:#f9fafb;font-weight:bold;border:1px solid #e5e7eb;">Dates</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">${dateDisplay}</td></tr>
  <tr><td style="padding:8px 12px;background:#f9fafb;font-weight:bold;border:1px solid #e5e7eb;">Reason</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">${reason}</td></tr>
</table>

${
  stage1
    ? `<h3 style="margin:0 0 8px;font-size:15px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;">Stage 1 — Target Day(s)</h3>
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
${specialNotesHtml}`
    : ''
}

<h3 style="margin:20px 0 8px;font-size:15px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;">Time-Off Policies</h3>
${policiesHtml}

${
  recommendation
    ? `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-left:4px solid ${recColor};padding:16px;margin:24px 0;border-radius:4px;">
  <p style="margin:0 0 6px;font-weight:bold;font-size:15px;color:${recColor};">Aegis Recommendation: ${recLabel}</p>
  <p style="margin:0 0 6px;">${recommendation.reasoning}</p>
  ${recommendation.policy_notes ? `<p style="margin:0;color:#6b7280;font-size:13px;">${recommendation.policy_notes}</p>` : ''}
</div>`
    : ''
}

<div style="text-align:center;margin:32px 0;">
  <a href="${approveUrl}" style="background:#16a34a;color:#fff;padding:12px 32px;text-decoration:none;border-radius:6px;font-weight:bold;font-size:15px;margin:0 8px;display:inline-block;">&#10003; Approve</a>
  <a href="${denyUrl}" style="background:#dc2626;color:#fff;padding:12px 32px;text-decoration:none;border-radius:6px;font-weight:bold;font-size:15px;margin:0 8px;display:inline-block;">&#10007; Deny</a>
</div>

<p style="color:#9ca3af;font-size:12px;text-align:center;margin-top:32px;">These links expire in 7 days &bull; Generated by Aegis on behalf of your company</p>
</body>
</html>`;

  return { subject, text, html };
}

// ── Decision notification (employee-facing) ───────────────────────────────────

// Called by the Homebase /api/aegis-action dispatcher (Phase 4) via the
// /internal/notify-to-decision endpoint after a manager clicks Approve/Deny in
// an aegis_action_tokens magic-link email and the TO status has been updated.
//
// Loads the TO + employee, picks the employee's best channel (email first,
// then SMS), sends the decision notification, and logs activity. Throws on
// hard failure so the calling endpoint can return 5xx with a clear error.
export async function sendDecisionNotification(
  requestId: string,
  decision: 'approved' | 'denied'
): Promise<{ channel: 'email' | 'sms'; sent_to: string }> {
  const { data: torData, error: torError } = await supabase
    .from('time_off_requests')
    .select('id, company_id, employee_id, start_date, end_date')
    .eq('id', requestId)
    .single();
  if (torError || !torData) {
    throw new Error(`time_off_request ${requestId} not found: ${torError?.message ?? 'no row'}`);
  }
  const tor = torData as {
    id: string;
    company_id: string;
    employee_id: string;
    start_date: string;
    end_date: string;
  };

  const { data: empData, error: empError } = await supabase
    .from('employees')
    .select('id, name, contact_email, contact_phone')
    .eq('id', tor.employee_id)
    .eq('company_id', tor.company_id)
    .single();
  if (empError || !empData) {
    throw new Error(`employee ${tor.employee_id} not found: ${empError?.message ?? 'no row'}`);
  }
  const employee = empData as { id: string; name: string; contact_email: string | null; contact_phone: string | null };

  const dateRange = formatDateRange(tor.start_date, tor.end_date);
  const text =
    decision === 'approved'
      ? `Your time-off request for ${dateRange} has been approved. Enjoy your time off!`
      : `Your time-off request for ${dateRange} has been denied. Please contact your manager if you have questions or would like to discuss alternatives.`;

  let channel: 'email' | 'sms';
  let sent_to: string;

  if (employee.contact_email) {
    // Lookup thread metadata persisted at TO creation so we thread back into
    // the original submit thread instead of starting a fresh conversation.
    const { data: metaRow } = await supabase
      .from('aegis_memory')
      .select('content')
      .eq('source', `to_thread:${requestId}`)
      .maybeSingle();
    let threadId: string | undefined;
    let rawSubject: string | undefined;
    if (metaRow) {
      try {
        const meta = JSON.parse((metaRow as { content: string }).content) as {
          thread_id?: string | null;
          raw_subject?: string | null;
        };
        threadId = meta.thread_id ?? undefined;
        rawSubject = meta.raw_subject ?? undefined;
      } catch {
        // Corrupted side row — proceed without threading.
      }
    }

    const subject = rawSubject
      ? normalizeReSubject(rawSubject)
      : `Your time-off request has been ${decision}`;

    await sendEmail({
      to: employee.contact_email,
      subject,
      text,
      company_id: tor.company_id,
      thread_id: threadId,
    });
    channel = 'email';
    sent_to = employee.contact_email;
  } else if (employee.contact_phone) {
    // SMS path needs the company's Aegis outbound number.
    const { data: channelRow } = await supabase
      .from('company_channels')
      .select('channel_value')
      .eq('company_id', tor.company_id)
      .eq('channel_type', 'sms')
      .maybeSingle();
    const aegisSmsChannel = (channelRow as { channel_value: string } | null)?.channel_value ?? null;
    if (!aegisSmsChannel) {
      throw new Error(
        `employee ${employee.id} has no email and company ${tor.company_id} has no Aegis SMS channel configured`
      );
    }
    const sent = await sendSms({
      to: employee.contact_phone,
      from: aegisSmsChannel,
      body: text,
      company_id: tor.company_id,
    });
    if (!sent) {
      throw new Error(`SMS send failed for employee ${employee.id}`);
    }
    channel = 'sms';
    sent_to = employee.contact_phone;
  } else {
    throw new Error(`employee ${employee.id} has neither contact_email nor contact_phone`);
  }

  await logActivity({
    company_id: tor.company_id,
    action: `time_off_${decision === 'approved' ? 'approved' : 'denied'}_notified`,
    entity_type: 'time_off_request',
    entity_id: requestId,
    summary: `${employee.name} notified that their time-off request for ${dateRange} was ${decision} (via ${channel})`,
    metadata: {
      employee_id: employee.id,
      decision,
      channel,
      sent_to,
    },
  });

  return { channel, sent_to };
}

// ── Manager notification ───────────────────────────────────────────────────────

async function notifyManager(
  companyId: string,
  employee: Employee,
  pending: PendingTimeOff,
  requestId: string,
  stage1: SimulationResult | null,
  stage2: SimulationResult | null,
  violations: TimeOffViolations | null
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
  const policies = await loadAllTimeOffPolicies(companyId);

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
    thread_id: pending.thread_id ?? null,
    raw_subject: pending.raw_subject ?? null,
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

  // Generate AI recommendation only when we have stage-1 coverage data; the
  // recommendation prompt embeds simulation stats and would fail without them.
  // When the simulator was skipped (no shift_requirements), the manager email
  // still goes out — just without the recommendation section.
  let recommendation: DecisionRecommendation | null = null;
  if (stage1) {
    recommendation = await generateTimeOffRecommendation(
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
  }

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
    violations,
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

// ── Manager notification — email-channel (new aegis_action_tokens path) ──────

// Fan out a rich HTML email with magic-link approve/deny buttons to every
// manager/owner with an email on file. Used only when the employee submitted
// via email (the existing notifyManager() handles SMS-channel submissions and
// is intentionally left untouched).
//
// Each manager gets their own pair of tokens so the consume audit identifies
// who clicked. The Aegis AI recommendation is generated once and persisted to
// time_off_requests, then included in every manager's email.
async function notifyManagersByEmail(
  companyId: string,
  companyName: string,
  employee: Employee,
  torRow: TimeOffRequest,
  pending: PendingTimeOff,
  stage1: SimulationResult | null,
  stage2: SimulationResult | null,
  violations: TimeOffViolations | null
): Promise<{ emailed: number; total_managers: number }> {
  const { data: managersData } = await supabase
    .from('users')
    .select('id, email, name, role')
    .eq('company_id', companyId)
    .in('role', ['manager', 'owner']);

  const managers = (managersData ?? []) as Array<{
    id: string;
    email: string | null;
    name: string;
    role: string;
  }>;
  const withEmail = managers.filter(m => !!m.email);

  if (withEmail.length === 0) {
    console.warn('[time-off] email-channel: no manager/owner with email on file for company', companyId);
    return { emailed: 0, total_managers: managers.length };
  }

  // Generate the Aegis recommendation once, only when stage-1 coverage data
  // exists — the recommendation prompt embeds simulation stats. When the
  // simulator was skipped (no shift_requirements), skip the recommendation
  // block but still send the manager email with everything else.
  let recommendation: TimeOffRecommendation | undefined;
  if (stage1) {
    try {
      const policies = await loadAllTimeOffPolicies(companyId);
      const decision = await generateTimeOffRecommendation(
        employee,
        pending.start_date,
        pending.end_date,
        pending.reason,
        stage1,
        stage2,
        policies
      );
      recommendation = { type: decision.recommendation, reasoning: decision.reasoning };

      await supabase
        .from('time_off_requests')
        .update({
          aegis_recommendation: decision.recommendation,
          aegis_reasoning: decision.reasoning,
        })
        .eq('id', torRow.id);
    } catch (err) {
      console.warn('[time-off] recommendation generation failed; sending without it:', err);
    }
  }

  // Prefer the full-week simulation (more context for the manager); fall back
  // to the target-day simulation if Stage 2 didn't run. May be null when the
  // simulator was skipped entirely.
  const simulation = stage2 ?? stage1;

  let emailed = 0;
  for (const manager of withEmail) {
    try {
      const { subject, text, html } = await buildTimeOffManagerEmail({
        time_off_request: torRow,
        employee,
        company_id: companyId,
        company_name: companyName,
        manager_email: manager.email!,
        manager_user_id: manager.id,
        simulation: simulation ?? undefined,
        recommendation,
        violations,
      });
      await sendEmail({
        to: manager.email!,
        subject,
        text,
        html,
        company_id: companyId,
      });
      emailed++;
    } catch (err) {
      console.error('[time-off] manager email failed for', manager.email, err);
    }
  }

  return { emailed, total_managers: managers.length };
}

// ── Public workflow handlers ───────────────────────────────────────────────────

// Step 1: Employee submits request — parse, store pending, ask for confirmation.
export async function handleSubmitTimeOff(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  const entries = normalizeExtractedDates(extracted);
  const parsed = parseRequest(entries);
  const reason = (extracted['reason'] as string | undefined) ?? 'personal reasons';

  if (!parsed) {
    await reply(
      contact,
      message,
      "I'd be happy to help with your time-off request! Could you let me know the specific date(s) you need off and the reason?"
    );
    return;
  }

  // Store pending confirmation (TTL: 1 hour)
  const pendingData: PendingTimeOff = {
    employee_id: contact.employee_id!,
    start_date: parsed.start_date,
    end_date: parsed.end_date,
    reason,
    channel: message.channel,
    sender: message.sender,
    recipient: message.recipient,
    raw_subject: message.raw_subject,
    thread_id: message.thread_id,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    time_off_type: parsed.time_off_type,
    partial_days: parsed.partial_days,
  };

  // Delete any stale pending confirmation before inserting
  await clearPendingTimeOff(contact.company_id, contact.employee_id!);
  await supabase.from('aegis_memory').insert({
    company_id: contact.company_id,
    memory_type: 'observation',
    source: `pending_to:${contact.employee_id}`,
    content: JSON.stringify(pendingData),
  });

  const summary = formatRequestSummary(parsed);
  await reply(
    contact,
    message,
    `Got it — you're requesting ${summary} off for ${reason}. Is that correct? (Reply "yes" to confirm or "no" to restate.)`
  );
}

// Step 2: Employee replies yes/no to confirmation — runs simulation and submits.
// Called by the router's pre-classification pending check.
export async function handlePendingTimeOffConfirmation(
  message: InboundMessage,
  contact: VerifiedContact,
  pending: PendingTimeOff
): Promise<void> {
  const trimmed = message.body.trim();

  // Explicit cancel must precede the yes/no regex below — "cancel" alone
  // matches the looser NO regex and would otherwise be funneled into the
  // restate path instead of getting a distinct "cleared" reply.
  if (/^\s*(start\s*over|cancel\s+pending)\b/i.test(trimmed)) {
    await clearPendingTimeOff(contact.company_id, contact.employee_id!);
    await reply(
      contact,
      message,
      "Cleared that pending one. Send me the new dates whenever you're ready."
    );
    return;
  }

  // Classify before yes/no: a new submit_time_off (e.g. "ok so I need Friday
  // off") would otherwise match the YES regex on its leading word and silently
  // consume the OLD pending while dropping the new dates.
  const { data: companyData } = await supabase
    .from('companies')
    .select('timezone')
    .eq('id', contact.company_id)
    .single();
  const companyTimezone =
    (companyData as { timezone: string | null } | null)?.timezone ?? 'America/New_York';
  const classification = await classifyIntent(message.body, contact.role, '', companyTimezone);

  if (classification.intent === 'submit_time_off') {
    const dateDisplay = formatDateRange(pending.start_date, pending.end_date);
    await reply(
      contact,
      message,
      `Looks like you've already got a time-off request waiting — ${dateDisplay}. ` +
        `Reply "yes" to send that one over to your manager, or "start over" to cancel it and submit a new one.`
    );
    return;
  }

  const body = trimmed.toLowerCase();

  const isYes =
    /^(yes|yeah|yep|y\b|correct|confirmed|confirm|that'?s right|right|ok|okay|sure)/.test(body);
  const isNo =
    /^(no|nope|n\b|wrong|incorrect|that'?s wrong|cancel|that'?s not right|nah)/.test(body);

  if (!isYes && !isNo) {
    await reply(
      contact,
      message,
      'Reply "yes" to confirm your time-off request, "no" to resubmit with different details, or "start over" to cancel it.'
    );
    return;
  }

  if (isNo) {
    await clearPendingTimeOff(contact.company_id, contact.employee_id!);
    await reply(
      contact,
      message,
      'No problem — go ahead and restate your time-off with the correct dates and reason.'
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

  // Stage 1: simulate the specific requested day(s). If the company hasn't
  // configured shift_requirements, the simulator throws NO_SHIFT_REQUIREMENTS;
  // swallow that case and continue with stage1Result=null so TO creation isn't
  // gated on scheduling setup. Coverage analysis is advisory, not a precondition.
  let stage1Result: SimulationResult | null = null;
  try {
    stage1Result = await runSimulation({
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
      console.log('[time-off] stage-1 simulator skipped — no shift_requirements configured', {
        company_id: contact.company_id,
      });
    } else {
      throw err;
    }
  }

  // Stage 2: full week — only runs if Stage 1 succeeded and is feasible.
  let stage2Result: SimulationResult | null = null;
  if (stage1Result && stage1Result.overall_feasible) {
    const { weekStart, weekEnd } = getWeekBounds(pending.start_date, pending.end_date);
    try {
      stage2Result = await runSimulation({
        company_id: contact.company_id,
        period_start: weekStart,
        period_end: weekEnd,
        new_time_off: {
          employee_id: employee.id,
          start_date: pending.start_date,
          end_date: pending.end_date,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'NO_SHIFT_REQUIREMENTS') {
        console.log('[time-off] stage-2 simulator skipped — no shift_requirements configured', {
          company_id: contact.company_id,
        });
      } else {
        throw err;
      }
    }
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
      time_off_type: pending.time_off_type ?? 'full_day',
      partial_days: pending.partial_days ?? null,
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

  // Persist the inbound email's thread metadata so sendDecisionNotification —
  // invoked by Homebase via /internal/notify-to-decision after a manager
  // clicks the magic link — can thread the approve/deny email back into the
  // original conversation. The decision_token (notifyManager / decision.ts)
  // path carries this via its own payload; this side row is for the
  // aegis_action_tokens path, which is fired by an external webhook and only
  // gets requestId + decision. JSON blob in aegis_memory.content — no
  // migration. Skipped for SMS submissions (no thread metadata to store).
  if (pending.channel === 'email' && (pending.thread_id || pending.raw_subject)) {
    await supabase.from('aegis_memory').insert({
      company_id: contact.company_id,
      memory_type: 'observation',
      source: `to_thread:${requestId}`,
      content: JSON.stringify({
        thread_id: pending.thread_id ?? null,
        raw_subject: pending.raw_subject ?? null,
      }),
    });
  }

  await logActivity({
    company_id: contact.company_id,
    action: 'time_off_request_created',
    entity_type: 'time_off_request',
    entity_id: requestId,
    summary: `${employee.name} submitted time-off request: ${pending.start_date} to ${pending.end_date}`,
    metadata: {
      reason: pending.reason,
      stage1_feasible: stage1Result?.overall_feasible ?? null,
      stage2_feasible: stage2Result?.overall_feasible ?? null,
      stage1_coverage_after: stage1Result?.coverage_rate_after ?? null,
      stage2_coverage_after: stage2Result?.coverage_rate_after ?? null,
    },
  });

  // Compute advisory policy violations (consecutive-days chain + notice period).
  // Does NOT block submission — violations are surfaced in the manager email
  // so they can factor into the approve/deny decision.
  let violations: TimeOffViolations | null = null;
  try {
    violations = await computeTimeOffViolations({
      employee_id: employee.id,
      start_date: pending.start_date,
      end_date: pending.end_date,
      company_id: contact.company_id,
    });
    console.log('[time-off] violations computed', violations);
  } catch (err) {
    console.warn('[time-off] violation computation failed; proceeding without:', err);
  }

  // Notify manager (non-blocking — errors are caught and logged).
  // Email-channel submissions get the rich aegis_action_tokens magic-link
  // email; SMS-channel submissions stay on the existing notifyManager path
  // (legacy ad-hoc token + manager SMS).
  try {
    if (pending.channel === 'email') {
      const torRow: TimeOffRequest = {
        id: requestId,
        employee_id: employee.id,
        company_id: contact.company_id,
        start_date: pending.start_date,
        end_date: pending.end_date,
        reason: pending.reason,
        status: 'pending',
        requested_at: new Date().toISOString(),
        decided_at: null,
        decided_by: null,
        aegis_recommendation: null,
        aegis_reasoning: null,
        time_off_type: pending.time_off_type ?? 'full_day',
        partial_days: pending.partial_days ?? null,
      };
      // Resolve company name once for the email header / payload.
      const { data: companyData } = await supabase
        .from('companies')
        .select('name')
        .eq('id', contact.company_id)
        .single();
      const companyName = (companyData as { name: string } | null)?.name ?? 'Your Company';

      await notifyManagersByEmail(
        contact.company_id,
        companyName,
        employee,
        torRow,
        pending,
        stage1Result,
        stage2Result,
        violations
      );
    } else {
      await notifyManager(contact.company_id, employee, pending, requestId, stage1Result, stage2Result, violations);
    }
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
    `Got it — I've sent your time-off for ${dateDisplay} to your manager. ` +
      "I'll let you know as soon as they decide."
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

// Employee asks: "What time off do I have approved?" — lists upcoming approved requests.
export async function handleQueryMyTimeOff(
  message: InboundMessage,
  contact: VerifiedContact,
  _extracted: Record<string, unknown>
): Promise<void> {
  if (!contact.employee_id) {
    await reply(
      contact,
      message,
      "I couldn't find your employee record. Please contact your manager directly."
    );
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  const { data } = await supabase
    .from('time_off_requests')
    .select('start_date, end_date, time_off_type, partial_days')
    .eq('employee_id', contact.employee_id)
    .eq('company_id', contact.company_id)
    .eq('status', 'approved')
    .gte('end_date', today)
    .order('start_date', { ascending: true });

  const rows = (data ?? []) as Array<{
    start_date: string;
    end_date: string;
    time_off_type: 'full_day' | 'partial' | null;
    partial_days: PartialDayDetail[] | null;
  }>;

  if (rows.length === 0) {
    await reply(
      contact,
      message,
      "You don't have any approved time off coming up. You can request time off by texting me the dates you need."
    );
    return;
  }

  const lines = rows.map(row => {
    const dateRange = formatDateRange(row.start_date, row.end_date);
    const parsed: ParsedRequest = {
      start_date: row.start_date,
      end_date: row.end_date,
      time_off_type: row.time_off_type === 'partial' ? 'partial' : 'full_day',
      partial_days: row.partial_days ?? null,
    };

    if (parsed.time_off_type === 'full_day' || !parsed.partial_days || parsed.partial_days.length === 0) {
      return `• ${dateRange}: Full day`;
    }

    const sample = parsed.partial_days[0];
    const allSame = parsed.partial_days.every(
      d => d.start_time === sample.start_time && d.end_time === sample.end_time && d.shift_name === sample.shift_name
    );

    if (allSame) {
      const detail = sample.shift_name
        ? sample.shift_name
        : sample.start_time && sample.end_time
          ? formatTimeRange(sample.start_time, sample.end_time)
          : 'partial';
      return `• ${dateRange}: Partial — ${detail}`;
    }

    const perDay = parsed.partial_days
      .map(d => {
        const label = d.shift_name
          ? d.shift_name
          : d.start_time && d.end_time
            ? formatTimeRange(d.start_time, d.end_time)
            : 'partial';
        return `${formatShortDate(d.date)} ${label}`;
      })
      .join(', ');
    return `• ${dateRange}: Partial — ${perDay}`;
  });

  const header =
    rows.length === 1
      ? 'You have 1 approved time off period coming up:'
      : `You have ${rows.length} approved time off periods coming up:`;

  await reply(contact, message, `${header}\n\n${lines.join('\n')}`);
}
