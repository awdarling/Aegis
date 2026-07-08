import { randomUUID } from 'crypto';
import { supabase } from '../db/client';
import { coerceJsonObject } from '../utils/coerce-json';
import { logActivity } from '../logger/activity-log';
import { reply, normalizeReSubject } from '../messaging/reply';
import { sendEmail } from '../messaging/email';
import { sendSms } from '../messaging/sms';
import { greeting } from '../messaging/greeting';
import { classifyIntent, generateReply } from '../ai/claude';
import { runSimulation, getWeekBounds, loadTimeOffPolicies as loadAllTimeOffPolicies } from '../lib/schedule-simulator';
import { computeTimeOffViolations } from '../lib/time-off-policies';
import { env } from '../config/env';
import { firstName } from '../messaging/greeting';
import {
  BRAND,
  brandedEmailShell,
  brandedButtonRow,
  brandActionCard,
} from '../messaging/brand';
import { buildTimeOffManagerEmail, buildTimeOffResolutionEmail, type TimeOffRecommendation } from './time-off-manager-email';
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

export function formatDateRange(startDate: string, endDate: string): string {
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

// Escape user-supplied / dynamic text before inlining into branded HTML.
function escapeHtmlTo(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

// Implicit operating-day bounds for partial time-off, kept in sync with
// PERIOD_TIMES (morning opens the day, evening closes it). Used to fill the open
// side of one-sided windows.
const DAY_OPEN = PERIOD_TIMES.morning.start;  // '09:00'
const DAY_CLOSE = PERIOD_TIMES.evening.end;   // '21:00'

export function resolvePartialWindow(entry: ExtractedDateEntry): { start_time: string; end_time: string } | null {
  if (entry.start_time && entry.end_time) {
    return { start_time: entry.start_time, end_time: entry.end_time };
  }
  // Open-ended partials: one side given → fill the other from the operating day.
  // "off after 4pm" → 16:00–close; "off before noon" / "off until 2pm" → open–12:00/14:00.
  if (entry.start_time && !entry.end_time) {
    return { start_time: entry.start_time, end_time: DAY_CLOSE };
  }
  if (!entry.start_time && entry.end_time) {
    return { start_time: DAY_OPEN, end_time: entry.end_time };
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

  const parsed = coerceJsonObject<DecisionRecommendation>(responseText);
  if (parsed) return parsed;

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

// ── Recompute (TO-RERUN-1) ────────────────────────────────────────────────────

export type RecomputeStatus =
  | 'recomputed'
  | 'skipped_no_requirements'
  | 'not_found'
  | 'already_decided';

export interface RecomputeRecommendationResult {
  status: RecomputeStatus;
  recommendation?: 'approve' | 'deny';
  reasoning?: string;
  policy_notes?: string;
  coverage_gap_count?: number;
}

// Re-run the coverage simulation + AI recommendation for an EXISTING time-off
// request against CURRENT state, and persist the refreshed recommendation.
//
// WHY THIS EXISTS (TO-REC-STALE): the recommendation a request carries was
// computed at submission time against whatever was approved THEN. runSimulation
// always re-reads the live approved-TO set (loadApprovedTimeOff) as its baseline,
// so calling this later — e.g. after a competing request was approved — yields a
// recommendation that accounts for everything currently approved. Surfaced via
// the Homebase "Re-run check" button, the email-card re-check link, and the
// conversational re-run command. Read-only w.r.t. the decision: it only rewrites
// aegis_recommendation / aegis_reasoning, never the request's status.
export async function recomputeTimeOffRecommendation(
  requestId: string
): Promise<RecomputeRecommendationResult> {
  const { data: torRow, error } = await supabase
    .from('time_off_requests')
    .select('*')
    .eq('id', requestId)
    .maybeSingle();
  if (error || !torRow) return { status: 'not_found' };

  const tor = torRow as {
    employee_id: string;
    company_id: string;
    start_date: string;
    end_date: string;
    reason: string | null;
    status: string;
    aegis_recommendation: 'approve' | 'deny' | null;
    aegis_reasoning: string | null;
  };

  // Click-guard: a re-check only makes sense while the request is still pending.
  // If it's already approved/denied, report that instead of recomputing — the
  // decision stands and the manager shouldn't be able to "re-run" a closed item.
  if (tor.status !== 'pending') {
    return {
      status: 'already_decided',
      recommendation: tor.aegis_recommendation ?? undefined,
      reasoning: tor.aegis_reasoning ?? undefined,
    };
  }

  const { data: employeeRow } = await supabase
    .from('employees')
    .select('*')
    .eq('id', tor.employee_id)
    .maybeSingle();
  if (!employeeRow) return { status: 'not_found' };

  const policies = await loadAllTimeOffPolicies(tor.company_id);

  // Stage 1 — the requested day(s), against the live approved-TO baseline.
  let stage1: SimulationResult | null = null;
  try {
    stage1 = await runSimulation({
      company_id: tor.company_id,
      period_start: tor.start_date,
      period_end: tor.end_date,
      new_time_off: { employee_id: tor.employee_id, start_date: tor.start_date, end_date: tor.end_date },
    });
  } catch (err) {
    if ((err instanceof Error ? err.message : String(err)) !== 'NO_SHIFT_REQUIREMENTS') throw err;
  }
  if (!stage1) return { status: 'skipped_no_requirements' };

  // Stage 2 — full week, only when stage 1 is feasible (mirrors the submit flow).
  let stage2: SimulationResult | null = null;
  if (stage1.overall_feasible) {
    const { weekStart, weekEnd } = getWeekBounds(tor.start_date, tor.end_date);
    try {
      stage2 = await runSimulation({
        company_id: tor.company_id,
        period_start: weekStart,
        period_end: weekEnd,
        new_time_off: { employee_id: tor.employee_id, start_date: tor.start_date, end_date: tor.end_date },
      });
    } catch (err) {
      if ((err instanceof Error ? err.message : String(err)) !== 'NO_SHIFT_REQUIREMENTS') throw err;
    }
  }

  const recommendation = await generateTimeOffRecommendation(
    employeeRow as Employee,
    tor.start_date,
    tor.end_date,
    tor.reason ?? '',
    stage1,
    stage2,
    policies
  );

  await supabase
    .from('time_off_requests')
    .update({
      aegis_recommendation: recommendation.recommendation,
      aegis_reasoning: recommendation.reasoning,
    })
    .eq('id', requestId);

  return {
    status: 'recomputed',
    recommendation: recommendation.recommendation,
    reasoning: recommendation.reasoning,
    policy_notes: recommendation.policy_notes,
    coverage_gap_count: stage1.coverage_gaps.length,
  };
}

// Deterministic Message-ID for a manager's copy of a TO request email, so the
// "Re-run check" reply can thread to it (TO-RERUN-1). `salt` makes a reply's own
// Message-ID unique while still referencing the original.
function toThreadMessageId(requestId: string, managerKey: string, salt?: number): string {
  const key = managerKey.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `<to-${requestId}-${key}${salt ? `.${salt}` : ''}@aegis.quriasolutions.com>`;
}

// Re-run the recommendation for a request AND reply to the manager IN THE SAME
// EMAIL THREAD as the original action-card email, with a refreshed card. Used by
// the email-card "Re-run check" magic-link so the back-and-forth stays in one
// chain (like the other workflows) instead of opening a new email / web page.
export async function recheckAndReplyToManager(args: {
  requestId: string;
  managerEmail: string;
  managerUserId?: string;
  managerName?: string;
}): Promise<RecomputeRecommendationResult> {
  const result = await recomputeTimeOffRecommendation(args.requestId);
  if (result.status !== 'recomputed') return result;

  const { data: torRow } = await supabase
    .from('time_off_requests').select('*').eq('id', args.requestId).maybeSingle();
  if (!torRow) return result;
  const tor = torRow as TimeOffRequest;

  const { data: employeeRow } = await supabase
    .from('employees').select('*').eq('id', tor.employee_id).maybeSingle();
  if (!employeeRow) return result;
  const employee = employeeRow as Employee;

  const { data: companyRow } = await supabase
    .from('companies').select('name').eq('id', tor.company_id).maybeSingle();
  const companyName = (companyRow as { name: string } | null)?.name ?? 'Your team';

  // Re-run the sim once more purely to populate the email's coverage section
  // (the recommendation itself was already refreshed + persisted above).
  let simulation: SimulationResult | undefined;
  try {
    const stage1 = await runSimulation({
      company_id: tor.company_id, period_start: tor.start_date, period_end: tor.end_date,
      new_time_off: { employee_id: tor.employee_id, start_date: tor.start_date, end_date: tor.end_date },
    });
    simulation = stage1;
    if (stage1.overall_feasible) {
      const { weekStart, weekEnd } = getWeekBounds(tor.start_date, tor.end_date);
      try {
        simulation = await runSimulation({
          company_id: tor.company_id, period_start: weekStart, period_end: weekEnd,
          new_time_off: { employee_id: tor.employee_id, start_date: tor.start_date, end_date: tor.end_date },
        });
      } catch { /* keep stage1 */ }
    }
  } catch { /* NO_SHIFT_REQUIREMENTS — no coverage section */ }

  let violations: TimeOffViolations | null = null;
  try {
    violations = await computeTimeOffViolations({
      employee_id: employee.id, start_date: tor.start_date, end_date: tor.end_date, company_id: tor.company_id,
    });
  } catch { /* advisory only */ }

  const recommendation: TimeOffRecommendation | undefined = result.recommendation
    ? { type: result.recommendation, reasoning: result.reasoning ?? '' }
    : undefined;

  const { subject, text, html } = await buildTimeOffManagerEmail({
    time_off_request: tor,
    employee,
    company_id: tor.company_id,
    company_name: companyName,
    manager_email: args.managerEmail,
    manager_user_id: args.managerUserId,
    manager_name: args.managerName,
    simulation,
    recommendation,
    violations,
  });

  const threadKey = args.managerUserId ?? args.managerEmail;
  await sendEmail({
    to: args.managerEmail,
    subject: normalizeReSubject(subject),
    text,
    html,
    company_id: tor.company_id,
    in_reply_to: toThreadMessageId(tor.id, threadKey),
    message_id: toThreadMessageId(tor.id, threadKey, Date.now()),
  });

  return result;
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
  const employeeFirst = firstName(employeeName);

  // Plain text version. Sim/alternates/recommendation sections are only
  // rendered when the simulator ran (stage1 non-null).
  const text = [
    greeting(managerName),
    '',
    `${employeeFirst} just put in a time-off request, and I've taken a first pass at the coverage picture for you. ` +
      `The details are below — either link records your decision right away, and I'll let ${employeeFirst} know which way it went, so there's nothing else you'll need to do.`,
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
    'Approve this request:',
    approveUrl,
    '',
    'Deny this request:',
    denyUrl,
    '',
    "These links expire in 7 days, and I'll take it from there. — Aegis",
  ]
    .filter(l => l !== undefined)
    .join('\n');

  // ── Branded (Quria dark theme) HTML ──────────────────────────────────────
  // Mirrors time-off-manager-email.ts: conclusion-first intro above the action
  // card; all actionable detail + Approve/Deny buttons live inside one
  // brandActionCard. Colors are BRAND tokens throughout.

  // Conclusion-first intro — the whole ask sits above the card.
  const introHtml = `
<p style="margin:0 0 12px;font-size:16px;color:${BRAND.textPrimary};">${escapeHtmlTo(greeting(managerName))}</p>
<p style="margin:0;font-size:16px;color:${BRAND.textPrimary};line-height:1.65;">${escapeHtmlTo(employeeFirst)} just put in a time-off request, and I've taken a first pass at the coverage picture for you. Everything's in the card below — either button records your decision right away, and I'll let ${escapeHtmlTo(employeeFirst)} know which way it went, so there's nothing else you'll need to do.</p>`;

  // Policy considerations — warn-tinted callout (omitted when no violations).
  const policyConsiderationsHtml =
    violationLines.length > 0
      ? `
<div style="margin:0 0 20px;">
  <div style="font-size:13px;font-weight:600;color:${BRAND.warnText};text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Policy considerations</div>
  <div style="padding:14px 16px;background:${BRAND.warnBg};border:1px solid ${BRAND.warnBorder};border-left:4px solid ${BRAND.warnRule};border-radius:8px;">
    <ul style="margin:0;padding-left:18px;">${violationLines
      .map(l => `<li style="margin:0 0 6px;font-size:14px;color:${BRAND.warnText};">${escapeHtmlTo(l)}</li>`)
      .join('')}</ul>
  </div>
</div>`
      : '';

  // Request details — dark surface card.
  const requestDetailsHtml = `
<div style="margin:0 0 20px;padding:16px;background:${BRAND.surface2};border:1px solid ${BRAND.borderDefault};border-radius:8px;">
  <div style="font-size:14px;color:${BRAND.textPrimary};"><strong>Employee:</strong> ${escapeHtmlTo(employeeName)}</div>
  <div style="font-size:14px;color:${BRAND.textPrimary};margin-top:8px;"><strong>Dates:</strong> ${escapeHtmlTo(dateDisplay)}</div>
  <div style="font-size:14px;color:${BRAND.textPrimary};margin-top:8px;"><strong>Reason:</strong> ${escapeHtmlTo(reason)}</div>
</div>`;

  // Coverage simulation gaps (good = no gaps, bad = shortfalls).
  const gapRowsTo = (sim: SimulationResult) =>
    sim.coverage_gaps.length === 0
      ? `<div style="padding:12px 14px;background:${BRAND.goodBg};border:1px solid ${BRAND.goodBorder};border-radius:8px;font-size:14px;color:${BRAND.goodText};">No coverage gaps.</div>`
      : `<ul style="margin:6px 0 0;padding-left:18px;">${sim.coverage_gaps
          .map(
            g =>
              `<li style="margin:0 0 6px;font-size:14px;color:${BRAND.badText};"><strong>${escapeHtmlTo(g.shift_name)} (${escapeHtmlTo(g.role)}) on ${escapeHtmlTo(g.date)}</strong> — short ${g.shortfall} employee${g.shortfall !== 1 ? 's' : ''}</li>`
          )
          .join('')}</ul>`;

  const stageHeading = (text: string) =>
    `<div style="font-size:13px;font-weight:600;color:${BRAND.silver};text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px;">${escapeHtmlTo(text)}</div>`;

  const stageStatus = (sim: SimulationResult) => {
    const ok = sim.overall_feasible;
    const fg = ok ? BRAND.goodText : BRAND.badText;
    return `<div style="font-size:14px;color:${BRAND.textPrimary};margin:0 0 4px;">Status: <strong style="color:${fg};">${ok ? 'Staffable' : 'Cannot cover'}</strong></div>
<div style="font-size:13px;color:${BRAND.textSecondary};margin:0 0 8px;">Coverage: ${sim.coverage_rate_before.toFixed(1)}% &rarr; ${sim.coverage_rate_after.toFixed(1)}%</div>`;
  };

  const altSource = stage2 ?? stage1;
  const alternatesHtml = altSource
    ? altSource.available_alternates.length > 0
      ? `<ul style="margin:6px 0 0;padding-left:18px;">${altSource.available_alternates
          .map(
            a =>
              `<li style="margin:0 0 6px;font-size:14px;color:${BRAND.textPrimary};"><strong>${escapeHtmlTo(a.name)}</strong> — ${escapeHtmlTo(a.qualified_roles.join(', '))} — available on ${a.available_dates.map(d => escapeHtmlTo(formatShortDate(d))).join(', ')}</li>`
          )
          .join('')}</ul>`
      : `<div style="font-size:14px;color:${BRAND.textSecondary};">No alternates identified for affected shifts.</div>`
    : '';

  const specialNotesHtml = stage1
    ? stage1.special_notes_affecting_period.length > 0
      ? `<ul style="margin:6px 0 0;padding-left:18px;">${stage1.special_notes_affecting_period
          .map(
            e =>
              `<li style="margin:0 0 6px;font-size:14px;color:${BRAND.textPrimary};"><strong>${escapeHtmlTo(e.title)}</strong>${e.staffing_notes ? ': ' + escapeHtmlTo(e.staffing_notes) : e.description ? ': ' + escapeHtmlTo(e.description) : ''}</li>`
          )
          .join('')}</ul>`
      : `<div style="font-size:14px;color:${BRAND.textSecondary};">None for this period.</div>`
    : '';

  const coverageHtml = stage1
    ? `
<div style="margin:0 0 20px;">
  ${stageHeading('Stage 1 — target day(s)')}
  ${stageStatus(stage1)}
  ${gapRowsTo(stage1)}
</div>
<div style="margin:0 0 20px;">
  ${stageHeading('Stage 2 — full week')}
  ${
    stage2
      ? `${stageStatus(stage2)}${gapRowsTo(stage2)}`
      : `<div style="font-size:14px;color:${BRAND.textSecondary};">Not evaluated — Stage 1 already shows this request cannot be covered.</div>`
  }
</div>
<div style="margin:0 0 20px;">
  ${stageHeading('Available alternates')}
  ${alternatesHtml}
</div>
<div style="margin:0 0 20px;">
  ${stageHeading('Special notes / events')}
  ${specialNotesHtml}
</div>`
    : '';

  const policiesHtml = `
<div style="margin:0 0 20px;">
  ${stageHeading('Time-off policies')}
  ${
    policies.length > 0
      ? `<ul style="margin:6px 0 0;padding-left:18px;">${policies
          .map(
            p =>
              `<li style="margin:0 0 6px;font-size:14px;color:${BRAND.textPrimary};"><strong>${escapeHtmlTo(p.policy_key)}:</strong> ${escapeHtmlTo(p.policy_value)}${p.description ? ' — ' + escapeHtmlTo(p.description) : ''}</li>`
          )
          .join('')}</ul>`
      : `<div style="font-size:14px;color:${BRAND.textSecondary};">No time-off policies configured.</div>`
  }
</div>`;

  // Aegis recommendation — accent-left card with a status pill.
  const recommendationHtml = recommendation
    ? (() => {
        const isApprove = recommendation.recommendation === 'approve';
        const fg = isApprove ? BRAND.goodText : BRAND.badText;
        const bg = isApprove ? BRAND.goodBg : BRAND.badBg;
        const border = isApprove ? BRAND.goodBorder : BRAND.badBorder;
        const label = isApprove ? 'Approve' : 'Deny';
        return `
<div style="margin:0 0 20px;">
  ${stageHeading('Aegis recommendation')}
  <div style="padding:14px 16px;background:${BRAND.surface2};border:1px solid ${BRAND.borderDefault};border-left:4px solid ${fg};border-radius:8px;">
    <span style="display:inline-block;padding:4px 10px;font-size:12px;font-weight:600;background:${bg};color:${fg};border:1px solid ${border};border-radius:9999px;margin-bottom:8px;">${label}</span>
    <div style="font-size:14px;color:${BRAND.textPrimary};line-height:1.5;">${escapeHtmlTo(recommendation.reasoning)}</div>
    ${recommendation.policy_notes ? `<div style="font-size:13px;color:${BRAND.textSecondary};margin-top:6px;">${escapeHtmlTo(recommendation.policy_notes)}</div>` : ''}
  </div>
</div>`;
      })()
    : '';

  // Buttons live inside the action card — Approve is the primary orange action,
  // Deny the cautious silver outline.
  const ctaHtml = `
<div style="border-top:1px solid ${BRAND.borderDefault};margin:6px 0 0;padding-top:18px;">
${brandedButtonRow([
  { url: approveUrl, label: 'Approve', variant: 'primary' },
  { url: denyUrl, label: 'Deny', variant: 'secondary' },
])}
  <div style="font-size:13px;color:${BRAND.textMuted};margin:2px 0 6px;">These links expire in 7 days.</div>
</div>`;

  const cardInner = `${policyConsiderationsHtml}
${requestDetailsHtml}
${coverageHtml}
${policiesHtml}
${recommendationHtml}
${ctaHtml}`;

  const bodyHtml = `${introHtml}
${brandActionCard('Action needed · Time off', cardInner)}`;

  const html = brandedEmailShell({
    bodyHtml,
    preheader: `Time-off request from ${employeeName} — ${dateDisplay}`,
  });

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
  const greetingLine = greeting(employee.name);
  const text =
    decision === 'approved'
      ? `${greetingLine}\n\nYour time-off request for ${dateRange} has been approved. Enjoy your time off!`
      : `${greetingLine}\n\nYour time-off request for ${dateRange} has been denied. Please contact your manager if you have questions or would like to discuss alternatives.`;

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
  } else if (employee.contact_phone && !env.EMAIL_ONLY) {
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
  } else if (env.EMAIL_ONLY && employee.contact_phone) {
    // Email-only mode + no email on file: SMS is disabled, so this employee is
    // currently unreachable. Log and skip the notice rather than throw — the
    // time-off decision itself already succeeded; only the notification is skipped.
    console.warn(
      `[time-off] EMAIL_ONLY: employee ${employee.id} has a phone but no email; SMS disabled — decision notice skipped.`
    );
    channel = 'email';
    sent_to = employee.contact_phone;
  } else {
    throw new Error(`employee ${employee.id} has neither contact_email nor contact_phone`);
  }

  await logActivity({
    company_id: tor.company_id,
    action: `time_off_${decision === 'approved' ? 'approved' : 'denied'}_notified`,
    entity_type: 'time_off_request',
    entity_id: requestId,
    summary: `Let ${employee.name} know their time-off request for ${dateRange} was ${decision}`,
    metadata: {
      employee_id: employee.id,
      decision,
      channel,
      sent_to,
    },
  });

  // Cap each manager's email thread with a "✓ Resolved" reply so the inbox shows
  // the item is handled and the OTHER managers know action was taken (TO-RERUN-1).
  // Best-effort — never let this fail the employee notification.
  try {
    await sendManagerResolutionReplies({
      requestId,
      companyId: tor.company_id,
      employeeName: employee.name,
      dateRange,
      decision,
    });
  } catch (err) {
    console.warn('[time-off] manager resolution replies failed:', err);
  }

  return { channel, sent_to };
}

// Reply "✓ Resolved" into each manager's original request thread once a decision
// is recorded (by any channel). Threads via the deterministic Message-ID stamped
// on the original email. Notifies all managers (not just the actor) so a fan-out
// request doesn't leave others acting on a closed item.
async function sendManagerResolutionReplies(args: {
  requestId: string;
  companyId: string;
  employeeName: string;
  dateRange: string;
  decision: 'approved' | 'denied';
}): Promise<void> {
  // Who decided it (for "approved by …").
  const { data: torRow } = await supabase
    .from('time_off_requests').select('decided_by').eq('id', args.requestId).maybeSingle();
  const decidedById = (torRow as { decided_by: string | null } | null)?.decided_by ?? null;
  let decidedByName: string | undefined;
  if (decidedById) {
    const { data: u } = await supabase
      .from('users').select('name').eq('id', decidedById).maybeSingle();
    decidedByName = (u as { name: string | null } | null)?.name ?? undefined;
  }

  const { data: companyRow } = await supabase
    .from('companies').select('name').eq('id', args.companyId).maybeSingle();
  const companyName = (companyRow as { name: string } | null)?.name ?? 'Your team';

  // Only actual club managers/owners get the resolution notice — NOT 'quria'
  // platform admins, whose users row exists for company-scoped access, not to
  // receive operational manager email. (Matches every other manager lookup.)
  const { data: managersData } = await supabase
    .from('users').select('id, email, name').eq('company_id', args.companyId)
    .in('role', ['manager', 'owner']);
  const managers = ((managersData ?? []) as { id: string; email: string | null; name: string | null }[])
    .filter(m => !!m.email);

  for (const m of managers) {
    try {
      const { subject, html, text } = buildTimeOffResolutionEmail({
        employeeName: args.employeeName,
        managerName: m.name ?? undefined,
        dateRange: args.dateRange,
        decision: args.decision,
        decidedByName,
        companyName,
      });
      await sendEmail({
        to: m.email!,
        subject: normalizeReSubject(subject),
        html,
        text,
        company_id: args.companyId,
        in_reply_to: toThreadMessageId(args.requestId, m.id),
        message_id: toThreadMessageId(args.requestId, m.id, Date.now()),
      });
    } catch (err) {
      console.warn('[time-off] resolution reply failed for', m.email, err);
    }
  }
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

  // SMS alert — notification only, no analysis (the manager email above always
  // sends; this is additive and skipped entirely in email-only mode).
  if (!env.EMAIL_ONLY && managerPhone && aegisSmsNumber) {
    const dateDisplay = formatDateRange(pending.start_date, pending.end_date);
    await sendSms({
      to: managerPhone,
      from: aegisSmsNumber,
      body:
        `${greeting(manager.name)} ${employee.name} submitted a time-off request for ${dateDisplay}. ` +
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
        manager_name: manager.name,
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
        // Stamp a deterministic Message-ID so a later "Re-run check" reply
        // threads under this email in the manager's inbox (TO-RERUN-1).
        message_id: toThreadMessageId(torRow.id, manager.id),
      });
      emailed++;
    } catch (err) {
      console.error('[time-off] manager email failed for', manager.email, err);
    }
  }

  return { emailed, total_managers: managers.length };
}

// When an employee packs a time-off request AND their availability into one
// message, we confirm only the time-off here and ask them to send the availability
// on its own (the classifier sets also_mentions_availability). Pure + tested.
export function availabilityFollowupNote(extracted: Record<string, unknown>): string {
  return extracted?.['also_mentions_availability'] === true
    ? `\n\nP.S. — I also saw you included your availability. Send that to me in its own message (like "I can work Monday and Wednesday mornings") and I'll set it up — I kept this one focused on your time off so nothing gets crossed.`
    : '';
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
    `${greeting(contact.name)}\n\nGot it — you're requesting ${summary} off for ${reason}. Is that correct? (Reply "yes" to confirm or "no" to restate.)` +
      availabilityFollowupNote(extracted)
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
    summary: `${employee.name} submitted a time-off request for ${formatDateRange(pending.start_date, pending.end_date)}`,
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
    `${greeting(contact.name)}\n\nGot it — I've sent your time-off for ${dateDisplay} to your manager. ` +
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
      `${greeting(contact.name)}\n\nYou don't have any approved time off coming up. You can request time off by texting me the dates you need.`
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

  await reply(contact, message, `${greeting(contact.name)}\n\n${header}\n\n${lines.join('\n')}`);
}

// Manager asks: "re-run the check on Shmubba's time off" / "recheck the time off
// for June 26" / "is that time off still ok to approve?" — TO-RERUN-1.
//
// Resolves the relevant PENDING time-off request (scoped to the manager's
// company, matched by extracted employee name and/or date), re-runs the coverage
// sim + recommendation via recomputeTimeOffRecommendation, and reports the
// refreshed recommendation in Aegis's warm voice. Does NOT change the request's
// status — recompute + report only.
export async function handleRecheckTimeOff(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  const employeeName = (extracted['employee_name'] as string | undefined)?.trim() || null;
  const date = (extracted['date'] as string | undefined)?.trim() || null;

  // Pull all pending requests for the company, joined to the employee for name
  // matching. Most-recent first so the "pick the latest" tiebreak is trivial.
  const { data: pendingRows } = await supabase
    .from('time_off_requests')
    .select('id, employee_id, start_date, end_date, requested_at, employees(name)')
    .eq('company_id', contact.company_id)
    .eq('status', 'pending')
    .order('requested_at', { ascending: false });

  type PendingRow = {
    id: string;
    employee_id: string;
    start_date: string;
    end_date: string;
    requested_at: string | null;
    employees: { name: string } | { name: string }[] | null;
  };

  const rows = (pendingRows ?? []) as PendingRow[];

  const nameOf = (row: PendingRow): string => {
    const emp = Array.isArray(row.employees) ? row.employees[0] : row.employees;
    return emp?.name ?? '';
  };

  // Filter by extracted entities. Name match is a case-insensitive substring on
  // either side (handles "Shmubba" against "Shmubba Jones" and vice versa).
  // Date match: the requested range must cover the mentioned date.
  let candidates = rows;
  if (employeeName) {
    const needle = employeeName.toLowerCase();
    candidates = candidates.filter(row => {
      const hay = nameOf(row).toLowerCase();
      return hay.includes(needle) || needle.includes(hay);
    });
  }
  if (date) {
    candidates = candidates.filter(row => row.start_date <= date && date <= row.end_date);
  }

  if (candidates.length === 0) {
    const scope =
      employeeName && date
        ? ` matching ${employeeName} around ${formatShortDate(date)}`
        : employeeName
          ? ` for ${employeeName}`
          : date
            ? ` around ${formatShortDate(date)}`
            : '';
    await reply(
      contact,
      message,
      `${greeting(contact.name)}\n\nI looked but couldn't find a pending time-off request${scope} to re-check. ` +
        "It may have already been approved or denied. If you can point me at the employee or the dates, I'll take another look."
    );
    return;
  }

  // candidates is already sorted most-recent-first; take the latest pending.
  const target = candidates[0];
  const targetName = nameOf(target) || 'that employee';
  const targetFirst = firstName(targetName);
  const dateDisplay = formatDateRange(target.start_date, target.end_date);

  // Note when we had to disambiguate so the manager knows which one we acted on.
  const pickedNote =
    candidates.length > 1
      ? ` You had a few pending — I went with the most recent, ${targetFirst}'s for ${dateDisplay}.`
      : '';

  const result = await recomputeTimeOffRecommendation(target.id);

  if (result.status === 'not_found') {
    await reply(
      contact,
      message,
      `${greeting(contact.name)}\n\nI started to re-check ${targetFirst}'s time off for ${dateDisplay}, but the request seems to have gone missing on me — it may have just been acted on. Mind giving it another try in a moment?`
    );
    return;
  }

  if (result.status === 'skipped_no_requirements') {
    await reply(
      contact,
      message,
      `${greeting(contact.name)}\n\nI re-checked ${targetFirst}'s time off for ${dateDisplay}, but there's no shift schedule to measure it against yet — so I can't speak to coverage either way.${pickedNote} Once shift requirements are set up, I'll be able to give you a real read.`
    );
    return;
  }

  // status === 'recomputed'
  const gaps = result.coverage_gap_count ?? 0;
  const lean =
    result.recommendation === 'approve'
      ? gaps > 0
        ? `I'd still lean toward approving it — it'd leave ${gaps} coverage gap${gaps === 1 ? '' : 's'}, but nothing that should hold it up`
        : "I'd still lean toward approving it — coverage holds up fine with everything that's been approved so far"
      : gaps > 0
        ? `I'd now lean toward NOT approving it: it'd leave ${gaps} coverage gap${gaps === 1 ? '' : 's'}`
        : "I'd now lean toward NOT approving it";

  const tail =
    result.recommendation === 'approve'
      ? ' Want me to hold while you decide, or are you good to approve it?'
      : ' Want me to deny it, or hold for now?';

  await reply(
    contact,
    message,
    `${greeting(contact.name)}\n\nRe-checked ${targetName}'s time off for ${dateDisplay} against everything approved so far — ${lean}.${pickedNote}${tail}`
  );
}
