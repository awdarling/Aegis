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
import { firstName, textOpener, managerAlertSms } from '../messaging/greeting';
import {
  BRAND,
  brandedEmailShell,
  brandedButtonRow,
  brandActionCard,
  brandReflect,
  brandDetailRow,
} from '../messaging/brand';
import { buildTimeOffManagerEmail, buildTimeOffResolutionEmail, describePartialDay, buildPartialSummaryText, type TimeOffRecommendation } from './time-off-manager-email';
import { resolveManagers, recipientsFor } from '../messaging/manager-directory';
import { sendManagerResolutionNotice } from '../messaging/manager-resolution-notice';
import { tenantTodayAndZone, addDays, minutesUntilTenantTime } from '../lib/tenant-date';
import type { InboundMessage, VerifiedContact } from '../security/types';
import type { Employee, PartialDayDetail, Policy, TimeOffRequest } from '../db/types';
import type { SimulationResult } from '../lib/schedule-simulator';
import type { TimeOffViolations } from '../lib/time-off-policies';
import { resolveMeantHours, loadShiftTemplates, formatClock, formatClockRange, loadAssignmentsOnDate, type ShiftTemplate } from '../lib/shift-hours';
import { parseReasonEdit } from '../lib/confirm-edits';

// ── N1: self-notification guard ───────────────────────────────────────────────
// Exclude the actor who TOOK a decision from that decision's notification
// recipients, so the deciding manager isn't told about their own action. Keyed
// by `users.id`. A null actorId (unattributed — e.g. the shared magic-link path
// where `decided_by` is NULL, Data Contract D17) excludes nobody, so everyone is
// still notified. Pure + exported so the exclusion is unit-testable without the
// supabase-heavy fan-out around it.
export function excludeActor<T extends { id: string }>(
  recipients: T[],
  actorId: string | null | undefined
): T[] {
  return actorId ? recipients.filter((r) => r.id !== actorId) : recipients;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface PendingTimeOff {
  employee_id: string;
  start_date: string;
  end_date: string;
  reason: string | null;
  channel: 'sms' | 'email';
  sender: string;
  recipient: string;
  raw_subject?: string;
  thread_id?: string;
  expires_at: string;
  time_off_type: 'full_day' | 'partial';
  partial_days: PartialDayDetail[] | null;
  // W-2 call-out (spec §3.5): set when the request is for today/tomorrow AND the
  // employee has a PUBLISHED shift on one of those days. Changes the employee
  // copy (pending-not-granted), the manager email (three buttons), and the
  // manager nudge (near-shift escalation). Absent on an ordinary request.
  call_out?: CallOutShift[];
  // The employee's actual words — the spec says the manager sees them verbatim.
  employee_words?: string;
}

// W-2 — one shift the employee is calling out of. Deterministic: read from the
// published schedule, never inferred from clock words (F10).
export interface CallOutShift {
  date: string;
  shift_name: string;
  role: string;
  start_time: string; // HH:MM or HH:MM:SS as stored
  end_time: string;
}

export interface ExtractedDateEntry {
  start_date: string;
  end_date?: string | null;
  time_off_type?: 'full_day' | 'partial' | null;
  period_label?: 'morning' | 'afternoon' | 'evening' | null;
  start_time?: string | null;
  end_time?: string | null;
  // W-1 branch 2: filled by resolvePartialEntries from the employee's REAL shift
  // that day (never from a clock-word table).
  shift_id?: string | null;
  shift_name?: string | null;
  // The employee asked for part of a day they are not scheduled on. There is no
  // shift to take off; the confirm says so and offers to log a plain day off.
  unscheduled?: boolean;
}

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

// Decision (Alexander, 2026-08-26): a reason the employee did not give is NULL,
// never "personal reasons". The classifier already returns null when nothing was
// said; this also catches the model echoing the old default.
export function normalizeReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  if (/^(personal reasons?|no reason( given)?|none|n\/a|unspecified|not (?:given|stated|specified))$/i.test(t)) return null;
  return t;
}

// The one manager-facing rendering of a missing reason.
export const NO_REASON_GIVEN = 'no reason given';
export function reasonForManager(reason: string | null | undefined): string {
  return normalizeReason(reason) ?? NO_REASON_GIVEN;
}

// C-7: "Tuesday August 26th" when Aug 26 is a Wednesday. Returns " (that's a
// Wednesday)" when the employee named a weekday next to a date that resolved to
// a different weekday; '' otherwise. Deterministic; exported for tests.
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export function weekdayMismatchNote(body: string, dates: string[]): string {
  const t = (body || '').toLowerCase();
  const named = WEEKDAYS.filter(d => new RegExp(`\\b${d}\\b`).test(t));
  if (named.length !== 1 || dates.length === 0) return '';
  const namedIdx = WEEKDAYS.indexOf(named[0]);
  // Only flag when NONE of the extracted dates falls on the named weekday — a
  // range that spans the named day is fine.
  const actual = [...new Set(dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).map(d => new Date(`${d}T12:00:00Z`).getUTCDay()))];
  if (actual.length === 0 || actual.includes(namedIdx)) return '';
  if (actual.length !== 1) return '';
  const cap = (w: string) => w[0].toUpperCase() + w.slice(1);
  return ` (that's a ${cap(WEEKDAYS[actual[0]])})`;
}

// Natural yes/no for the time-off confirmation ("Want me to send that over?").
// The confirmation is human now, so a literal "yes" is no longer required —
// "yeah send it", "go for it", "please do", "sounds good" all confirm, and "not
// quite", "hold on", "change it" all decline. Exported + pure for testing. A
// reply that carries NEW dates is caught earlier as a submit_time_off correction
// and never reaches here.
export function isTimeOffAffirmation(body: string): boolean {
  const b = body.trim().toLowerCase();
  return /^(yes|yeah|yea|yep|yup|y\b|correct|confirmed|confirm|that'?s right|right|ok|okay|sure|send(?: it| that| it over)?|go (?:ahead|for it)|do it|please do|please|sounds good|looks good|that works|perfect|great|👍)/.test(b);
}

export function isTimeOffDenial(body: string): boolean {
  const b = body.trim().toLowerCase();
  return /^(no|nope|nah|n\b|wrong|incorrect|that'?s wrong|that'?s not right|not (?:quite|right|yet)|cancel|change|redo|restate|wait|hold on|don'?t)/.test(b);
}

// A mid-flow CANCELLATION (drop the whole request) — distinct from a correction
// ("no, make it Thursday"). Word-boundary (NOT anchored), so a variety of natural
// phrasings clear the pending: "changed my mind, I don't need it", "never mind",
// "don't want time off", "forget it", "cancel". Scoped so a date correction like
// "no, I don't need Friday, just Thursday" is NOT caught. Deterministic — no LLM.
export function isTimeOffCancellation(body: string): boolean {
  const b = body.trim().toLowerCase();
  if (/\b(chang(?:e|ed)\s+my\s+mind|never\s?mind|nvm|scratch\s+that|forget\s+(?:it|that|the\s+time\s?off|about\s+it)|scrap\s+(?:it|that)|withdraw|retract|nix\s+(?:it|that)|cancel)\b/.test(b)) return true;
  if (/\b(?:don'?t|do\s+not|no\s+longer)\s+(?:need|want)\s+(?:it\s+anymore|it|any(?:\s+time\s?off)?|the\s+time\s?off|time\s?off)\b/.test(b)) return true;
  if (/\bi'?m\s+(?:all\s+set|good(?:\s+now)?)\b/.test(b)) return true;
  return false;
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

// W-1 branch 2 (C-4 / J-1a): a partial-day window comes from the employee's REAL
// shift on that date, never from a clock-word table. (The old table — morning
// 09–13, afternoon 13–17, evening 17–21 — invented a 17:00–21:00 shift for Mia on
// a day she wasn't working, and turned Katie's 11:00–15:30 Friday into 09:00–13:00.)
//
//   • both times explicit ("1pm to 3pm")           → exactly those
//   • one side explicit ("leave at 3", "after 4pm") → that side, the other side
//                                                     from the shift; null with no shift
//   • only a period word ("the morning")           → the shift's own hours; null with no shift
//
// `shift` is the resolved hours for that date (lib/shift-hours.ts). Pure.
export function resolvePartialWindow(
  entry: ExtractedDateEntry,
  shift?: { start_time: string; end_time: string } | null,
): { start_time: string; end_time: string } | null {
  if (entry.start_time && entry.end_time) {
    return { start_time: entry.start_time, end_time: entry.end_time };
  }
  if (!shift) return null;
  if (entry.start_time && !entry.end_time) {
    // "off from 3pm" on an 11–3:30 shift → 15:00–15:30; a start after the shift
    // ends means the whole shift is unaffected → treat as the shift's tail anyway
    // so nothing is silently dropped.
    return entry.start_time < shift.end_time
      ? { start_time: entry.start_time, end_time: shift.end_time }
      : { start_time: shift.start_time, end_time: shift.end_time };
  }
  if (!entry.start_time && entry.end_time) {
    return entry.end_time > shift.start_time
      ? { start_time: shift.start_time, end_time: entry.end_time }
      : { start_time: shift.start_time, end_time: shift.end_time };
  }
  return { start_time: shift.start_time, end_time: shift.end_time };
}

// Resolve every PARTIAL entry against the employee's published schedule: one
// entry per date, carrying the real shift's hours + name, or `unscheduled` when
// they have no shift that day. Full-day entries pass through untouched.
// Deterministic — no model call; two small DB reads (shift templates + the
// schedule row for each date).
export async function resolvePartialEntries(
  entries: ExtractedDateEntry[],
  ctx: { companyId: string; employeeId: string; words: string; templates?: ShiftTemplate[] },
): Promise<ExtractedDateEntry[]> {
  const out: ExtractedDateEntry[] = [];
  let templates: ShiftTemplate[] | undefined = ctx.templates;
  for (const entry of entries) {
    if (entry.time_off_type !== 'partial' || !entry.start_date) { out.push(entry); continue; }
    if (!templates) templates = await loadShiftTemplates(ctx.companyId);
    for (const date of eachDateInRange(entry.start_date, entry.end_date ?? entry.start_date)) {
      const meant = await resolveMeantHours({ companyId: ctx.companyId, employeeId: ctx.employeeId, date, words: ctx.words, templates });
      const shift = meant ? { start_time: meant.start_time, end_time: meant.end_time } : null;
      const window = resolvePartialWindow(entry, shift);
      if (!window) {
        out.push({ ...entry, start_date: date, end_date: date, start_time: null, end_time: null, shift_id: null, shift_name: null, unscheduled: true });
        continue;
      }
      out.push({
        ...entry,
        start_date: date,
        end_date: date,
        start_time: window.start_time,
        end_time: window.end_time,
        shift_id: meant?.shift_id ?? null,
        shift_name: meant?.shift_name ?? null,
        unscheduled: false,
      });
    }
  }
  return out;
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

export interface ParsedRequest {
  start_date: string;
  end_date: string;
  time_off_type: 'full_day' | 'partial';
  partial_days: PartialDayDetail[] | null;
  // Dates the employee asked for PART of but has no shift on (W-1 branch 2).
  // Logged as full days if they confirm; the confirm copy says so.
  unscheduled_dates: string[];
}

export function parseRequest(entries: ExtractedDateEntry[]): ParsedRequest | null {
  if (entries.length === 0) return null;

  const allDates: string[] = [];
  const partialDays: PartialDayDetail[] = [];
  const unscheduled: string[] = [];
  let anyPartial = false;

  for (const entry of entries) {
    const start = entry.start_date;
    const end = entry.end_date ?? start;
    if (!start) continue;

    const dates = eachDateInRange(start, end);
    allDates.push(...dates);

    if (entry.time_off_type === 'partial') {
      anyPartial = true;
      if (entry.unscheduled) { unscheduled.push(...dates); continue; }
      // Entries reach here already resolved (resolvePartialEntries); an
      // unresolved one has no honest window and falls back to a full day.
      const window = resolvePartialWindow(entry);
      if (!window) continue;
      for (const date of dates) {
        partialDays.push({
          date,
          type: entry.shift_name ? 'shift_off' : 'custom_hours',
          shift_id: entry.shift_id ?? null,
          shift_name: entry.shift_name ?? null,
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
    unscheduled_dates: [...new Set(unscheduled)].sort(),
  };
}

// Employee-facing summary of the request. Hours are ALWAYS shown for a partial
// day (the "(partial day)" blank is what let Mia confirm the wrong window), and a
// day names the real shift when one matched: "your AM Weekday shift (11am–3:30pm)
// on Friday, August 21". Exported for tests.
export function formatRequestSummary(parsed: ParsedRequest): string {
  const range = formatDateRange(parsed.start_date, parsed.end_date);
  const partial = parsed.partial_days ?? [];
  const unscheduled = parsed.unscheduled_dates ?? [];
  if (parsed.time_off_type === 'full_day' && unscheduled.length === 0) return range;
  if (partial.length === 0 && unscheduled.length > 0) {
    // Only unscheduled days: the caller words the "not scheduled" ask itself.
    return unscheduled.map(d => formatDateRange(d, d)).join(' and ');
  }
  const describe = (d: PartialDayDetail): string => {
    const when = formatDateRange(d.date, d.date);
    const hours = d.start_time && d.end_time ? formatClockRange(d.start_time, d.end_time) : null;
    if (d.shift_name && hours) return `your ${d.shift_name} shift (${hours}) on ${when}`;
    if (hours) return `${hours} on ${when}`;
    return when;
  };
  // Compact: one window shared across a run of days → say it once.
  const windows = new Set(partial.map(d => `${d.shift_name ?? ''}|${d.start_time ?? ''}|${d.end_time ?? ''}`));
  let text: string;
  if (windows.size === 1 && partial.length > 1 && unscheduled.length === 0) {
    const s = partial[0];
    const hours = s.start_time && s.end_time ? formatClockRange(s.start_time, s.end_time) : null;
    text = s.shift_name && hours
      ? `your ${s.shift_name} shifts (${hours}) ${range}`
      : hours ? `${hours} each day, ${range}` : range;
  } else {
    text = partial.map(describe).join(', ');
  }
  if (unscheduled.length > 0) {
    text += ` — plus ${unscheduled.map(d => formatDateRange(d, d)).join(' and ')}, where you're not scheduled, logged as a day off`;
  }
  return text;
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

// ── W-2: employee call-out (spec §3.5) ───────────────────────────────────────
//
// A CALL-OUT is a time-off request whose dates are today or tomorrow
// (tenant-local) AND on which the employee has a PUBLISHED assignment. It is a
// REQUEST, not a declaration (Alexander, 2026-08-27): the manager decides with
// three choices — Approve & find coverage, Approve only, Deny — and the
// employee is told it's in motion but pending, never granted. Detection is
// fully deterministic — no model call.

export interface DetectedCallOut {
  shifts: CallOutShift[];
  today: string;
  timezone: string;
}

export async function detectCallOut(
  parsed: ParsedRequest,
  ctx: { companyId: string; employeeId: string },
): Promise<DetectedCallOut | null> {
  const { today, timezone } = await tenantTodayAndZone(ctx.companyId);
  const tomorrow = addDays(today, 1);
  // The whole request must sit inside [today, tomorrow] — "off next Tuesday"
  // or a week-long stretch starting today is ordinary time off.
  if (parsed.start_date < today || parsed.end_date > tomorrow) return null;

  const dates = [...new Set([parsed.start_date, parsed.end_date])].sort();
  const shifts: CallOutShift[] = [];
  for (const date of dates) {
    // publishedOnly: an employee can only call out of a shift they were TOLD
    // about — a draft nobody has seen is not a commitment.
    const { assignments } = await loadAssignmentsOnDate(ctx.companyId, ctx.employeeId, date, { publishedOnly: true });
    let dayAssignments = assignments;
    // A partial request already resolved to a window (W-1); keep only the
    // assignments that window touches, so "I can't do the morning" on a
    // double-shift day doesn't call out the evening too.
    const partials = (parsed.partial_days ?? []).filter(p => p.date === date && p.start_time && p.end_time);
    if (partials.length > 0) {
      dayAssignments = assignments.filter(a =>
        partials.some(p => p.start_time!.slice(0, 5) < a.end_time.slice(0, 5) && p.end_time!.slice(0, 5) > a.start_time.slice(0, 5)),
      );
    }
    for (const a of dayAssignments) {
      shifts.push({ date, shift_name: a.shift_name, role: a.role, start_time: a.start_time, end_time: a.end_time });
    }
  }
  return shifts.length > 0 ? { shifts, today, timezone } : null;
}

// "your Afternoon shift (3pm–8:15pm) tonight" — the one way a call-out's shift
// is spoken of in employee- and manager-facing copy. `perspective` picks the
// possessive ("your" to the employee, "her/his" is never guessed — the manager
// copy uses the employee's name instead via `noun`).
export function describeCallOutShifts(
  shifts: CallOutShift[],
  today: string,
  noun: string = 'your',
): string {
  const dayWord = (s: CallOutShift): string => {
    if (s.date === today) return s.start_time.slice(0, 5) >= '15:00' ? 'tonight' : 'today';
    if (s.date === addDays(today, 1)) return 'tomorrow';
    return `on ${formatDateRange(s.date, s.date)}`;
  };
  return shifts
    .map(s => `${noun} ${s.shift_name} shift (${formatClockRange(s.start_time, s.end_time)}) ${dayWord(s)}`)
    .join(' and ');
}

// Minutes until the FIRST called-out shift starts, tenant-local. Drives the
// near-shift escalation in the manager nudge (§2.6: a call-out landing close to
// shift start makes the coverage window real — say so).
export function minutesUntilFirstCallOutShift(
  callOut: DetectedCallOut,
  now: Date = new Date(),
): number {
  return Math.min(
    ...callOut.shifts.map(s => minutesUntilTenantTime(callOut.timezone, s.date, s.start_time, now)),
  );
}

// ── AI recommendation ─────────────────────────────────────────────────────────

async function generateTimeOffRecommendation(
  employee: Employee,
  startDate: string,
  endDate: string,
  reason: string,
  stage1: SimulationResult,
  stage2: SimulationResult | null,
  policies: Policy[],
  partialSummary?: string | null
): Promise<DecisionRecommendation> {
  const systemPrompt =
    'You are Aegis, an AI workforce assistant. Analyze a time-off request and provide a recommendation. ' +
    'Respond with ONLY valid JSON, no markdown: ' +
    '{ "recommendation": "approve" | "deny", "reasoning": "2-3 sentences", "policy_notes": "relevant policy points or empty string" }';

  const policyText =
    policies.length > 0
      ? policies
          .map(p => `${p.policy_key}: ${p.policy_value}${stripDemo(p.description) ? ` — ${stripDemo(p.description)}` : ''}`)
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
    partialSummary
      ? `Requested: PARTIAL DAY — ${partialSummary} (employee is out ONLY during this window, not the full day; weigh coverage for that window)`
      : `Requested dates: ${startDate} to ${endDate}`,
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
// Exported so the threading invariant is testable: the Message-ID stamped on a
// manager's request email and the In-Reply-To on the later "resolved" reply must
// be byte-identical, or the reply opens a new inbox item instead of collapsing
// under the original. See __tests__/manager-email-threading.test.ts.
export function toThreadMessageId(requestId: string, managerKey: string, salt?: number): string {
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

// Strip sandbox "— Demo…" / "Demo:" annotations off a policy description so they
// never reach a real manager's inbox (production polish). Keeps any real prefix.
function stripDemo(desc?: string | null): string {
  if (!desc) return '';
  return desc.replace(/\s*[—-]\s*Demo\b.*$/i, '').replace(/^\s*Demo\b.*$/i, '').trim();
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
  // W-2 call-out (spec §3.5): third button + the lead. All three set together.
  approveAndCoverUrl?: string | null;
  callOutLine?: string | null;      // "Mia's Afternoon shift (3pm–8:15pm) tonight"
  employeeWords?: string | null;    // forwarded verbatim (spec)
  policies: Policy[];
  violations: TimeOffViolations | null;
  timeOffType?: 'full_day' | 'partial' | null;
  partialDays?: PartialDayDetail[] | null;
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
    approveAndCoverUrl,
    callOutLine,
    employeeWords,
    policies,
    violations,
    timeOffType,
    partialDays,
  } = params;
  const isCallOut = !!approveAndCoverUrl && !!callOutLine;
  const violationLines = formatViolationLines(violations);

  // Partial-day requests must render the actual window (e.g. "Wed Aug 12 —
  // 9:00 AM–1:00 PM"), not a whole day — a manager approving needs to see it's
  // only the morning. (H1: this path previously dropped the partial info.)
  const isPartial = timeOffType === 'partial' && !!partialDays && partialDays.length > 0;
  const dateDisplay = isPartial
    ? `${partialDays!.map(describePartialDay).join('; ')} (partial day)`
    : formatDateRange(startDate, endDate);
  const subject = isCallOut
    ? `Call-Out — ${employeeName} (${formatShortDate(startDate)}${startDate !== endDate ? ` – ${formatShortDate(endDate)}` : ''})`
    : `Time-Off Request — ${employeeName} (${formatShortDate(startDate)}${startDate !== endDate ? ` – ${formatShortDate(endDate)}` : ''}${isPartial ? ', partial' : ''})`;
  const employeeFirst = firstName(employeeName);

  // Call-out intro — leads with who / which shift / when, and what each button
  // does. The employee's own words ride along verbatim below.
  const callOutIntroText = isCallOut
    ? `${employeeFirst} just called out of ${callOutLine}. Your call: ` +
      `"Approve & find coverage" approves the absence and I immediately text everyone qualified to cover the shift; ` +
      `"Approve" approves the absence and leaves coverage with you; "Deny" turns it down. ` +
      `Either way I'll tell ${employeeFirst} the moment you decide — they've been told they're still on the schedule until you do.`
    : null;

  // Plain text version. Sim/alternates/recommendation sections are only
  // rendered when the simulator ran (stage1 non-null).
  const text = [
    greeting(managerName),
    '',
    callOutIntroText ??
      `${employeeFirst} just put in a ${isPartial ? 'partial-day ' : ''}time-off request, and I've taken a first pass at the coverage picture for you. ` +
      `The details are below — either link records your decision right away, and I'll let ${employeeFirst} know which way it went, so there's nothing else you'll need to do.`,
    '',
    ...(isCallOut && employeeWords ? [`In ${employeeFirst}'s own words: "${employeeWords.trim()}"`, ''] : []),
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
      ? `COMPANY POLICIES (time-off):\n${policies.map(p => `  ${p.policy_key}: ${p.policy_value}${stripDemo(p.description) ? ' — ' + stripDemo(p.description) : ''}`).join('\n')}`
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
    ...(isCallOut && approveAndCoverUrl
      ? ['Approve & find coverage (I text the whole qualified pool right away):', approveAndCoverUrl, '']
      : []),
    isCallOut ? 'Approve (absence only — coverage stays with you):' : 'Approve this request:',
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
<p style="margin:0;font-size:16px;color:${BRAND.textPrimary};line-height:1.65;">${
    callOutIntroText
      ? escapeHtmlTo(callOutIntroText)
      : `${escapeHtmlTo(employeeFirst)} just put in a ${isPartial ? 'partial-day ' : ''}time-off request, and I've taken a first pass at the coverage picture for you. Everything's in the card below — either button records your decision right away, and I'll let ${escapeHtmlTo(employeeFirst)} know which way it went, so there's nothing else you'll need to do.`
  }</p>`;

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
  ${isCallOut ? `<div style="font-size:14px;color:${BRAND.textPrimary};margin-top:8px;"><strong>Shift:</strong> ${escapeHtmlTo(callOutLine!)}</div>` : ''}
  <div style="font-size:14px;color:${BRAND.textPrimary};margin-top:8px;"><strong>Dates:</strong> ${escapeHtmlTo(dateDisplay)}</div>
  ${isCallOut && employeeWords ? `<div style="font-size:14px;color:${BRAND.textPrimary};margin-top:8px;"><strong>Their words:</strong> &ldquo;${escapeHtmlTo(employeeWords.trim())}&rdquo;</div>` : ''}
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
              `<li style="margin:0 0 6px;font-size:14px;color:${BRAND.textPrimary};"><strong>${escapeHtmlTo(p.policy_key)}:</strong> ${escapeHtmlTo(p.policy_value)}${stripDemo(p.description) ? ' — ' + escapeHtmlTo(stripDemo(p.description)) : ''}</li>`
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
${brandedButtonRow(
  isCallOut && approveAndCoverUrl
    ? [
        { url: approveAndCoverUrl, label: 'Approve & find coverage', variant: 'primary' },
        { url: approveUrl, label: 'Approve only', variant: 'secondary' },
        { url: denyUrl, label: 'Deny', variant: 'secondary' },
      ]
    : [
        { url: approveUrl, label: 'Approve', variant: 'primary' },
        { url: denyUrl, label: 'Deny', variant: 'secondary' },
      ],
)}
  <div style="font-size:13px;color:${BRAND.textMuted};margin:2px 0 6px;">These links expire in 7 days.</div>
</div>`;

  const cardInner = `${policyConsiderationsHtml}
${requestDetailsHtml}
${coverageHtml}
${policiesHtml}
${recommendationHtml}
${ctaHtml}`;

  const bodyHtml = `${introHtml}
${brandActionCard(isCallOut ? 'Action needed · Call-out' : 'Action needed · Time off', cardInner)}`;

  const html = brandedEmailShell({
    bodyHtml,
    preheader: isCallOut
      ? `Call-out from ${employeeName} — ${callOutLine}`
      : `Time-off request from ${employeeName} — ${dateDisplay}`,
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
// Pure channel router for the employee decision notification. SMS-FIRST for
// phone-holders (Batch-1 design principle; SMS spec §3.3 "the employee gets the
// outcome in text"): when EMAIL_ONLY=false, any employee with a phone is texted
// and email is the fallback (the SMS path in sendDecisionNotification falls back
// to email on send failure). originChannel is retained for threading context but
// no longer gates SMS — previously a phone+email employee whose SMS origin
// wasn't captured defaulted to email (Batch-1 F1). Rules:
//   'sms'         — has a phone AND SMS is enabled (email fallback on failure)
//   'email'       — no phone (or EMAIL_ONLY) but has an email
//   'skip'        — EMAIL_ONLY + phone-only: unreachable right now; skip the notice
//   'unreachable' — neither email nor phone on file
export type DecisionRoute = 'sms' | 'email' | 'skip' | 'unreachable';
export function pickDecisionRoute(opts: {
  originChannel?: 'sms' | 'email';
  contactEmail: string | null;
  contactPhone: string | null;
  emailOnly: boolean;
}): DecisionRoute {
  const canSms = !!opts.contactPhone && !opts.emailOnly;
  if (canSms) return 'sms';
  if (opts.contactEmail) return 'email';
  if (opts.emailOnly && opts.contactPhone) return 'skip';
  return 'unreachable';
}

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
  const greetingLine = textOpener(employee.name);
  const text =
    decision === 'approved'
      ? `${greetingLine}Your time-off request for ${dateRange} has been approved. Enjoy your time off!`
      : `${greetingLine}Your time-off request for ${dateRange} has been denied. Please contact your manager if you have questions or would like to discuss alternatives.`;

  // Reply on the SAME channel the employee submitted on. The to_thread:<id> row
  // (written at submission for both channels) records the origin channel and, for
  // email, the thread metadata so we thread back into the original conversation.
  // When the origin wasn't recorded (older requests), fall back to email-first.
  const { data: metaRow } = await supabase
    .from('aegis_memory')
    .select('content')
    .eq('source', `to_thread:${requestId}`)
    .maybeSingle();
  let originChannel: 'sms' | 'email' | undefined;
  let threadId: string | undefined;
  let rawSubject: string | undefined;
  if (metaRow) {
    try {
      const meta = JSON.parse((metaRow as { content: string }).content) as {
        channel?: 'sms' | 'email' | null;
        thread_id?: string | null;
        raw_subject?: string | null;
      };
      originChannel = meta.channel ?? undefined;
      threadId = meta.thread_id ?? undefined;
      rawSubject = meta.raw_subject ?? undefined;
    } catch {
      // Corrupted side row — proceed without origin / threading.
    }
  }

  const route = pickDecisionRoute({
    originChannel,
    contactEmail: employee.contact_email,
    contactPhone: employee.contact_phone,
    emailOnly: env.EMAIL_ONLY,
  });

  let channel: 'email' | 'sms';
  let sent_to: string;

  if (route === 'sms') {
    // SMS path needs the company's Aegis outbound number.
    const { data: channelRow } = await supabase
      .from('company_channels')
      .select('channel_value')
      .eq('company_id', tor.company_id)
      .eq('channel_type', 'sms')
      .maybeSingle();
    const aegisSmsChannel = (channelRow as { channel_value: string } | null)?.channel_value ?? null;
    // Attempt SMS only if a channel is actually configured. If it isn't, treat
    // it exactly like a send failure below and fall back to email — the decision
    // notice is the single highest-stakes message and SMS-first means email is
    // the fallback, so a missing channel must NOT drop it (DRIFT_REGISTER H20).
    const sent = aegisSmsChannel
      ? await sendSms({
          to: employee.contact_phone!,
          from: aegisSmsChannel,
          body: text,
          company_id: tor.company_id,
          employee_id: employee.id,
        })
      : false;
    if (sent) {
      channel = 'sms';
      sent_to = employee.contact_phone!;
    } else if (employee.contact_email) {
      // SMS unavailable — either no Aegis SMS channel is configured for this
      // company yet, or the send failed (transient Telnyx error / unreachable
      // number). The decision notice is the single highest-stakes message, so
      // fall back to email rather than dropping it — mirrors notifyEmployeeDecision
      // (H2). Previously the no-channel case threw and 500'd the internal
      // endpoint, and the send-failure case once silently lost the notice
      // (DRIFT_REGISTER H3, extended by H20).
      console.warn(
        `[time-off] decision SMS unavailable for employee ${employee.id} ` +
          `(${aegisSmsChannel ? 'send failed' : 'no SMS channel configured'}); falling back to email`
      );
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
    } else {
      // SMS unavailable and no email on file — genuinely unreachable right now.
      throw new Error(
        `SMS unavailable for employee ${employee.id} and no email address on file to fall back to`
      );
    }
  } else if (route === 'email') {
    const subject = rawSubject
      ? normalizeReSubject(rawSubject)
      : `Your time-off request has been ${decision}`;

    await sendEmail({
      to: employee.contact_email!,
      subject,
      text,
      company_id: tor.company_id,
      thread_id: threadId,
    });
    channel = 'email';
    sent_to = employee.contact_email!;
  } else if (route === 'skip') {
    // Email-only mode + no email on file: SMS is disabled, so this employee is
    // currently unreachable. Log and skip the notice rather than throw — the
    // time-off decision itself already succeeded; only the notification is skipped.
    console.warn(
      `[time-off] EMAIL_ONLY: employee ${employee.id} has a phone but no email; SMS disabled — decision notice skipped.`
    );
    channel = 'email';
    sent_to = employee.contact_phone!;
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
  const resolutionDirectory = await resolveManagers(args.companyId);
  const managers = recipientsFor(resolutionDirectory, 'approvals', args.companyId)
    .filter(m => !!m.email);

  // N1 — never notify the manager who TOOK this decision about their own action
  // ("Jack approved … " → Jack). See excludeActor: when decided_by is NULL (the
  // shared magic-link path where we can't attribute — Data Contract D17) nobody
  // is excluded, so an unattributed decision still notifies everyone.
  const asActors = managers.map((m) => ({ ...m, id: m.userId }));
  for (const m of excludeActor(asActors, decidedById)) {
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
        to: m.email,
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

/**
 * Notify the manager(s) that an employee has requested time off, with
 * approve/deny magic links. Used for SMS-channel submissions; the email channel
 * goes through notifyManagersByEmail() below.
 *
 * ── ITEM 2 (2026-08-16) — THIS USED TO NOTIFY EXACTLY ONE MANAGER ───────────
 *
 * The lookup was `.order('role').limit(1).maybeSingle()` — literally "find first
 * manager/owner for this company". So the SAME time-off request notified a
 * different set of people depending on how the employee submitted it: every
 * manager for an emailed request (notifyManagersByEmail already fans out), one
 * arbitrary manager for a texted one. Alexander: "I want all managers to get
 * notified of time off."
 *
 * That asymmetry gets worse, not better, as this build moves employees onto SMS:
 * the one-manager path is the SMS path.
 *
 * WHAT FANS OUT AND WHAT DOESN'T:
 *  • Per manager — their own approve/deny token PAIR, their own email, their own
 *    SMS alert. Separate tokens matter: the token payload carries
 *    manager_user_id/manager_name, which is what attributes the decision on
 *    time_off_requests.decided_by and in the activity feed (Data Contract D17).
 *    One shared token would credit whoever we happened to mint it for, not
 *    whoever clicked.
 *  • Once — the company SMS number, the policies, and the AI recommendation
 *    (which is expensive and is persisted to the request row, not per-manager).
 *
 * RACE: two managers can click. Already handled — the decision webhook re-reads
 * the request and refuses anything whose status is no longer 'pending', showing
 * "This request has already been approved/denied" (webhooks/decision.ts).
 */
export async function notifyManager(
  companyId: string,
  employee: Employee,
  pending: PendingTimeOff,
  requestId: string,
  stage1: SimulationResult | null,
  stage2: SimulationResult | null,
  violations: TimeOffViolations | null
): Promise<void> {
  // ── L3's fan-out, sourced from ONE resolver (Phase 2) ─────────────────────
  //
  // L3 made this notify EVERY manager instead of one arbitrary manager — that
  // behaviour is kept exactly. What changed is WHERE the managers and their
  // phones come from. L3 still found a phone by matching users.email against
  // employees.contact_email, which is case-SENSITIVE, silently returns nothing
  // on a miss OR on a duplicate, and never checked whether a login had been
  // revoked. src/messaging/manager-directory.ts answers all of that once:
  // it resolves through users.employee_id, skips revoked logins, honours each
  // person's notification preferences, and logs loudly by name when someone
  // cannot be reached.
  //
  // 'approvals' is the right category — this IS an action item — which also
  // means the safety valve applies: if every manager had opted out, it still
  // goes to all of them rather than to nobody.
  const directory = await resolveManagers(companyId);
  const managers = recipientsFor(directory, 'approvals', companyId).filter(m => !!m.email);
  const aegisSmsNumber = directory.smsChannel;

  if (managers.length === 0) {
    console.error(
      `[time-off] ${employee.name}'s request ${requestId} cannot be routed — company ${companyId} ` +
      'has no manager or owner with an email on file. The request is recorded but nobody has been told.',
    );
    return;
  }

  for (const m of directory.unreachableBySms) {
    console.warn(
      `[time-off] no phone on file for ${m.name} — they get the approval by email only. ` +
      `(link source: ${m.linkSource})`,
    );
  }

  // Load time-off policies for the email
  const policies = await loadAllTimeOffPolicies(companyId);

  // ── Generated ONCE, shared by every manager's email ───────────────────────
  //
  // Generate the AI recommendation only when we have stage-1 coverage data; the
  // recommendation prompt embeds simulation stats and would fail without them.
  // When the simulator was skipped (no shift_requirements), the manager email
  // still goes out — just without the recommendation section.
  //
  // Deliberately OUTSIDE the per-manager loop: it's an LLM call and it is
  // persisted to the REQUEST row (one fact, one place — Rule 0), so generating
  // it per manager would burn tokens to produce n answers where one is the
  // truth, and the last writer would win on time_off_requests.
  let recommendation: DecisionRecommendation | null = null;
  if (stage1) {
    recommendation = await generateTimeOffRecommendation(
      employee,
      pending.start_date,
      pending.end_date,
      pending.reason ?? '',
      stage1,
      stage2,
      policies,
      pending.time_off_type === 'partial' && pending.partial_days?.length
        ? buildPartialSummaryText(pending.partial_days)
        : null
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

  const baseUrl = env.BASE_URL;
  const tokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const dateDisplay = formatDateRange(pending.start_date, pending.end_date);

  // W-2 — call-out extras, computed ONCE for every manager (spec §3.5):
  //  • callOutLine: "Mia's Afternoon shift (3pm–8:15pm) tonight" for email + SMS
  //  • near-shift escalation: shift starts within 6 hours → the nudge says so
  const isCallOut = !!pending.call_out?.length;
  let callOutLine: string | null = null;
  let nearShiftLine = '';
  if (isCallOut) {
    const { today, timezone } = await tenantTodayAndZone(companyId);
    const first = firstName(employee.name);
    callOutLine = describeCallOutShifts(pending.call_out!, today, `${first}'s`);
    const soonest = [...pending.call_out!].sort((a, b) =>
      `${a.date}T${a.start_time}`.localeCompare(`${b.date}T${b.start_time}`))[0];
    const minsUntil = minutesUntilTenantTime(timezone, soonest.date, soonest.start_time);
    if (minsUntil > 0 && minsUntil <= 6 * 60) {
      nearShiftLine = ` The shift starts at ${formatClock(soonest.start_time)} — the coverage window is real.`;
    }
  }

  // ── Per manager: own tokens, own email, own SMS ───────────────────────────
  //
  // One manager's failure must not silence the rest — a bad address or a bounced
  // send used to be the difference between "the manager was told" and "nobody
  // was told" precisely because there was only ever one recipient. Each is
  // wrapped so the loop always completes.
  let emailed = 0;
  for (const manager of managers) {
    try {
      // Separate approve/deny tokens PER MANAGER. The payload carries the
      // manager identity, which is what attributes the decision on
      // time_off_requests.decided_by and in the activity feed rather than
      // falling back to 'aegis' (Data Contract D17). A shared token would
      // credit whoever we minted it for, not whoever clicked.
      const approveToken = randomUUID();
      const denyToken = randomUUID();
      // W-2 — a CALL-OUT mints a third choice: Approve & find coverage (spec
      // §3.5). Same token family; the action string is what the click carries.
      const approveAndCoverToken = isCallOut ? randomUUID() : null;

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
        manager_user_id: manager.userId,
        manager_name: manager.name,
        expires_at: tokenExpiry,
        call_out: pending.call_out ?? null,
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
        ...(approveAndCoverToken
          ? [
              supabase.from('aegis_memory').insert({
                company_id: companyId,
                memory_type: 'observation',
                source: `decision_token:${approveAndCoverToken}`,
                content: JSON.stringify({ ...sharedPayload, action: 'approve_and_cover' }),
              }),
            ]
          : []),
      ]);

      const approveUrl = `${baseUrl}/webhooks/decision?action=approve&requestId=${requestId}&token=${approveToken}`;
      const denyUrl = `${baseUrl}/webhooks/decision?action=deny&requestId=${requestId}&token=${denyToken}`;
      const approveAndCoverUrl = approveAndCoverToken
        ? `${baseUrl}/webhooks/decision?action=approve_and_cover&requestId=${requestId}&token=${approveAndCoverToken}`
        : null;

      const { subject, text, html } = buildManagerEmail({
        employeeName: employee.name,
        managerName: manager.name,
        startDate: pending.start_date,
        endDate: pending.end_date,
        reason: reasonForManager(pending.reason),
        stage1,
        stage2,
        recommendation,
        approveUrl,
        denyUrl,
        approveAndCoverUrl,
        callOutLine,
        employeeWords: isCallOut ? pending.employee_words ?? null : null,
        policies,
        violations,
        timeOffType: pending.time_off_type ?? 'full_day',
        partialDays: pending.partial_days ?? null,
      });

      await sendEmail({
        to: manager.email,
        subject,
        text,
        html,
        company_id: companyId,
        // Stamp the SAME deterministic Message-ID the email-channel path uses
        // (notifyManagersByEmail, below). Without it, a request that arrived BY
        // TEXT produced a manager email with no Message-ID — so the later
        // "resolved" reply had nothing to thread to and landed as a second
        // unread item saying no action was needed. One header, and the
        // follow-up collapses under the original. It matters because SMS is now
        // the channel most requests arrive on.
        message_id: toThreadMessageId(requestId, manager.userId),
      });
      emailed++;

      // SMS alert — notification only, no analysis (the manager email above
      // always sends; this is additive and skipped entirely in email-only mode).
      const managerPhone = manager.phone;
      if (!env.EMAIL_ONLY && managerPhone && aegisSmsNumber) {
        await sendSms({
          // Recipient is the MANAGER (not under the employee opt-in regime).
          allowPreConsent: true,
          to: managerPhone,
          from: aegisSmsNumber,
          body: managerAlertSms({
            managerName: manager.name,
            // A call-out leads with the shift and the urgency, not the dates —
            // and hands off to an email with THREE choices, not approve/deny.
            summary: isCallOut
              ? `${employee.name} just called out of ${callOutLine}${pending.reason ? ` — ${pending.reason}` : ''}.${nearShiftLine}`
              : `${employee.name} wants ${dateDisplay} off${pending.reason ? ` for ${pending.reason}` : ` (${NO_REASON_GIVEN})`}.`,
            inbox: isCallOut ? 'decide' : 'approve',
          }),
          company_id: companyId,
        });
      }
    } catch (err) {
      console.warn('[time-off] manager notification failed for', manager.email, err);
    }
  }

  if (emailed === 0) {
    console.error(
      '[time-off] NO manager was notified of request', requestId,
      `— all ${managers.length} send(s) failed`,
    );
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
  // The SAME resolver the SMS-channel path uses (notifyManager, above). Before
  // this, an emailed request and a texted request resolved their recipients two
  // different ways — one question, two answers (Rule 0b).
  const directory = await resolveManagers(companyId);
  const managers = recipientsFor(directory, 'approvals', companyId);
  const withEmail = managers.filter(m => !!m.email);

  if (withEmail.length === 0) {
    console.error(
      `[time-off] email-channel: ${employee.name}'s request cannot be routed — company ${companyId} ` +
      'has no manager or owner with an email on file. Recorded, but nobody has been told.',
    );
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
        pending.reason ?? '',
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
        manager_user_id: manager.userId,
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
        message_id: toThreadMessageId(torRow.id, manager.userId),
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
  const rawEntries = normalizeExtractedDates(extracted);
  // W-1 branch 2: partial days resolve against the employee's REAL shifts.
  const entries = contact.employee_id
    ? await resolvePartialEntries(rawEntries, { companyId: contact.company_id, employeeId: contact.employee_id, words: message.body })
    : rawEntries;
  const parsed = parseRequest(entries);
  // Decision (Alexander, 2026-08-26): when no reason is given, store NULL and
  // show "no reason given" to the manager — never invent "personal reasons"
  // (a manager reading that believes the employee said it).
  const reason = normalizeReason(extracted['reason']);
  // C-7: "Tuesday August 26th" → the 26th is a Wednesday. Say so in the confirm
  // so a wrong-date request is caught before the manager sees it.
  const weekdayNote = weekdayMismatchNote(message.body, entries.map(e => e.start_date));

  if (!parsed) {
    await reply(
      contact,
      message,
      "I'd be happy to help with your time-off request! Could you let me know the specific date(s) you need off and the reason?"
    );
    return;
  }

  const onlyUnscheduled = parsed.unscheduled_dates.length > 0 && !parsed.partial_days?.length;

  // W-2 (spec §3.5): dates today/tomorrow + a published shift = a CALL-OUT.
  // Deterministic; the unscheduled path above already catches "sick tonight"
  // with no shift (W-1), so a call-out and "you're not on the schedule" can
  // never both fire.
  const callOut = !onlyUnscheduled && contact.employee_id
    ? await detectCallOut(parsed, { companyId: contact.company_id, employeeId: contact.employee_id })
    : null;

  // Store pending confirmation (TTL: 24 hours). Email replies can lag hours behind
  // the request (people confirm when they next check mail), and the router resolves a
  // pending TO deterministically BEFORE the classifier — so a longer window keeps a
  // bare "yes" on the confirmation path instead of expiring into the classifier, where
  // a contentless affirmation can be mislabeled as a swap-accept (BUG-6 residual).
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
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    time_off_type: parsed.time_off_type,
    partial_days: parsed.partial_days,
    call_out: callOut?.shifts,
    employee_words: callOut ? message.body : undefined,
  };

  // One writer for the pending row (shared with the gate's edit paths — Rule 0b).
  await storePendingTimeOff(contact.company_id, contact.employee_id!, pendingData);

  const summary = formatRequestSummary(parsed);
  // Human, conversational confirmation — no "(reply yes/no)" mechanics, and no
  // email-style "Hi Sam,\n\n" header (too formal for a text). The name is woven
  // inline ("Got it, Sam —"), the ask invites a natural yes/no, and the handler
  // accepts natural affirmations. `reason` already carries its own article when
  // it needs one (see the classifier), so "off for ${reason}" reads correctly.
  const first = firstName(contact.name);
  const lead = first ? `Got it, ${first} —` : 'Got it —';
  // W-1 branch 2: a part-day request on a day with NO shift gets an honest ask,
  // never invented hours ("sick tonight" on an unscheduled Friday). A "yes" logs
  // it as a plain day off so the manager still knows.
  const forReason = reason ? ` for ${reason}` : '';
  // W-2: a call-out's confirm names the real shift(s) and reads as urgent-but-
  // pending — never as "you're off". "Sorry" only when they said they're sick.
  const callOutSummary = callOut ? describeCallOutShifts(callOut.shifts, callOut.today) : null;
  const confirmText = onlyUnscheduled
    ? `${lead} ${summary}${weekdayNote}: you're not on the schedule that day, so there's no shift to take off. Want me to log it as a day off anyway${forReason} so your manager knows?` +
      availabilityFollowupNote(extracted)
    : callOutSummary
    ? `${lead} you're calling out of ${callOutSummary}${forReason}. Want me to send that to your manager right away?` +
      availabilityFollowupNote(extracted)
    : `${lead} ${summary}${weekdayNote} off${forReason}. Want me to send that over to your manager?` +
      availabilityFollowupNote(extracted);

  // Rich HTML sibling: reflect the employee's own words, present the requested
  // time off as a single accent detail row, then ask to confirm. SMS + the text
  // part still get confirmText. Purely visual — the yes/no path is unchanged.
  const pStyle = `margin:0 0 16px;font-size:16px;line-height:1.65;color:${BRAND.textPrimary};`;
  const psNote = extracted?.['also_mentions_availability'] === true
    ? `<p style="margin:16px 0 0;font-size:14px;line-height:1.6;color:${BRAND.silver};">P.S. — I also saw you included your availability. Send that in its own message (like &ldquo;I can work Monday and Wednesday mornings&rdquo;) and I&rsquo;ll set it up — I kept this one focused on your time off so nothing gets crossed.</p>`
    : '';
  const confirmHtml = brandedEmailShell({
    bodyHtml:
      brandReflect(message.body) +
      `<p style="${pStyle}">${greeting(contact.name)}</p>` +
      `<p style="${pStyle}">Sure thing — here's the request I'll send over:</p>` +
      brandDetailRow(escapeHtmlTo(summary), reason ? `for ${escapeHtmlTo(reason)}` : 'no reason given') +
      `<p style="margin:4px 0 0;font-size:16px;line-height:1.65;color:${BRAND.textPrimary};">Want me to pass it to your manager? Just say the word — or tell me what to change.</p>` +
      psNote +
      `<p style="margin:22px 0 0;color:${BRAND.textSecondary};">— Aegis</p>`,
  });
  await reply(contact, message, confirmText, confirmHtml);
}

// Step 2: Employee replies yes/no to confirmation — runs simulation and submits.
// Called by the router's pre-classification pending check.
// Shared submission core: run the coverage simulation, create the
// time_off_request (status pending), record origin channel + activity, compute
// advisory violations, and notify the manager the full way (rich approve/deny
// email + SMS alert). Returns the new request id, or null if the insert failed.
//
// This is the single seam both the normal SMS/email time-off confirmation
// (handlePendingTimeOffConfirmation) and the onboarding time-off step share, so
// an onboarding request is indistinguishable from a normal one downstream —
// same coverage analysis, same manager email, same attribution. Callers own the
// employee-facing reply (they have the inbound message/channel context).
export async function createTimeOffRequestAndNotify(
  companyId: string,
  employee: Employee,
  pending: PendingTimeOff
): Promise<string | null> {
  // Stage 1: simulate the specific requested day(s). If the company hasn't
  // configured shift_requirements, the simulator throws NO_SHIFT_REQUIREMENTS;
  // swallow that case and continue with stage1Result=null so TO creation isn't
  // gated on scheduling setup. Coverage analysis is advisory, not a precondition.
  let stage1Result: SimulationResult | null = null;
  try {
    stage1Result = await runSimulation({
      company_id: companyId,
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
        company_id: companyId,
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
        company_id: companyId,
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
          company_id: companyId,
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
      company_id: companyId,
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
    return null;
  }

  const requestId = (torData as { id: string }).id;

  // Persist the ORIGIN CHANNEL (+ email thread metadata) so sendDecisionNotification
  // — invoked by Homebase via /internal/notify-to-decision after a manager clicks
  // Approve/Deny — replies to the employee on the SAME channel they submitted on
  // (an SMS request gets an SMS decision, not an email), and threads the email
  // reply back into the original conversation when the origin was email. The
  // decision_token (notifyManager / decision.ts) path carries the channel via its
  // own token; this side row is for the aegis_action_tokens path, which is fired
  // by an external webhook and only gets requestId + decision. JSON blob in
  // aegis_memory.content — no migration. Written for BOTH channels now.
  await supabase.from('aegis_memory').insert({
    company_id: companyId,
    memory_type: 'observation',
    source: `to_thread:${requestId}`,
    content: JSON.stringify({
      channel: pending.channel,
      thread_id: pending.thread_id ?? null,
      raw_subject: pending.raw_subject ?? null,
      // W-2 — marks the stored request as a CALL-OUT (no schema change; the
      // status query reads this to say "called out" instead of "time off").
      call_out: pending.call_out?.length ? pending.call_out : null,
    }),
  });

  await logActivity({
    company_id: companyId,
    action: 'time_off_request_created',
    entity_type: 'time_off_request',
    entity_id: requestId,
    summary: pending.call_out?.length
      ? `${employee.name} called out of ${pending.call_out.map(s => `${s.shift_name} on ${s.date}`).join(', ')} (pending manager decision)`
      : `${employee.name} submitted a time-off request for ${formatDateRange(pending.start_date, pending.end_date)}`,
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
      company_id: companyId,
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
        company_id: companyId,
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
        .eq('id', companyId)
        .single();
      const companyName = (companyData as { name: string } | null)?.name ?? 'Your Company';

      await notifyManagersByEmail(
        companyId,
        companyName,
        employee,
        torRow,
        pending,
        stage1Result,
        stage2Result,
        violations
      );
    } else {
      await notifyManager(companyId, employee, pending, requestId, stage1Result, stage2Result, violations);
    }
  } catch (err) {
    console.error('[time-off] manager notification failed:', err);
    await logActivity({
      company_id: companyId,
      action: 'time_off_manager_notification_failed',
      entity_id: requestId,
      summary: 'Manager notification failed — request is still logged',
      metadata: { error: String(err) },
    });
  }

  return requestId;
}

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

  // Natural mid-flow cancellation ("changed my mind, I don't need it", "never mind",
  // "don't want time off", "forget it") — clear the pending cleanly instead of
  // re-asking or treating it as a correction. Runs BEFORE the classifier (no LLM
  // cost on a cancel), and is distinct from a date correction.
  if (isTimeOffCancellation(trimmed)) {
    await clearPendingTimeOff(contact.company_id, contact.employee_id!);
    await reply(
      contact,
      message,
      "No problem — I've scrapped that time-off request. Just let me know if you need anything else."
    );
    return;
  }

  // ── W-2 (C-5): a non-yes/no reply is an EDIT, not noise ────────────────────
  //
  // Deterministic pre-pass FIRST (no model call): a reason-only correction —
  // Maisey's "make sure to say it's due to the watermark entry", Katie's
  // "THIS IS FOR COMPETITION" — updates the reason and re-shows the confirm.
  const reasonEdit = parseReasonEdit(trimmed);
  if (reasonEdit && !isTimeOffAffirmation(trimmed.toLowerCase()) && !isTimeOffDenial(trimmed.toLowerCase())) {
    const updated: PendingTimeOff = { ...stripMemoryId(pending), reason: normalizeReason(reasonEdit) };
    await storePendingTimeOff(contact.company_id, contact.employee_id!, updated);
    await replyWithUpdatedConfirm(message, contact, updated);
    return;
  }

  // Classify before yes/no: a new submit_time_off (e.g. "ok so I need Friday
  // off") would otherwise match the YES regex on its leading word and silently
  // consume the OLD pending while dropping the new dates.
  //
  // W-2: the EXISTING call now carries the gate as context (companyContext slot
  // — zero extra calls), so a fragmentary correction ("actually the 19th",
  // "not start at 3") classifies as submit_time_off with the corrected fields
  // instead of falling into the nag.
  const { data: companyData } = await supabase
    .from('companies')
    .select('timezone')
    .eq('id', contact.company_id)
    .single();
  const companyTimezone =
    (companyData as { timezone: string | null } | null)?.timezone ?? 'America/New_York';
  const gateContext =
    `CONTEXT: This employee has an UNSENT time-off request awaiting their yes/no confirmation: ` +
    `${pending.start_date === pending.end_date ? pending.start_date : `${pending.start_date} to ${pending.end_date}`}` +
    `${pending.reason ? ` (reason: ${pending.reason})` : ''}. ` +
    `A reply that corrects or adds detail to that request — even a fragment like "actually the 19th", ` +
    `"not start at 3", or a restatement of the same request — is submit_time_off; extract the corrected ` +
    `details and carry over any field the reply does not change. It is NOT a schedule question.`;
  const classification = await classifyIntent(message.body, contact.role, gateContext, companyTimezone);

  if (classification.intent === 'submit_time_off') {
    // The employee restated or corrected instead of saying yes. W-2 (C-5):
    //  • the IDENTICAL request re-sent (Katie, IMG_5411) means "yes" — submit it;
    //  • the same dates with a NEW reason means "fix the reason" — update + re-show;
    //  • different dates replace the pending (BUG-5 behaviour, kept), carrying
    //    the old reason forward when the correction didn't restate one.
    const rawEntries = normalizeExtractedDates(classification.extracted);
    const entries = contact.employee_id
      ? await resolvePartialEntries(rawEntries, { companyId: contact.company_id, employeeId: contact.employee_id, words: message.body })
      : rawEntries;
    const reParsed = parseRequest(entries);
    const newReason = normalizeReason(classification.extracted['reason']);

    if (!reParsed) {
      // The "new request" carries no dates at all — a fragment the extractor
      // couldn't ground. Keep the pending; never restart the flow (C-5).
      await reply(
        contact,
        message,
        "Just let me know — should I send that to your manager? Or tell me what to change and I'll fix it up."
      );
      return;
    }

    if (samePendingRequest(pending, reParsed)) {
      if (newReason && newReason !== pending.reason) {
        const updated: PendingTimeOff = { ...stripMemoryId(pending), reason: newReason };
        await storePendingTimeOff(contact.company_id, contact.employee_id!, updated);
        await replyWithUpdatedConfirm(message, contact, updated);
        return;
      }
      // Same request, same substance → that's a yes.
      await submitConfirmedTimeOff(message, contact, pending);
      return;
    }

    await clearPendingTimeOff(contact.company_id, contact.employee_id!);
    const mergedExtracted = { ...classification.extracted };
    if (!newReason && pending.reason) mergedExtracted['reason'] = pending.reason;
    await handleSubmitTimeOff(message, contact, mergedExtracted);
    return;
  }

  const body = trimmed.toLowerCase();

  const isYes = isTimeOffAffirmation(body);
  const isNo = isTimeOffDenial(body);

  if (!isYes && !isNo) {
    // The employee didn't confirm and didn't submit a new request — but did they send
    // a different, clearly-actionable request? If so, don't hold it hostage to the
    // unconfirmed pending (which now lives up to 24h) by nagging on every message
    // (BUG-5). Abandon the unconfirmed pending and re-route so their actual request is
    // handled this turn. Clearing the pending BEFORE re-routing guarantees the recursive
    // route can't re-enter this handler (getPendingTimeOff will find nothing). We keep
    // general_question / operational_query in the nag path below — those are commonly a
    // fumbled confirmation rather than a genuine topic change.
    const MOVED_ON = new Set([
      'query_my_shifts',
      'query_my_time_off',
      // L3 — cancelling an ALREADY-APPROVED request is a different subject from
      // the unsent one being confirmed here. Without this it falls through to
      // the nag, or worse is caught by isTimeOffCancellation above and scraps
      // the wrong request.
      'cancel_time_off',
      'initiate_swap',
      'update_availability',
      'capabilities',
    ]);
    if (MOVED_ON.has(classification.intent)) {
      await clearPendingTimeOff(contact.company_id, contact.employee_id!);
      const { routeIntent } = await import('../router/intent-router');
      await routeIntent(message, contact);
      return;
    }
    await reply(
      contact,
      message,
      "Just let me know — should I send that to your manager? Or tell me what to change and I'll fix it up."
    );
    return;
  }

  if (isNo) {
    await clearPendingTimeOff(contact.company_id, contact.employee_id!);
    await reply(
      contact,
      message,
      "No worries — just send me the right date(s) and reason and I'll get it sorted."
    );
    return;
  }

  // Employee confirmed. "Yes — and say it's for the competition" both confirms
  // and corrects; honour the correction on the way through.
  const rideAlongReason = normalizeReason(parseReasonEdit(trimmed));
  await submitConfirmedTimeOff(
    message,
    contact,
    rideAlongReason ? { ...stripMemoryId(pending), reason: rideAlongReason } : pending,
  );
}

// The YES path, shared by the affirmation branch and W-2's "identical request
// re-sent means yes" (C-5). Clears the pending, creates the request, notifies
// the managers, and confirms to the employee.
async function submitConfirmedTimeOff(
  message: InboundMessage,
  contact: VerifiedContact,
  pending: PendingTimeOff
): Promise<void> {
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

  // Sim + create request + notify manager — the full treatment, shared with the
  // onboarding time-off step so both channels behave identically (D21/onboarding).
  const requestId = await createTimeOffRequestAndNotify(contact.company_id, employee, pending);
  if (!requestId) {
    await reply(
      contact,
      message,
      'There was an issue saving your request. Please try again or contact your manager directly.'
    );
    return;
  }

  const dateDisplay = formatDateRange(pending.start_date, pending.end_date);
  // No second greeting here — they just replied in an active thread, so opening
  // with "Hi Sam," again reads robotic. Keep it warm and conversational.
  //
  // W-2 call-out: PENDING-NOT-GRANTED must be unmistakable (spec §3.5) —
  // "you'll hear the moment they confirm. Until then you're still on the
  // schedule." Never anything that reads like "you're off", which causes an
  // assumed-approval no-show.
  if (pending.call_out?.length) {
    const { today } = await tenantTodayAndZone(contact.company_id);
    const shiftLine = describeCallOutShifts(pending.call_out, today);
    await reply(
      contact,
      message,
      `I've sent your call-out for ${shiftLine} to your manager — you'll hear the moment they confirm. ` +
        `Until then you're still on the schedule.`
    );
    return;
  }
  await reply(
    contact,
    message,
    `Done — I've passed your time off for ${dateDisplay} along to your manager. ` +
      "I'll let you know the moment they get back to me."
  );
}

// ── W-2 (C-5) support: pending updates + the re-rendered confirm ─────────────

// Drop the router's read-side _memory_id before re-storing (it isn't part of
// the stored shape).
function stripMemoryId(p: PendingTimeOff & { _memory_id?: string }): PendingTimeOff {
  const { _memory_id: _drop, ...rest } = p as PendingTimeOff & { _memory_id?: string };
  return rest;
}

// One writer for the pending confirm row (handleSubmitTimeOff and the gate's
// edit paths share it — Rule 0b).
async function storePendingTimeOff(
  companyId: string,
  employeeId: string,
  pending: PendingTimeOff
): Promise<void> {
  await clearPendingTimeOff(companyId, employeeId);
  await supabase.from('aegis_memory').insert({
    company_id: companyId,
    memory_type: 'observation',
    source: `pending_to:${employeeId}`,
    content: JSON.stringify(pending),
  });
}

// "Same request?" — the substance an employee would call identical: dates,
// full/partial shape, and each partial day's window. Reason differences are
// handled separately (they update in place).
export function samePendingRequest(
  pending: { start_date: string; end_date: string; time_off_type: 'full_day' | 'partial'; partial_days: PartialDayDetail[] | null },
  parsed: ParsedRequest
): boolean {
  if (pending.start_date !== parsed.start_date || pending.end_date !== parsed.end_date) return false;
  if (pending.time_off_type !== parsed.time_off_type) return false;
  const canon = (days: PartialDayDetail[] | null): string =>
    (days ?? [])
      .map(d => `${d.date}|${(d.start_time ?? '').slice(0, 5)}|${(d.end_time ?? '').slice(0, 5)}`)
      .sort()
      .join(';');
  return canon(pending.partial_days) === canon(parsed.partial_days);
}

// Re-show the confirm after an in-place edit — same ask, one line acknowledging
// the change, so the employee sees their correction landed (C-5's whole point).
async function replyWithUpdatedConfirm(
  message: InboundMessage,
  contact: VerifiedContact,
  pending: PendingTimeOff
): Promise<void> {
  const summary = formatRequestSummary({
    start_date: pending.start_date,
    end_date: pending.end_date,
    time_off_type: pending.time_off_type,
    partial_days: pending.partial_days,
    unscheduled_dates: [],
  });
  const forReason = pending.reason ? ` for ${pending.reason}` : '';
  if (pending.call_out?.length) {
    const { today } = await tenantTodayAndZone(contact.company_id);
    const line = describeCallOutShifts(pending.call_out, today);
    await reply(contact, message,
      `Got it — updated. You're calling out of ${line}${forReason}. Want me to send that to your manager right away?`);
    return;
  }
  await reply(contact, message,
    `Got it — updated. That's ${summary} off${forReason}. Want me to send that over to your manager?`);
}

// ── W-2 (C-5): post-send reason edit ─────────────────────────────────────────
//
// Maisey, after her request had already gone to Jack: "make sure to say it's
// for the competition" → the scope wall ("I can't help with drafting messages
// or adding notes"). The request is HERS and the reason is a column on her own
// pending row — update it, tell the managers in a short FYI (never a second
// approval email; the original links still work), and confirm to her.
// Reached via the deterministic classifier backstop (edit_time_off_reason) —
// no new model calls.
export async function handleTimeOffReasonEdit(
  message: InboundMessage,
  contact: VerifiedContact,
  _extracted: Record<string, unknown>
): Promise<void> {
  if (!contact.employee_id) {
    await reply(contact, message, "I couldn't find your employee record. Please contact your manager directly.");
    return;
  }
  const reason = normalizeReason(parseReasonEdit(message.body));
  if (!reason) {
    await reply(contact, message, "Happy to add that — what should I tell your manager the reason is?");
    return;
  }

  const { today } = await tenantTodayAndZone(contact.company_id);
  // The most recent still-PENDING request is the one a correction is about —
  // an approved/denied one is decided, and editing its reason would rewrite
  // history under the manager's decision.
  const { data } = await supabase
    .from('time_off_requests')
    .select('id, start_date, end_date, reason, status')
    .eq('employee_id', contact.employee_id)
    .eq('company_id', contact.company_id)
    .eq('status', 'pending')
    .gte('end_date', today)
    .order('requested_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = data as { id: string; start_date: string; end_date: string; reason: string | null } | null;

  if (!row) {
    await reply(
      contact,
      message,
      "I don't see a request of yours still waiting on your manager, so there's nothing to add that to. " +
        'If you meant a new request, just send me the dates and the reason together.'
    );
    return;
  }

  const { error } = await supabase
    .from('time_off_requests')
    .update({ reason })
    .eq('id', row.id)
    .eq('status', 'pending'); // optimistic: never rewrite a decided row
  if (error) {
    await reply(contact, message, "I couldn't save that just now — please try again in a moment.");
    return;
  }

  const dateDisplay = formatDateRange(row.start_date, row.end_date);
  await logActivity({
    company_id: contact.company_id,
    action: 'time_off_reason_updated',
    entity_type: 'time_off_request',
    entity_id: row.id,
    summary: `${contact.name} added a reason to their pending time-off request for ${dateDisplay}: "${reason}"`,
    metadata: { employee_id: contact.employee_id, previous_reason: row.reason, reason },
  });

  // FYI to the managers — informational, threaded under the original where the
  // channel allows; the approve/deny buttons they already have stay live.
  await sendManagerResolutionNotice({
    companyId: contact.company_id,
    decidedByUserId: null,
    decidedByName: null,
    summary: `${contact.name} added a reason to the pending time-off request for ${dateDisplay}: "${reason}". Nothing new to do — the approve/deny links in the earlier email still work.`,
    subject: `Reason added — ${contact.name}'s time-off request (${dateDisplay})`,
    body:
      `${contact.name} added a reason to their pending time-off request for ${dateDisplay}: "${reason}".\n\n` +
      `Nothing new to do — the approve and deny links in the earlier email still work and now carry this reason on the record.`,
  });

  await reply(
    contact,
    message,
    `Done — your request for ${dateDisplay} now says it's for ${reason}, and your manager has the note.`
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

  // W-2: tenant-local "today" (CLAUDE.md hard rule — this read was server-UTC,
  // which hid a request from a late-evening "where does it stand?" query).
  const { today } = await tenantTodayAndZone(contact.company_id);

  // Surface EVERY current/upcoming request with its status, not just approved
  // (Batch-1.5 #5): "where does my request stand?" for a PENDING request used to
  // read "no approved time off." Pending + approved + denied all answer "where it
  // stands"; still windowed to end_date >= today so old history doesn't pile up.
  const { data } = await supabase
    .from('time_off_requests')
    .select('id, start_date, end_date, time_off_type, partial_days, status')
    .eq('employee_id', contact.employee_id)
    .eq('company_id', contact.company_id)
    .gte('end_date', today)
    .order('start_date', { ascending: true });

  const rows = (data ?? []) as Array<{
    id: string;
    start_date: string;
    end_date: string;
    time_off_type: 'full_day' | 'partial' | null;
    partial_days: PartialDayDetail[] | null;
    // L3 — 'cancelled' added (migration 022).
    status: 'pending' | 'approved' | 'denied' | 'cancelled' | null;
  }>;

  // W-2 — which of these were CALL-OUTS. The marker lives on the to_thread:<id>
  // side row (no schema change); one read for all listed requests.
  const callOutIds = new Set<string>();
  if (rows.length > 0) {
    const { data: threadRows } = await supabase
      .from('aegis_memory')
      .select('source, content')
      .eq('company_id', contact.company_id)
      .in('source', rows.map(r => `to_thread:${r.id}`));
    for (const tr of (threadRows ?? []) as Array<{ source: string; content: string }>) {
      try {
        const parsed = JSON.parse(tr.content) as { call_out?: unknown };
        if (Array.isArray(parsed.call_out) && parsed.call_out.length > 0) {
          callOutIds.add(tr.source.slice('to_thread:'.length));
        }
      } catch { /* ignore malformed side rows */ }
    }
  }

  if (rows.length === 0) {
    await reply(
      contact,
      message,
      `${textOpener(contact.name)}You don't have any time off on file coming up. You can request time off by texting me the dates you need.`
    );
    return;
  }

  // L3 — every branch is now EXPLICIT. This used to be a two-test ternary whose
  // else-branch said "Pending — awaiting your manager", and the query above
  // applies no status filter — so the moment a 'cancelled' row existed, the
  // employee who had just cancelled would ask "what time off do I have?" and be
  // told it was still pending with their manager.
  const statusLabel = (s: string | null): string => {
    if (s === 'approved') return 'Approved';
    if (s === 'denied') return 'Not approved';
    if (s === 'cancelled') return 'Cancelled by you';
    if (s === 'pending' || s === null) return 'Pending — awaiting your manager';
    // An unrecognised status must not be reported as any of the above. Say what
    // we know and nothing more.
    return `Status: ${s}`;
  };

  const lines = rows.map(row => {
    const dateRange = formatDateRange(row.start_date, row.end_date);
    // W-2 — a call-out is named as one, so "what did I send in?" matches what
    // the employee actually did ("I called out", not generic time off).
    const stat = (callOutIds.has(row.id) ? 'Call-out — ' : '') + statusLabel(row.status);
    const parsed: ParsedRequest = {
      start_date: row.start_date,
      end_date: row.end_date,
      time_off_type: row.time_off_type === 'partial' ? 'partial' : 'full_day',
      partial_days: row.partial_days ?? null,
      unscheduled_dates: [],
    };

    if (parsed.time_off_type === 'full_day' || !parsed.partial_days || parsed.partial_days.length === 0) {
      return `• ${dateRange}: Full day — ${stat}`;
    }

    const sample = parsed.partial_days[0];
    const allSame = parsed.partial_days.every(
      d => d.start_time === sample.start_time && d.end_time === sample.end_time && d.shift_name === sample.shift_name
    );

    if (allSame) {
      const hours = sample.start_time && sample.end_time ? formatClockRange(sample.start_time, sample.end_time) : null;
      const detail = sample.shift_name
        ? (hours ? `${sample.shift_name} ${hours}` : sample.shift_name)
        : hours ?? 'partial';
      return `• ${dateRange}: Partial (${detail}) — ${stat}`;
    }

    const perDay = parsed.partial_days
      .map(d => {
        const hours = d.start_time && d.end_time ? formatClockRange(d.start_time, d.end_time) : null;
        const label = d.shift_name
          ? (hours ? `${d.shift_name} ${hours}` : d.shift_name)
          : hours ?? 'partial';
        return `${formatShortDate(d.date)} ${label}`;
      })
      .join(', ');
    return `• ${dateRange}: Partial (${perDay}) — ${stat}`;
  });

  const header =
    rows.length === 1
      ? "Here's where your time off stands:"
      : `Here's where your ${rows.length} time-off requests stand:`;

  await reply(contact, message, `${textOpener(contact.name)}${header}\n\n${lines.join('\n')}`);
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
      `${textOpener(contact.name)}I looked but couldn't find a pending time-off request${scope} to re-check. ` +
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
      `${textOpener(contact.name)}I started to re-check ${targetFirst}'s time off for ${dateDisplay}, but the request seems to have gone missing on me — it may have just been acted on. Mind giving it another try in a moment?`
    );
    return;
  }

  if (result.status === 'skipped_no_requirements') {
    await reply(
      contact,
      message,
      `${textOpener(contact.name)}I re-checked ${targetFirst}'s time off for ${dateDisplay}, but there's no shift schedule to measure it against yet — so I can't speak to coverage either way.${pickedNote} Once shift requirements are set up, I'll be able to give you a real read.`
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
    `${textOpener(contact.name)}Re-checked ${targetName}'s time off for ${dateDisplay} against everything approved so far — ${lean}.${pickedNote}${tail}`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// L3 — EMPLOYEE-INITIATED CANCELLATION OF ALREADY-APPROVED TIME OFF
// ═══════════════════════════════════════════════════════════════════════════════
//
// An employee can withdraw time off their manager has already approved, by text,
// two ways:
//   1. PROACTIVELY, naming a date — "cancel my time off Aug 1".
//   2. REACTIVELY, when it surfaces mid-conversation — a shift swap is refused
//      because "you have approved time off on that date", and they can cancel it
//      right there (see shift-swap.ts, the youTakeTheirs refusal).
//
// ── SCOPE DECISION: whole-request cancellation, never partial ────────────────
//
// Approved time off is a RANGE (start_date/end_date). An employee naming ONE
// date inside a multi-day approval cancels the WHOLE request — there is no
// partial cancellation, and deliberately so:
//
//   • `time_off_requests` has no mechanism to shrink an approved range. Doing it
//     would mean rewriting start_date/end_date (silently editing a decision the
//     manager made) or splitting the row into two (inventing an approval the
//     manager never granted). Both are Rule 0 violations.
//   • `partial_days` models WITHIN-day windows, not a subset of days, so it
//     can't express "cancel Wednesday out of Mon–Fri" either.
//
// So the confirmation must show the FULL RANGE, not the date they typed, and
// when it spans more than a day it says so in as many words. An employee who
// texts "cancel my time off Aug 1" while holding an approved Aug 1–5 must not be
// able to answer YES without having seen that all five days are going.
//
// If partial cancellation is ever wanted, it is a schema change plus a manager
// re-approval flow — not a tweak here.
//
// A CONFIRMATION IS MANDATORY, and that is a product requirement, not a nicety.
// Everything else Aegis does for an employee is additive or reversible; this is
// the one employee-triggered action that destroys something a MANAGER already
// granted, and it frees a day the scheduler will immediately start filling. So:
// state the date back in full, ask, and act only on an explicit yes.
//
// ── Why its own gate, and why a SHORT one ────────────────────────────────────
//
// The existing pending-time-off gate (`pending_to:`) holds an UNSENT request for
// 24h. That TTL is right there: nothing has happened yet, and a stale "yes" just
// submits a request the manager still has to approve.
//
// This gate holds a DESTRUCTIVE answer about an APPROVED request, so it expires
// in ONE HOUR. A day-old "yes" arriving with no memory of the question would
// silently cancel someone's approved vacation. An hour is far longer than any
// real reply and short enough that a stray "yes" can't reach back to it.
//
// ── The keyword landmine ─────────────────────────────────────────────────────
//
// webhooks/sms.ts treats a bare "CANCEL" (also STOP/END/QUIT/UNSUBSCRIBE) as a
// carrier-mandated SMS OPT-OUT, before verification and before routing. It flips
// sms_consent_state to 'opted_out'. So this flow must NEVER invite the employee
// to "reply CANCEL to confirm" — they would unsubscribe from Aegis entirely and
// their time off would stay booked. Confirmation copy asks for YES / NO only.
// ("cancel my time off" is a phrase, not the bare keyword, so inbound requests
// are unaffected.)

/**
 * Inclusive day count for an approved range. Both ends are `date` columns, so
 * this is anchored at noon UTC to stay DST-proof (same convention as
 * eachDateInRange above). Exported for testing.
 */
export function countDaysInclusive(startDate: string, endDate: string): number {
  const s = new Date(`${startDate}T12:00:00Z`).getTime();
  const e = new Date(`${endDate}T12:00:00Z`).getTime();
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return 1;
  return Math.round((e - s) / (24 * 60 * 60 * 1000)) + 1;
}

/** aegis_memory source key for a cancellation awaiting a yes/no. */
function timeOffCancelSource(employeeId: string): string {
  return `to_cancel_pending:${employeeId}`;
}

/** ONE HOUR — see the header. Deliberately not the 24h used by `pending_to:`. */
const TO_CANCEL_TTL_MS = 60 * 60 * 1000;

export interface CancelTarget {
  id: string;
  start_date: string;
  end_date: string;
  status: 'approved' | 'pending';
}

interface PendingTimeOffCancel {
  employee_id: string;
  /** The first target (kept for older pendings written before W-1 branch 4). */
  request_id: string;
  start_date: string;
  end_date: string;
  /** Rendered once at ask time so the confirmation and the receipt agree. */
  display_range: string;
  /** W-1 branch 4: EVERY row this cancellation targets ("all of them"). */
  targets?: CancelTarget[];
  /** Where the question was asked from, so the answer can be threaded back. */
  channel: 'sms' | 'email';
  sender: string;
  recipient: string;
  raw_subject?: string;
  thread_id?: string;
  expires_at: string;
}

export async function getPendingTimeOffCancel(
  companyId: string,
  employeeId: string
): Promise<(PendingTimeOffCancel & { _memory_id: string }) | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .eq('source', timeOffCancelSource(employeeId))
    .maybeSingle();

  if (!data) return null;

  try {
    const row = data as { id: string; content: string };
    const pending = JSON.parse(row.content) as PendingTimeOffCancel;
    if (new Date(pending.expires_at) < new Date()) {
      await supabase.from('aegis_memory').delete().eq('id', row.id);
      return null;
    }
    return { ...pending, _memory_id: row.id };
  } catch {
    return null;
  }
}

export async function clearPendingTimeOffCancel(companyId: string, employeeId: string): Promise<void> {
  await supabase
    .from('aegis_memory')
    .delete()
    .eq('company_id', companyId)
    .eq('source', timeOffCancelSource(employeeId));
}

async function storePendingTimeOffCancel(companyId: string, pending: PendingTimeOffCancel): Promise<void> {
  // Delete-then-insert, matching storePendingSwap — there is no unique index on
  // (company_id, source) to upsert against.
  await clearPendingTimeOffCancel(companyId, pending.employee_id);
  await supabase.from('aegis_memory').insert({
    company_id: companyId,
    memory_type: 'observation',
    content: JSON.stringify(pending),
    source: timeOffCancelSource(pending.employee_id),
  });
}

/**
 * Finds the employee's APPROVED request covering `date`.
 *
 * Only `status='approved'` — a pending request is withdrawn through the existing
 * pending-time-off path, and a denied one has nothing to cancel. Range-covering
 * match (`start_date <= date <= end_date`) mirrors the swap flow's TO check, so
 * a single day inside an approved week resolves to that week's request.
 *
 * Exported for testing and for the reactive path in shift-swap.ts.
 */
export async function findApprovedTimeOffOn(
  companyId: string,
  employeeId: string,
  date: string
): Promise<{ id: string; start_date: string; end_date: string } | null> {
  const { data } = await supabase
    .from('time_off_requests')
    .select('id, start_date, end_date')
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .eq('status', 'approved')
    .lte('start_date', date)
    .gte('end_date', date)
    .order('start_date', { ascending: true })
    .limit(1);

  const rows = (data ?? []) as Array<{ id: string; start_date: string; end_date: string }>;
  return rows[0] ?? null;
}

/**
 * Asks the confirmation question and parks the pending answer.
 *
 * Shared by the proactive path (handleCancelTimeOff) and the reactive one (a
 * swap blocked by time off) so both phrase it identically — RULE 0b.
 */
// "Aug 1–5 (approved)" — the one way a target is named in the ask and the receipt.
export function describeCancelTarget(t: { start_date: string; end_date: string; status?: string }): string {
  const range = formatDateRange(t.start_date, t.end_date);
  return t.status === 'pending' ? `${range} (still waiting on your manager)` : range;
}

function joinNatural(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export async function askToCancelTimeOff(opts: {
  message: InboundMessage;
  contact: VerifiedContact;
  /** One row (the reactive swap path) or several ("all of them"). */
  request: { id: string; start_date: string; end_date: string; status?: 'approved' | 'pending' } | CancelTarget[];
  /** Extra sentence explaining WHY we're offering, for the reactive path. */
  lead?: string;
}): Promise<void> {
  const { message, contact, lead } = opts;
  const targets: CancelTarget[] = (Array.isArray(opts.request) ? opts.request : [opts.request])
    .map(r => ({ id: r.id, start_date: r.start_date, end_date: r.end_date, status: r.status ?? 'approved' }));
  const first = targets[0];
  // The FULL range of each request — never the single date the employee happened
  // to name. formatDateRange renders a multi-day request as e.g. "Aug 1-5, 2026".
  const displayRange = joinNatural(targets.map(describeCancelTarget));
  const dayCount = targets.length === 1 ? countDaysInclusive(first.start_date, first.end_date) : 0;
  // Spell the span out. A range buried in a date string is easy to skim past,
  // and this is a destructive, whole-request action.
  const spanNote = dayCount > 1
    ? ` That's all ${dayCount} days — ${formatDateRange(first.start_date, first.end_date)} — not just the one day.`
    : '';

  await storePendingTimeOffCancel(contact.company_id, {
    employee_id: contact.employee_id!,
    request_id: first.id,
    start_date: first.start_date,
    end_date: first.end_date,
    display_range: displayRange,
    targets,
    channel: message.channel,
    sender: message.sender,
    recipient: message.recipient,
    raw_subject: message.raw_subject,
    thread_id: message.thread_id,
    expires_at: new Date(Date.now() + TO_CANCEL_TTL_MS).toISOString(),
  });

  // A natural yes/no question — and never "reply CANCEL", which is a carrier
  // opt-out keyword (see the header).
  const what = targets.length === 1
    ? (first.status === 'pending'
        ? `withdraw your time-off request for ${formatDateRange(first.start_date, first.end_date)} (it's still waiting on your manager)`
        : `cancel your approved time off on ${formatDateRange(first.start_date, first.end_date)}`)
    : `cancel all ${targets.length} of these: ${displayRange}`;
  await reply(
    contact,
    message,
    `${lead ? `${lead} ` : `${textOpener(contact.name)}`}` +
      `Just checking — are you sure you want me to ${what}?${spanNote} ` +
      `Say yes and I'll take care of it, or no to leave ${targets.length === 1 ? 'it' : 'them'} as ${targets.length === 1 ? 'it is' : 'they are'}.`
  );
}

// ── W-1 branch 4 (C-6, J-1c): which request(s) does the employee mean? ───────
//
// Deterministic read of the referents in a cancel message. "The pending one",
// "that one", "all of them", "everything from today" (= requests MADE today,
// tenant-local — Maisey's "undo all of my requests for today" was read as
// requests ABOUT today and found none; there were three). No model call.
export interface CancelReferent {
  all: boolean;          // "all", "everything", "both", "every one"
  madeToday: boolean;    // "today" in a cancel means REQUESTED today
  pendingOnly: boolean;  // "the pending one", "the one waiting", "not approved yet"
  approvedOnly: boolean; // "the approved one"
  latest: boolean;       // "that one", "the last one", "the one I just sent", "it"
}

export function parseCancelReferent(body: string): CancelReferent {
  const t = (body || '').toLowerCase();
  return {
    all: /\b(all of (?:them|my|the)|all (?:my|the|of them|three|two)|everything|every one|both|each of them)\b/.test(t),
    madeToday: /\btoday\b|\bthis morning\b|\bjust (?:now|sent|made|put in|submitted)\b|\bearlier\b/.test(t),
    pendingOnly: /\bpending\b|\bwaiting\b|\bnot (?:yet )?approved\b|\bunapproved\b|\bstill with (?:my )?manager\b/.test(t),
    approvedOnly: /\bapproved one\b|\bthe approved\b/.test(t),
    latest: /\b(that one|this one|the last one|the (?:one|request) i just|it)\b/.test(t),
  };
}

/** The employee's cancellable rows (approved or still pending) ending today or later. */
export async function loadCancellableTimeOff(companyId: string, employeeId: string, today: string): Promise<Array<CancelTarget & { requested_at: string | null }>> {
  const { data } = await supabase
    .from('time_off_requests')
    .select('id, start_date, end_date, status, requested_at')
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .in('status', ['approved', 'pending'])
    .gte('end_date', today)
    .order('start_date', { ascending: true });
  return ((data ?? []) as Array<{ id: string; start_date: string; end_date: string; status: 'approved' | 'pending'; requested_at: string | null }>);
}

/**
 * Pure: pick the target rows from the candidates, the extracted date and the
 * referents. Returns the rows to offer, or 'ask' when it can't be settled.
 */
export function resolveCancelTargets(input: {
  candidates: Array<CancelTarget & { requested_at: string | null }>;
  date: string | null;
  referent: CancelReferent;
  today: string;
  timezone: string;
}): { kind: 'targets'; rows: CancelTarget[] } | { kind: 'ask'; rows: CancelTarget[] } | { kind: 'none' } {
  const { candidates, date, referent, today, timezone } = input;
  if (candidates.length === 0) return { kind: 'none' };
  let pool = candidates;
  if (referent.pendingOnly) pool = pool.filter(c => c.status === 'pending');
  if (referent.approvedOnly) pool = pool.filter(c => c.status === 'approved');
  if (referent.madeToday) {
    pool = pool.filter(c => {
      if (!c.requested_at) return false;
      const local = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(c.requested_at));
      return local === today;
    });
  }
  if (date) {
    const covering = pool.filter(c => c.start_date <= date && c.end_date >= date);
    if (covering.length >= 1) return { kind: 'targets', rows: covering };
    // A date that matches nothing: fall through to the other referents, else say so.
    if (!referent.all && !referent.latest && !referent.pendingOnly) return { kind: 'none' };
  }
  if (pool.length === 0) return { kind: 'none' };
  if (referent.all) return { kind: 'targets', rows: pool };
  if (pool.length === 1) return { kind: 'targets', rows: [pool[0]] };
  if (referent.latest) {
    const byCreated = [...pool].sort((a, b) => (b.requested_at ?? '').localeCompare(a.requested_at ?? ''));
    return { kind: 'targets', rows: [byCreated[0]] };
  }
  return { kind: 'ask', rows: pool };
}

/**
 * Proactive entry point: "cancel my time off on Aug 1".
 *
 * Never cancels anything itself — it only resolves the request and asks.
 */
export async function handleCancelTimeOff(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  if (!contact.employee_id) {
    await reply(contact, message,
      "I can only cancel time off for an employee record I recognise — please check with your manager.");
    return;
  }

  const dateRaw = typeof extracted['date'] === 'string' ? extracted['date'].trim() : '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null;
  const { today, timezone } = await tenantTodayAndZone(contact.company_id);

  // W-1 branch 4 (J-1c, C-6): PENDING requests are cancellable too — "Cancel the
  // pending one" used to be told there was nothing on file thirty seconds after
  // Aegis had listed it. And the referents in the message ("that one", "all of
  // them", "everything from today") are honoured. Never guesses on a destructive
  // action: anything unsettled lists the options and asks.
  const candidates = await loadCancellableTimeOff(contact.company_id, contact.employee_id, today);
  const referent = parseCancelReferent(message.body);
  const resolved = resolveCancelTargets({ candidates, date, referent, today, timezone });

  if (resolved.kind === 'none') {
    if (date && candidates.length > 0) {
      const list = joinNatural(candidates.map(describeCancelTarget));
      await reply(contact, message,
        `${textOpener(contact.name)}I don't see any time off for you on ${formatDateRange(date, date)}. ` +
        `What you do have coming up: ${list}. Tell me which one and I'll take care of it.`);
      return;
    }
    await reply(contact, message,
      referent.madeToday && candidates.length > 0
        ? `${textOpener(contact.name)}You didn't put in any time-off requests today. What you have coming up: ${joinNatural(candidates.map(describeCancelTarget))}. Tell me which one to cancel.`
        : `${textOpener(contact.name)}You don't have any time off coming up to cancel — nothing approved and nothing waiting on your manager.`);
    return;
  }

  if (resolved.kind === 'ask') {
    const list = joinNatural(resolved.rows.map(describeCancelTarget));
    await reply(contact, message,
      `${textOpener(contact.name)}Which one did you want to cancel? You have ${list}. ` +
      `Just tell me the date — or say "all of them".`);
    return;
  }

  await askToCancelTimeOff({ message, contact, request: resolved.rows });
}

/**
 * The yes/no answer. Reached from the router BEFORE intent classification,
 * because a bare "yes" carries no intent of its own.
 */
export async function handleTimeOffCancelConfirmation(
  message: InboundMessage,
  contact: VerifiedContact,
  pending: PendingTimeOffCancel & { _memory_id: string }
): Promise<void> {
  const trimmed = message.body.trim();

  // NO / anything declining → leave the time off exactly as it is.
  if (isTimeOffDenial(trimmed)) {
    await clearPendingTimeOffCancel(contact.company_id, contact.employee_id!);
    await reply(contact, message,
      `No problem — your time off on ${pending.display_range} is still booked. Nothing changed.`);
    return;
  }

  if (!isTimeOffAffirmation(trimmed)) {
    // Not an answer. Let a real intent through rather than trapping them in the
    // gate — the same shape the swap confirm uses. The pending is cleared BEFORE
    // re-routing so the new message can't bounce straight back in here.
    const { employeeInterruptIntent } = await import('../router/interrupt');
    const interrupt = await employeeInterruptIntent(message, contact);
    if (interrupt) {
      await clearPendingTimeOffCancel(contact.company_id, contact.employee_id!);
      const { routeIntent } = await import('../router/intent-router');
      await routeIntent(message, contact);
      return;
    }
    await reply(contact, message,
      `Just to be sure before I cancel anything — should I cancel your time off on ${pending.display_range}? ` +
      `Reply YES or NO.`);
    return;
  }

  // ── YES ────────────────────────────────────────────────────────────────────
  //
  // Re-read each row before writing. The confirmation may be an hour old, and in
  // the meantime a manager could have changed it. Cancelling something that is
  // no longer approved/pending would be acting on a stale premise.
  const targets: CancelTarget[] = pending.targets?.length
    ? pending.targets
    : [{ id: pending.request_id, start_date: pending.start_date, end_date: pending.end_date, status: 'approved' }];

  const done: CancelTarget[] = [];
  const changed: CancelTarget[] = [];
  const failed: CancelTarget[] = [];
  for (const t of targets) {
    const { data: current } = await supabase
      .from('time_off_requests')
      .select('id, status, start_date, end_date')
      .eq('id', t.id)
      .eq('company_id', contact.company_id)
      .maybeSingle();
    const row = current as { id: string; status: string; start_date: string; end_date: string } | null;
    if (!row || (row.status !== 'approved' && row.status !== 'pending')) { changed.push(t); continue; }

    const { error: cancelErr } = await supabase
      .from('time_off_requests')
      .update({ status: 'cancelled', decided_at: new Date().toISOString() })
      .eq('id', t.id)
      .eq('company_id', contact.company_id)
      .eq('status', row.status); // optimistic guard — never clobber a concurrent decision

    if (cancelErr) {
      // FAIL CLOSED AND SAY SO. The single most likely cause is migration 022 not
      // having been run (check-constraint violation, 23514): the code would then
      // ask "are you sure?", get a yes, and — without this branch — reply as if it
      // had worked while the day stayed booked.
      console.error(
        `[time-off-cancel] FAILED to cancel request ${t.id} for employee ` +
        `${contact.employee_id}: ${cancelErr.message}. ` +
        `If this is a check-constraint violation, migration 022 has not been run.`
      );
      failed.push(t);
      continue;
    }

    // Any live manager approve/deny magic links for this request now point at a
    // cancelled row. Retire them so a manager clicking a stale email button can't
    // resurrect it. Best-effort — a leftover token fails safe (the update is
    // guarded on status='pending' upstream), this just avoids the confusing page.
    await supabase
      .from('aegis_memory')
      .delete()
      .eq('company_id', contact.company_id)
      .like('source', 'decision_token:%')
      .like('content', `%${t.id}%`);

    await logActivity({
      company_id: contact.company_id,
      action: 'time_off_cancelled_by_employee',
      entity_type: 'time_off_request',
      entity_id: t.id,
      summary: row.status === 'pending'
        ? `${contact.name} withdrew their own pending time-off request (${formatDateRange(row.start_date, row.end_date)}).`
        : `${contact.name} cancelled their own approved time off (${formatDateRange(row.start_date, row.end_date)}).`,
      metadata: {
        employee_id: contact.employee_id,
        request_id: t.id,
        start_date: row.start_date,
        end_date: row.end_date,
        previous_status: row.status,
        channel: message.channel,
      },
    });
    done.push({ ...t, status: row.status as 'approved' | 'pending' });
  }

  if (failed.length > 0 && done.length === 0) {
    // Leave the pending in place so a retry after the migration still works.
    await reply(contact, message,
      `I wasn't able to cancel that just now — something went wrong on my end, so your time off on ` +
      `${pending.display_range} is still booked. Please let your manager know directly.`);
    return;
  }

  await clearPendingTimeOffCancel(contact.company_id, contact.employee_id!);

  if (done.length === 0) {
    await reply(contact, message,
      `Something changed with ${targets.length === 1 ? 'that request' : 'those requests'} since I asked — ` +
      `${targets.length === 1 ? "it's" : "they're"} no longer showing as approved or pending, so I haven't touched anything. ` +
      `Ask me "what time off do I have?" for where things stand now.`);
    return;
  }

  const doneText = joinNatural(done.map(describeCancelTarget));
  const backOn = done.some(d => d.status === 'approved') ? ` and you're back on the schedule for those days` : '';
  const leftover = [...changed, ...failed];
  const leftoverNote = leftover.length > 0
    ? ` I couldn't touch ${joinNatural(leftover.map(describeCancelTarget))} — ask me "what time off do I have?" to see where ${leftover.length === 1 ? 'it stands' : 'they stand'}.`
    : '';
  await reply(contact, message,
    `Done — ${doneText} ${done.length === 1 ? 'is' : 'are'} cancelled${backOn}. I've let your manager know.${leftoverNote}`);

  await notifyManagersOfTimeOffCancellation(contact, done);
}

/**
 * Manager FYI — one notice through the shared resolver (text first, threaded
 * email fallback, revoked logins excluded). This closes OPEN_ITEMS #2's last
 * bespoke email. Failure is swallowed: the employee's cancellation has already
 * succeeded and must not be reported as failed because a notice bounced.
 */
async function notifyManagersOfTimeOffCancellation(
  contact: VerifiedContact,
  done: CancelTarget[],
): Promise<void> {
  try {
    const approved = done.filter(d => d.status === 'approved');
    const pendingOnes = done.filter(d => d.status === 'pending');
    const what = [
      approved.length ? `cancelled their approved time off for ${joinNatural(approved.map(d => formatDateRange(d.start_date, d.end_date)))}` : '',
      pendingOnes.length ? `withdrew their pending request for ${joinNatural(pendingOnes.map(d => formatDateRange(d.start_date, d.end_date)))}` : '',
    ].filter(Boolean).join(' and ');
    const summary = `${contact.name} ${what}`;
    await sendManagerResolutionNotice({
      companyId: contact.company_id,
      decidedByUserId: null,
      decidedByName: contact.name,
      summary,
      subject: `${summary}`,
      body:
        `${summary}.\n\n` +
        (approved.length
          ? `They're available for those days again, so the schedule builder will include them from now on. ` +
            `Any already-published schedule for that week is unchanged — take a look if you need them covering a shift.\n\n`
          : '') +
        `No action is needed unless you want to adjust the schedule.`,
    });
  } catch (err) {
    console.error('[time-off-cancel] manager notice failed (non-fatal):', err);
  }
}
