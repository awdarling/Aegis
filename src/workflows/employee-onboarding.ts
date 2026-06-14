// -- Migration required in Supabase (no-op for this codebase: sessions are JSON
// -- in aegis_memory.content, not a dedicated table — kept here for parity with
// -- the spec / future schema migration):
// --   ALTER TABLE onboarding_sessions
// --     ADD COLUMN IF NOT EXISTS opt_in_confirmed boolean DEFAULT false;
// --   ALTER TABLE onboarding_sessions
// --     ADD COLUMN IF NOT EXISTS opt_in_sent_at timestamptz;

import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../db/client';
import { coerceJsonObject } from '../utils/coerce-json';
import { logActivity } from '../logger/activity-log';
import { sendSms } from '../messaging/sms';
import { sendEmail } from '../messaging/email';
import { reply, sendInThreadAck } from '../messaging/reply';
import { greeting } from '../messaging/greeting';
import { env } from '../config/env';
import { withAnthropicRetry } from '../ai/claude';
import { generateActionToken } from '../lib/aegis-actions/tokens';
import { formatDateRange } from './time-off';
import type { InboundMessage, VerifiedContact } from '../security/types';
import type { Employee } from '../db/types';

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AvailabilitySlot {
  day_of_week: number; // 0=Sun, 6=Sat
  start_time: string;  // HH:MM 24h
  end_time: string;    // HH:MM 24h
}

export interface OnboardingSession {
  company_id: string;
  employee_id: string;
  employee_name: string;
  employee_phone: string | null;
  employee_email: string | null;
  employee_channel: 'sms' | 'email';
  aegis_sms_channel: string;
  manager_contact: string;
  manager_channel: 'sms' | 'email';
  manager_sender: string;
  manager_recipient: string;
  step: 'opt_in' | 'name_confirm' | 'email' | 'role' | 'availability' | 'availability_confirm' | 'time_off' | 'complete';
  collected: {
    name_confirmed: boolean;
    email: string | null;
    role: string | null;
    availability_raw: string | null;
    availability_parsed: AvailabilitySlot[];
    availability_confirmed: boolean;
    time_off_submitted: boolean;
  };
  flagged_low_availability: boolean;
  invalid_email_attempts: number;
  invalid_availability_attempts: number;
  warned_24h: boolean;
  // TCPA opt-in: employees must reply YES before Aegis sends any further
  // onboarding content. Sessions reaching the router with opt_in_confirmed
  // false are gated through handleOptInStep until the employee confirms.
  opt_in_confirmed: boolean;
  opt_in_sent_at: string | null;
  started_at: string;
  expires_at: string;
}

interface ShiftBounds {
  earliest_start: string;
  latest_end: string;
  min_shift_hours: number;
}

// A rotating (e.g. "every other week") custom-availability change: a cycle of N
// weeks, each with its own day/time pattern, anchored to a calendar week.
export interface RotationWeek {
  week: number; // 1-indexed week within the cycle
  days: AvailabilitySlot[];
}
export interface RotationSpec {
  cycle_weeks: number;        // length of the cycle (e.g. 2 for "every other week")
  cycle_start_date: string;   // YYYY-MM-DD anchor — the start of "week 1"
  weeks: RotationWeek[];
  end_date?: string | null;   // optional YYYY-MM-DD when the rotation stops
}

// Human-readable per-week grid for confirmations + the manager email.
export function formatRotationWeeks(rotation: RotationSpec): string {
  return rotation.weeks
    .map(w => `Week ${w.week}:\n${w.days.length ? formatAvailabilityList(w.days) : '  (off — not available)'}`)
    .join('\n\n');
}

interface PendingAvailUpdate {
  employee_id: string;
  employee_name: string;
  company_id: string;
  current_availability: AvailabilitySlot[];
  proposed_availability: AvailabilitySlot[];
  availability_raw: string;
  employee_sender: string;
  employee_recipient: string;
  // Set (YYYY-MM-DD) when this is a TEMPORARY, date-limited custom-availability
  // change ("until <date>"); absent/null for a normal permanent availability change.
  custom_end_date?: string | null;
  // Set when this is a ROTATING custom-availability change ("every other week").
  rotation?: RotationSpec | null;
  expires_at: string;
}

interface PendingManagerAvailApproval {
  employee_id: string;
  employee_name: string;
  company_id: string;
  current_availability: AvailabilitySlot[];
  proposed_availability: AvailabilitySlot[];
  availability_raw: string;
  employee_sender: string;
  employee_recipient: string;
  // Channel + threading metadata for the eventual approve/deny notice. Captured
  // from the employee's inbound YES (handleAvailabilityConfirmResponse) so the
  // manager-decision reply lands on the same channel + thread as the employee
  // started on. thread_id/raw_subject are null for SMS submissions.
  employee_channel: 'sms' | 'email';
  thread_id?: string | null;
  raw_subject?: string | null;
  custom_end_date?: string | null;
  rotation?: RotationSpec | null;
  expires_at: string;
}

export interface OnboardingFanoutPending {
  company_id: string;
  manager_contact: string;
  manager_channel: 'sms' | 'email';
  manager_sender: string;
  manager_recipient: string;
  aegis_sms_channel: string;
  target_employee_ids: string[];
  expires_at: string;
}

// Test employee setup: add Bubba Ganush to Watermark's company via Supabase SQL,
// not via this file. Required fields:
//   name='Bubba Ganush', contact_phone='+16163280114',
//   company_id=<Watermark's id>, primary_role=null, contact_email=null,
//   active=true. Leaving primary_role and contact_email null ensures the
//   onboarding flow collects them.

// ── Session keys ──────────────────────────────────────────────────────────────

function sessionSource(employeeId: string): string {
  return `onboarding:${employeeId}`;
}

function availConfirmSource(employeeId: string): string {
  return `avail_pending_confirm:${employeeId}`;
}

function availApprovalSource(companyId: string, employeeId: string): string {
  return `avail_pending_mgr:${companyId}:${employeeId}`;
}

function fanoutSource(companyId: string, managerIdentifier: string): string {
  return `onboarding_fanout:${companyId}:${managerIdentifier}`;
}

// ── Session management ────────────────────────────────────────────────────────

export async function getOnboardingSession(
  companyId: string,
  employeeId: string
): Promise<(OnboardingSession & { _memory_id: string }) | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .eq('source', sessionSource(employeeId))
    .maybeSingle();

  if (!data) return null;

  try {
    const row = data as { id: string; content: string };
    const session = JSON.parse(row.content) as OnboardingSession;

    if (new Date(session.expires_at) < new Date()) {
      await supabase.from('aegis_memory').delete().eq('id', row.id);
      await logActivity({
        company_id: companyId,
        action: 'onboarding_timeout',
        entity_type: 'employee',
        entity_id: employeeId,
        summary: `Onboarding session expired for ${session.employee_name}`,
        metadata: {
          step_reached: session.step,
          started_at: session.started_at,
        },
      });
      const managerContact = buildManagerContact(session);
      const managerMsg = buildManagerMsg(session);
      await reply(
        managerContact,
        managerMsg,
        `${session.employee_name}'s onboarding window (48h) expired without completion. Their session has been cleared.`
      );
      return null;
    }

    return { ...session, _memory_id: row.id };
  } catch {
    return null;
  }
}

// Phone-keyed lookup. Used by the router to find an active onboarding session
// for an inbound SMS whose sender is the employee being onboarded — regardless
// of how identity verification resolved the sender (e.g., a Quria admin whose
// personal phone is also the phone of a test employee being onboarded).
export async function getOnboardingSessionByPhone(
  phone: string
): Promise<(OnboardingSession & { _memory_id: string }) | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .like('source', 'onboarding:%');

  const rows = (data ?? []) as { id: string; content: string }[];

  for (const row of rows) {
    let session: OnboardingSession;
    try {
      session = JSON.parse(row.content) as OnboardingSession;
    } catch {
      continue;
    }

    if (session.employee_phone !== phone) continue;

    if (new Date(session.expires_at) < new Date()) {
      await supabase.from('aegis_memory').delete().eq('id', row.id);
      await logActivity({
        company_id: session.company_id,
        action: 'onboarding_timeout',
        entity_type: 'employee',
        entity_id: session.employee_id,
        summary: `Onboarding session expired for ${session.employee_name}`,
        metadata: {
          step_reached: session.step,
          started_at: session.started_at,
        },
      });
      const managerContact = buildManagerContact(session);
      const managerMsg = buildManagerMsg(session);
      await reply(
        managerContact,
        managerMsg,
        `${session.employee_name}'s onboarding window (48h) expired without completion. Their session has been cleared.`
      );
      return null;
    }

    return { ...session, _memory_id: row.id };
  }

  return null;
}

// Email-keyed lookup. Mirror of getOnboardingSessionByPhone for email-onboarded
// employees — finds an active session whose employee_email matches the inbound
// sender, so a reply to an onboarding email is routed back into the workflow
// regardless of how identity verification resolved the sender.
export async function getOnboardingSessionByEmail(
  email: string
): Promise<(OnboardingSession & { _memory_id: string }) | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .like('source', 'onboarding:%');

  const rows = (data ?? []) as { id: string; content: string }[];
  const target = email.toLowerCase();

  for (const row of rows) {
    let session: OnboardingSession;
    try {
      session = JSON.parse(row.content) as OnboardingSession;
    } catch {
      continue;
    }

    if (session.employee_email?.toLowerCase() !== target) continue;

    if (new Date(session.expires_at) < new Date()) {
      await supabase.from('aegis_memory').delete().eq('id', row.id);
      await logActivity({
        company_id: session.company_id,
        action: 'onboarding_timeout',
        entity_type: 'employee',
        entity_id: session.employee_id,
        summary: `Onboarding session expired for ${session.employee_name}`,
        metadata: {
          step_reached: session.step,
          started_at: session.started_at,
        },
      });
      const managerContact = buildManagerContact(session);
      const managerMsg = buildManagerMsg(session);
      await reply(
        managerContact,
        managerMsg,
        `${session.employee_name}'s onboarding window (48h) expired without completion. Their session has been cleared.`
      );
      return null;
    }

    return { ...session, _memory_id: row.id };
  }

  return null;
}

async function saveOnboardingSession(
  session: OnboardingSession & { _memory_id?: string }
): Promise<void> {
  const { _memory_id, ...data } = session;
  const content = JSON.stringify(data);

  if (_memory_id) {
    await supabase.from('aegis_memory').update({ content }).eq('id', _memory_id);
  } else {
    await supabase
      .from('aegis_memory')
      .delete()
      .eq('company_id', session.company_id)
      .eq('source', sessionSource(session.employee_id));
    await supabase.from('aegis_memory').insert({
      company_id: session.company_id,
      memory_type: 'observation',
      source: sessionSource(session.employee_id),
      content,
    });
  }
}

async function clearOnboardingSession(companyId: string, employeeId: string): Promise<void> {
  await supabase
    .from('aegis_memory')
    .delete()
    .eq('company_id', companyId)
    .eq('source', sessionSource(employeeId));
}

// ── Data loaders ──────────────────────────────────────────────────────────────

async function loadShiftBounds(companyId: string): Promise<ShiftBounds> {
  const { data } = await supabase
    .from('shift_types')
    .select('start_time, end_time')
    .eq('company_id', companyId)
    .eq('active', true);

  const shifts = (data ?? []) as { start_time: string; end_time: string }[];

  if (shifts.length === 0) {
    return { earliest_start: '06:00', latest_end: '23:00', min_shift_hours: 4 };
  }

  const starts = shifts.map(s => s.start_time).sort();
  const ends = shifts.map(s => s.end_time).sort();

  const durations = shifts.map(s => {
    const [sh, sm] = s.start_time.split(':').map(Number);
    const [eh, em] = s.end_time.split(':').map(Number);
    return (eh * 60 + em - (sh * 60 + sm)) / 60;
  });

  return {
    earliest_start: starts[0],
    latest_end: ends[ends.length - 1],
    min_shift_hours: Math.max(Math.min(...durations), 1),
  };
}

// Roles are stored as strings across shift_requirements and wage_rates.
// No dedicated roles table exists, so we derive the canonical list from
// shift_requirements (operationally meaningful) with a fallback to wage_rates.
async function loadRoles(companyId: string): Promise<string[]> {
  const { data: srData } = await supabase
    .from('shift_requirements')
    .select('role')
    .eq('company_id', companyId);

  const srRoles = [
    ...new Set(((srData ?? []) as { role: string }[]).map(r => r.role).filter(Boolean)),
  ].sort();

  if (srRoles.length > 0) return srRoles;

  const { data: wrData } = await supabase
    .from('wage_rates')
    .select('role')
    .eq('company_id', companyId);

  return [
    ...new Set(((wrData ?? []) as { role: string }[]).map(r => r.role).filter(Boolean)),
  ].sort();
}

async function loadCompanyName(companyId: string): Promise<string> {
  const { data } = await supabase
    .from('companies')
    .select('name')
    .eq('id', companyId)
    .single();
  return (data as { name: string } | null)?.name ?? 'your company';
}

async function getIncompleteEmployees(companyId: string): Promise<Employee[]> {
  const { data: empData } = await supabase
    .from('employees')
    .select('*')
    .eq('company_id', companyId)
    .eq('active', true);

  const employees = (empData ?? []) as Employee[];

  const { data: availData } = await supabase
    .from('availability')
    .select('employee_id')
    .eq('company_id', companyId);

  const withAvail = new Set(
    ((availData ?? []) as { employee_id: string }[]).map(r => r.employee_id)
  );

  return employees.filter(
    e =>
      !e.contact_phone ||
      !e.contact_email ||
      !e.primary_role ||
      !withAvail.has(e.id)
  );
}

// ── Formatting ────────────────────────────────────────────────────────────────

function formatTime12h(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const period = h >= 12 ? 'pm' : 'am';
  const hour = h % 12 || 12;
  return m === 0 ? `${hour}${period}` : `${hour}:${m.toString().padStart(2, '0')}${period}`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function formatAvailabilityList(slots: AvailabilitySlot[]): string {
  const byDay = new Map<number, AvailabilitySlot[]>();
  for (const slot of slots) {
    const existing = byDay.get(slot.day_of_week) ?? [];
    existing.push(slot);
    byDay.set(slot.day_of_week, existing);
  }

  const lines: string[] = [];
  for (let d = 0; d <= 6; d++) {
    const daySlots = byDay.get(d);
    if (!daySlots) continue;
    const times = daySlots
      .map(s => `${formatTime12h(s.start_time)} – ${formatTime12h(s.end_time)}`)
      .join(', ');
    lines.push(`${DAY_NAMES[d]}: ${times}`);
  }
  return lines.join('\n');
}

function totalWeeklyHours(slots: AvailabilitySlot[]): number {
  return slots.reduce((sum, s) => {
    const [sh, sm] = s.start_time.split(':').map(Number);
    const [eh, em] = s.end_time.split(':').map(Number);
    return sum + (eh * 60 + em - (sh * 60 + sm)) / 60;
  }, 0);
}

function clampTime(time: string, min: string, max: string): string {
  if (time < min) return min;
  if (time > max) return max;
  return time;
}

// ── Messaging helpers ─────────────────────────────────────────────────────────

function getStepSubject(step: string): string {
  switch (step) {
    case 'opt_in':
      return 'Confirm to receive scheduling messages from Aegis';
    case 'name_confirm':
      return "Welcome to Watermark — Let's get you set up";
    case 'email':
      return 'One more thing — your email address';
    case 'role':
      return 'Quick question about your role';
    case 'availability':
      return 'Your availability';
    case 'availability_confirm':
      return 'Does this look right?';
    case 'time_off':
      return 'Almost done';
    case 'complete':
      return "You're all set";
    default:
      return 'Aegis — Watermark Country Club';
  }
}

// Unguarded send — only the opt-in step (sending the opt-in prompt itself and
// handling YES/NO/ambiguous replies) should call this directly. Everything else
// must go through textEmployee, which gates outbound traffic on
// opt_in_confirmed.
async function textEmployeeRaw(session: OnboardingSession, body: string): Promise<void> {
  if (session.employee_channel === 'email') {
    if (!session.employee_email) {
      console.warn(`[onboarding] cannot email ${session.employee_name}: no email on session`);
      return;
    }
    await sendEmail({
      to: session.employee_email,
      subject: getStepSubject(session.step),
      text: body,
      company_id: session.company_id,
    });
    return;
  }

  if (!session.employee_phone) {
    console.warn(`[onboarding] cannot text ${session.employee_name}: no phone on session`);
    return;
  }
  await sendSms({
    to: session.employee_phone,
    from: session.aegis_sms_channel,
    body,
    company_id: session.company_id,
  });
}

// Guarded send used by every onboarding step except opt-in. If the employee has
// not yet confirmed opt-in, the request is dropped and the opt-in prompt is
// re-sent instead — prevents any race where a downstream step transmits content
// before YES is received.
async function textEmployee(session: OnboardingSession, body: string): Promise<void> {
  if (!session.opt_in_confirmed) {
    console.warn(
      `[onboarding] blocked outbound send to ${session.employee_name}: opt-in not confirmed; re-sending opt-in prompt`
    );
    const companyName = await loadCompanyName(session.company_id);
    await sendOptInStep(session, companyName);
    return;
  }
  await textEmployeeRaw(session, body);
}

function buildManagerContact(session: OnboardingSession): VerifiedContact {
  return {
    role: 'manager',
    company_id: session.company_id,
    employee_id: null,
    user_id: null,
    name: 'Manager',
    matched_identifier: session.manager_contact,
    channel: session.manager_channel,
  };
}

function buildManagerMsg(session: OnboardingSession): InboundMessage {
  return {
    sender: session.manager_sender,
    recipient: session.manager_recipient,
    body: '',
    channel: session.manager_channel,
    raw_subject: 'Aegis — Watermark Country Club',
  };
}

// ── AI helpers ────────────────────────────────────────────────────────────────

async function claudeMatchName(message: string, employeeName: string): Promise<boolean> {
  const response = await withAnthropicRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 64,
      system:
        `You are verifying if a message confirms a person's name. ` +
        `The expected name is: "${employeeName}". ` +
        `Reply with ONLY valid JSON: {"matches": true} or {"matches": false}. ` +
        `A match means the message plausibly confirms or states this name, ` +
        `including nicknames, partial names, or affirmatives like "yes that's me".`,
      messages: [{ role: 'user', content: message }],
    })
  );

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const parsed = coerceJsonObject<{ matches: boolean }>(text);
  if (parsed) return parsed.matches;
  const lower = message.toLowerCase();
  return employeeName
    .toLowerCase()
    .split(' ')
    .some(part => lower.includes(part));
}

async function claudeParseAvailability(
  message: string,
  bounds: ShiftBounds
): Promise<AvailabilitySlot[]> {
  const response = await withAnthropicRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 512,
      system:
        `You are parsing employee availability from natural language into structured data. ` +
        `Extract all days and time ranges the employee is available. ` +
        `Clamp all times to ${bounds.earliest_start}–${bounds.latest_end} (24h). ` +
        `"All day" or "anytime" means ${bounds.earliest_start} to ${bounds.latest_end}. ` +
        // Named parts of the day, when the employee gives no explicit clock times.
        // These are the GENERAL clock meanings; clamp to the company's hours.
        `Named periods (no explicit times given) map to: ` +
        `morning = ${bounds.earliest_start}–12:00, afternoon = 12:00–17:00, ` +
        `evening/night = 17:00–${bounds.latest_end}; then clamp to ${bounds.earliest_start}–${bounds.latest_end}. ` +
        `So "Monday mornings" → Monday with the morning window; "weekend afternoons" → Saturday and Sunday with the afternoon window. ` +
        `Day words: "weekdays" = Monday–Friday; "weekends" = Saturday and Sunday; a plural weekday ("Mondays") = that weekday. ` +
        `Ignore any trailing date boundary such as "until <date>" or "through <date>" — parse only the days and times. ` +
        `day_of_week: 0=Sunday through 6=Saturday. Times in HH:MM (24h). ` +
        `Respond ONLY with valid JSON (no markdown): ` +
        `{ "slots": [{ "day_of_week": 0, "start_time": "HH:MM", "end_time": "HH:MM" }] } ` +
        `If nothing clear can be parsed, return { "slots": [] }.`,
      messages: [{ role: 'user', content: message }],
    })
  );

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  return coerceJsonObject<{ slots: AvailabilitySlot[] }>(text)?.slots ?? [];
}

// Parses an availability-CHANGE message (the update flow, not onboarding) into an
// intent: "set" = the employee stated when they CAN work (replace), "remove" =
// they stated when they CANNOT work (negative — subtract from current). For
// "remove" the slots are the windows to take away. Lets employees talk naturally
// ("I can't work Wednesdays anymore", "no mornings until Aug 1").
export type AvailabilityIntent = { mode: 'set' | 'remove'; slots: AvailabilitySlot[] };

async function parseAvailabilityIntent(
  message: string,
  bounds: ShiftBounds
): Promise<AvailabilityIntent> {
  const response = await withAnthropicRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 512,
      system:
        `You are parsing an employee's availability-change message. ` +
        `First decide the MODE: ` +
        `"set" = the employee states when they CAN work (positive); ` +
        `"remove" = the employee states when they CANNOT work (negative — phrases like ` +
        `"I can't work...", "no more...", "take me off...", "stop scheduling me...", "no <day/period>..."). ` +
        `Then list the day+time windows the message refers to — the windows they CAN work (mode "set") ` +
        `or the windows they CANNOT work (mode "remove"). ` +
        // Same named-period rules as the positive parser.
        `Named periods (no explicit times): morning = ${bounds.earliest_start}–12:00, afternoon = 12:00–17:00, ` +
        `evening/night = 17:00–${bounds.latest_end}; clamp to ${bounds.earliest_start}–${bounds.latest_end}. ` +
        `A whole-day negative with no time-of-day ("can't work Wednesdays") covers the ENTIRE day — use start_time "00:00" and end_time "23:59" so the whole day is removed cleanly. ` +
        `Day words: "weekdays" = Mon–Fri; "weekends" = Sat + Sun; a plural weekday ("Mondays") = that weekday. ` +
        `Ignore any trailing date boundary like "until <date>". day_of_week: 0=Sunday..6=Saturday. Times HH:MM (24h). ` +
        `Respond ONLY with JSON (no markdown): ` +
        `{ "mode": "set" | "remove", "slots": [{ "day_of_week": 0, "start_time": "HH:MM", "end_time": "HH:MM" }] }. ` +
        `If nothing clear can be parsed: { "mode": "set", "slots": [] }.`,
      messages: [{ role: 'user', content: message }],
    })
  );

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const parsed = coerceJsonObject<{ mode?: string; slots?: AvailabilitySlot[] }>(text);
  if (!parsed) return { mode: 'set', slots: [] };
  const mode: 'set' | 'remove' = parsed.mode === 'remove' ? 'remove' : 'set';
  return { mode, slots: parsed.slots ?? [] };
}

// Does this message describe a ROTATING availability change (a multi-week
// cycle), e.g. "every other week"? Kept tight so ordinary changes don't match.
export function isRotatingAvailabilityRequest(body: string): boolean {
  return /\b(every other \w+|alternating \w+|week on,?\s*week off|bi-?weekly|every (2|two) weeks?|on a rotation|rotating\b|odd weeks?|even weeks?|week [ab]\b)\b/i.test(body);
}

// Parses a rotating availability message into a cycle of weeks, each with the
// day/time windows the employee CAN work that week. Best-effort; the employee
// confirms the parsed grid before anything is saved.
async function parseRotatingAvailability(
  message: string,
  bounds: ShiftBounds
): Promise<{ cycle_weeks: number; weeks: RotationWeek[]; end_date: string | null } | null> {
  const response = await withAnthropicRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 700,
      system:
        `You are parsing an employee's ROTATING availability message — their availability repeats on a cycle of weeks ` +
        `(e.g. "every other week" = a 2-week cycle). Determine the cycle length and, for EACH week in the cycle, ` +
        `the day+time windows the employee CAN work that week.\n` +
        `- cycle_weeks: the number of weeks in the cycle (2 for "every other week"/"alternating"/"week on week off").\n` +
        `- weeks: one entry per week, numbered 1..cycle_weeks. Week 1 is the FIRST/THIS week, week 2 the next, etc.\n` +
        `- For "week on, week off" style: the "on" week lists the days they can work (full hours ${bounds.earliest_start}–${bounds.latest_end}); ` +
        `the "off" week has an empty days array.\n` +
        `- Named periods (no explicit times): morning = ${bounds.earliest_start}–12:00, afternoon = 12:00–17:00, ` +
        `evening/night = 17:00–${bounds.latest_end}; clamp to ${bounds.earliest_start}–${bounds.latest_end}.\n` +
        `- Day words: "weekdays" = Mon–Fri; "weekends" = Sat + Sun; a plural weekday ("Mondays") = that weekday. day_of_week: 0=Sunday..6=Saturday. Times HH:MM (24h).\n` +
        `- If the message includes an end boundary ("until <date>"), set end_date to YYYY-MM-DD, else null.\n` +
        `Respond ONLY with JSON (no markdown): ` +
        `{ "cycle_weeks": 2, "weeks": [ { "week": 1, "days": [ { "day_of_week": 0, "start_time": "HH:MM", "end_time": "HH:MM" } ] }, { "week": 2, "days": [] } ], "end_date": "YYYY-MM-DD" | null }. ` +
        `If nothing clear can be parsed: { "cycle_weeks": 0, "weeks": [], "end_date": null }.`,
      messages: [{ role: 'user', content: message }],
    })
  );

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const parsed = coerceJsonObject<{ cycle_weeks?: number; weeks?: { week?: number; days?: AvailabilitySlot[] }[]; end_date?: string | null }>(text);
  if (!parsed || !parsed.cycle_weeks || parsed.cycle_weeks < 2 || !Array.isArray(parsed.weeks) || parsed.weeks.length === 0) {
    return null;
  }

  const clamp = (s: AvailabilitySlot): AvailabilitySlot => ({
    day_of_week: s.day_of_week,
    start_time: clampTime(s.start_time, bounds.earliest_start, bounds.latest_end),
    end_time: clampTime(s.end_time, bounds.earliest_start, bounds.latest_end),
  });

  const weeks: RotationWeek[] = parsed.weeks.map((w, i) => ({
    week: typeof w.week === 'number' ? w.week : i + 1,
    days: (w.days ?? []).map(clamp).filter(s => s.start_time < s.end_time),
  }));

  const endRaw = typeof parsed.end_date === 'string' ? parsed.end_date.trim() : '';
  const end_date = /^\d{4}-\d{2}-\d{2}$/.test(endRaw) ? endRaw : null;

  return { cycle_weeks: parsed.cycle_weeks, weeks, end_date };
}

// The Sunday on/before a given YYYY-MM-DD — the anchor for a rotation cycle so
// "week 1" lines up with a calendar week boundary.
export function startOfWeekSunday(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

// Pure: subtract a set of "can't work" windows from the employee's current
// availability, returning what remains. Whole-day removals drop the day; partial
// removals trim or split the slot. Times are "HH:MM" 24h (lexical order = time
// order). No side effects — unit-tested.
export function subtractWindows(
  current: AvailabilitySlot[],
  remove: AvailabilitySlot[]
): AvailabilitySlot[] {
  let result = current.map(s => ({ ...s }));
  for (const r of remove) {
    const next: AvailabilitySlot[] = [];
    for (const s of result) {
      if (s.day_of_week !== r.day_of_week || r.end_time <= s.start_time || r.start_time >= s.end_time) {
        next.push(s); // different day or no overlap → keep as-is
        continue;
      }
      // Overlap on this day: keep the parts of s outside [r.start, r.end].
      if (s.start_time < r.start_time) next.push({ ...s, end_time: r.start_time });
      if (r.end_time < s.end_time) next.push({ ...s, start_time: r.end_time });
      // (r fully covers s → contribute nothing)
    }
    result = next;
  }
  return result.filter(s => s.start_time < s.end_time);
}

// Applies a set of "can't work" removals to a baseline availability. A removal
// that spans the whole operating day drops that day ENTIRELY (no leftover sliver
// from imprecise end times); a partial removal trims/splits the slot. Pure +
// unit-tested. `bounds` is the company's operating window.
export function applyNegativeRemovals(
  baseline: AvailabilitySlot[],
  removals: AvailabilitySlot[],
  bounds: { earliest_start: string; latest_end: string }
): AvailabilitySlot[] {
  const toMin = (t: string): number => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  const earliestMin = toMin(bounds.earliest_start);
  const latestMin = toMin(bounds.latest_end);

  const wholeDayDays = new Set<number>();
  const partial: AvailabilitySlot[] = [];
  for (const r of removals) {
    // "Whole day" = starts at/before opening AND ends within an hour of close.
    // This catches both the clean "00:00–23:59" form and an imprecise end time
    // (e.g. 9:00pm vs a 9:15pm close), so a whole-day "can't" drops the whole day
    // instead of leaving an end-of-day sliver. Partial windows (mornings, "after 5",
    // etc.) start after opening, so they're never mistaken for whole-day.
    const coversWholeDay = toMin(r.start_time) <= earliestMin && toMin(r.end_time) >= latestMin - 60;
    if (coversWholeDay) {
      wholeDayDays.add(r.day_of_week);
    } else {
      partial.push({
        day_of_week: r.day_of_week,
        start_time: clampTime(r.start_time, bounds.earliest_start, bounds.latest_end),
        end_time: clampTime(r.end_time, bounds.earliest_start, bounds.latest_end),
      });
    }
  }
  const afterWholeDays = baseline.filter(s => !wholeDayDays.has(s.day_of_week));
  // Belt-and-suspenders: drop degenerate slivers (< 15 min) that an imprecise
  // removal window could leave behind — no real availability slot is that short.
  return subtractWindows(afterWholeDays, partial).filter(s => slotMinutes(s) >= 15);
}

function slotMinutes(s: AvailabilitySlot): number {
  const [sh, sm] = s.start_time.split(':').map(Number);
  const [eh, em] = s.end_time.split(':').map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
}

// ── Manager-initiated availability change (used by the Homebase edit-by-text path) ──
//
// A manager says "Maria can't work Wednesdays" / "set Maria to Mondays 9–5". Reuses
// the same availability engine the employee flow uses (parse → set/remove → full-week
// default), for a NAMED employee. Returns the current + proposed slots so the caller
// can confirm with the manager before writing. Returns null if nothing parseable.
export async function computeManagerAvailabilityChange(
  companyId: string,
  employeeId: string,
  messageBody: string
): Promise<{ current: AvailabilitySlot[]; proposed: AvailabilitySlot[]; mode: 'set' | 'remove' } | null> {
  const bounds = await loadShiftBounds(companyId);
  const { data: currentData } = await supabase
    .from('availability')
    .select('day_of_week, start_time, end_time')
    .eq('employee_id', employeeId);
  const currentAvail = (currentData ?? []) as AvailabilitySlot[];

  const intent = await parseAvailabilityIntent(messageBody, bounds);
  const clamp = (s: AvailabilitySlot): AvailabilitySlot => ({
    day_of_week: s.day_of_week,
    start_time: clampTime(s.start_time, bounds.earliest_start, bounds.latest_end),
    end_time: clampTime(s.end_time, bounds.earliest_start, bounds.latest_end),
  });

  let proposed: AvailabilitySlot[];
  if (intent.mode === 'remove') {
    const baseline = currentAvail.length === 0
      ? [0, 1, 2, 3, 4, 5, 6].map(d => ({ day_of_week: d, start_time: bounds.earliest_start, end_time: bounds.latest_end }))
      : currentAvail;
    proposed = applyNegativeRemovals(baseline, intent.slots, bounds);
  } else {
    proposed = intent.slots.map(clamp).filter(s => s.start_time < s.end_time);
  }
  if (proposed.length === 0) return null;
  return { current: currentAvail, proposed, mode: intent.mode };
}

// Replace an employee's availability with the given slots (delete + insert).
export async function writeEmployeeAvailability(
  companyId: string,
  employeeId: string,
  slots: AvailabilitySlot[]
): Promise<void> {
  await supabase.from('availability').delete().eq('employee_id', employeeId);
  if (slots.length > 0) {
    await supabase.from('availability').insert(
      slots.map(s => ({
        company_id: companyId,
        employee_id: employeeId,
        day_of_week: s.day_of_week,
        start_time: s.start_time,
        end_time: s.end_time,
      }))
    );
  }
}

// Binary yes/no classifier — used in onboarding confirmation steps where natural
// language ("right but Friday's wrong", "looks good") needs to be interpreted
// reliably. Falls back to 'no' on parse failure (the safe default everywhere
// it's used: re-prompt rather than silently accept).
async function claudeClassifyYesNo(message: string, question: string): Promise<'yes' | 'no'> {
  const response = await withAnthropicRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 16,
      system:
        `${question} Reply with ONLY one word: "yes" or "no". ` +
        `"yes" only if the message clearly affirms. "no" for anything else, ` +
        `including denials, requests to change, ambiguity, or partial mentions.`,
      messages: [{ role: 'user', content: message }],
    })
  );
  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  return text.trim().toLowerCase().startsWith('y') ? 'yes' : 'no';
}

async function claudeExtractDates(
  message: string
): Promise<{ start_date: string; end_date: string }[]> {
  const today = new Date().toISOString().split('T')[0];
  const response = await withAnthropicRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 256,
      system:
        `Extract time-off dates from a message. Today is ${today}. ` +
        `If only one date, set start_date = end_date. ` +
        `Respond ONLY with valid JSON (no markdown): ` +
        `{ "dates": [{ "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD" }] } ` +
        `If none, return { "dates": [] }.`,
      messages: [{ role: 'user', content: message }],
    })
  );

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  return coerceJsonObject<{ dates: { start_date: string; end_date: string }[] }>(text)?.dates ?? [];
}

// ── Step senders ──────────────────────────────────────────────────────────────

async function sendOptInStep(session: OnboardingSession, companyName: string): Promise<void> {
  const firstName = session.employee_name.split(' ')[0];
  await textEmployeeRaw(
    session,
    `Hi ${firstName}! This is Aegis, scheduling assistant for ${companyName}. ` +
      `We'll send shift notifications via SMS. Reply YES to confirm. ` +
      `Msg & data rates may apply. Reply STOP to opt out. ` +
      `Info: quriasolutions.com/sms-consent`
  );
}

async function sendEmailStep(session: OnboardingSession): Promise<void> {
  const firstName = session.employee_name.split(' ')[0];
  await textEmployee(
    session,
    `Thanks ${firstName}. What's your email address? We'll use it to send you your schedule each week.`
  );
}

async function sendRoleStep(session: OnboardingSession, roles: string[]): Promise<void> {
  const list = roles.map((r, i) => `${i + 1}. ${r}`).join('\n');
  await textEmployee(session, `What's your role?\n${list}\nReply with a number.`);
}

async function sendAvailabilityStep(session: OnboardingSession, bounds: ShiftBounds): Promise<void> {
  await textEmployee(
    session,
    `Now let's get your availability on file. Tell me which days you can work and what hours. ` +
      `We schedule between ${formatTime12h(bounds.earliest_start)} and ${formatTime12h(bounds.latest_end)}. ` +
      `You can speak naturally — for example: "I'm free Monday through Friday after 3pm and all day weekends."`
  );
}

async function sendAvailabilityConfirmStep(session: OnboardingSession): Promise<void> {
  const list = formatAvailabilityList(session.collected.availability_parsed);
  await textEmployee(
    session,
    `Got it. Let me confirm your availability:\n${list}\nDoes that look right? Reply YES to confirm or NO to make changes.`
  );
}

async function sendTimeOffStep(session: OnboardingSession): Promise<void> {
  await textEmployee(
    session,
    `Almost done. Do you have any upcoming dates you know you won't be available? ` +
      `For example, a vacation or appointments? Reply NO if nothing comes to mind.`
  );
}

// ── Step handlers ─────────────────────────────────────────────────────────────

async function handleOptInStep(
  body: string,
  session: OnboardingSession & { _memory_id: string },
  companyName: string
): Promise<void> {
  const trimmed = body.trim().toLowerCase();
  const isYes = /^(y|yes|yes please|sure|ok|okay|yep|yeah)$/i.test(trimmed);
  const isNo = /^(n|no|nope|stop|cancel|quit)$/i.test(trimmed);

  if (isYes) {
    session.opt_in_confirmed = true;
    session.step = 'name_confirm';
    await saveOnboardingSession(session);
    await logActivity({
      company_id: session.company_id,
      action: 'employee_opt_in_confirmed',
      entity_type: 'employee',
      entity_id: session.employee_id,
      summary: `${session.employee_name} confirmed SMS opt-in for scheduling notifications`,
      metadata: {
        opt_in_sent_at: session.opt_in_sent_at,
        confirmed_at: new Date().toISOString(),
        company_name: companyName,
      },
    });
    // Combined YES-confirmation + name_confirm prompt. Subsequent inbound
    // messages will land on handleNameConfirmStep.
    await textEmployeeRaw(
      session,
      `Great, you're confirmed! Let's get you set up. What's your full name?`
    );
    return;
  }

  if (isNo) {
    await logActivity({
      company_id: session.company_id,
      action: 'employee_opt_in_declined',
      entity_type: 'employee',
      entity_id: session.employee_id,
      summary: `${session.employee_name} declined SMS opt-in — onboarding halted`,
      metadata: {
        opt_in_sent_at: session.opt_in_sent_at,
        declined_at: new Date().toISOString(),
        reply_body: body.slice(0, 200),
      },
    });
    await textEmployeeRaw(
      session,
      `No problem. You won't receive any further messages. Contact your manager if you change your mind.`
    );
    await clearOnboardingSession(session.company_id, session.employee_id);
    return;
  }

  // Ambiguous reply — re-prompt without re-sending the full opt-in body.
  await textEmployeeRaw(
    session,
    `Please reply YES to receive scheduling notifications or NO to opt out. You won't receive further messages until you reply.`
  );
}

async function handleNameConfirmStep(
  body: string,
  session: OnboardingSession & { _memory_id: string },
  employee: Employee,
  companyName: string
): Promise<void> {
  const matches = await claudeMatchName(body, session.employee_name);

  if (!matches) {
    await textEmployee(
      session,
      `I didn't quite catch that. Could you confirm your name? I have ${session.employee_name} on file.`
    );
    return;
  }

  session.collected.name_confirmed = true;
  const needsEmail = !employee.contact_email;
  const needsRole = !employee.primary_role && !session.collected.role;

  if (needsEmail) {
    session.step = 'email';
    await saveOnboardingSession(session);
    await sendEmailStep(session);
  } else if (needsRole) {
    session.step = 'role';
    const roles = await loadRoles(session.company_id);
    await saveOnboardingSession(session);
    await sendRoleStep(session, roles);
  } else {
    session.step = 'availability';
    const bounds = await loadShiftBounds(session.company_id);
    await saveOnboardingSession(session);
    await sendAvailabilityStep(session, bounds);
  }
}

async function handleEmailStep(
  body: string,
  session: OnboardingSession & { _memory_id: string },
  employee: Employee,
  managerContact: VerifiedContact,
  managerMsg: InboundMessage
): Promise<void> {
  // Defensive skip for email-channel sessions: the employee reached us via
  // their email address, so we already have it. handleNameConfirmStep will
  // normally route past this step when employee.contact_email is set, but
  // this guard rescues any session that landed here anyway.
  if (session.employee_channel === 'email') {
    session.collected.email = session.employee_email ?? '';
    const needsRole = !employee.primary_role && !session.collected.role;
    if (needsRole) {
      session.step = 'role';
      const roles = await loadRoles(session.company_id);
      await saveOnboardingSession(session);
      await sendRoleStep(session, roles);
    } else {
      session.step = 'availability';
      const bounds = await loadShiftBounds(session.company_id);
      await saveOnboardingSession(session);
      await sendAvailabilityStep(session, bounds);
    }
    return;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const trimmed = body.trim().toLowerCase();

  if (!emailRegex.test(trimmed)) {
    session.invalid_email_attempts++;

    if (session.invalid_email_attempts >= 3) {
      await clearOnboardingSession(session.company_id, session.employee_id);
      await logActivity({
        company_id: session.company_id,
        action: 'onboarding_email_failed',
        entity_type: 'employee',
        entity_id: session.employee_id,
        summary: `${session.employee_name} provided invalid email 3 times — onboarding paused`,
      });
      await textEmployee(
        session,
        `I'm having trouble with that email address. I'll let your manager know — they can update it directly.`
      );
      await reply(
        managerContact,
        managerMsg,
        `${session.employee_name} was unable to provide a valid email during onboarding. Please update their email in Homebase and restart onboarding.`
      );
      return;
    }

    await saveOnboardingSession(session);
    await textEmployee(
      session,
      `That doesn't look like a valid email. Could you try again? Example: name@example.com`
    );
    return;
  }

  session.collected.email = trimmed;
  session.invalid_email_attempts = 0;

  const needsRole = !employee.primary_role && !session.collected.role;

  if (needsRole) {
    session.step = 'role';
    const roles = await loadRoles(session.company_id);
    await saveOnboardingSession(session);
    await sendRoleStep(session, roles);
  } else {
    session.step = 'availability';
    const bounds = await loadShiftBounds(session.company_id);
    await saveOnboardingSession(session);
    await sendAvailabilityStep(session, bounds);
  }
}

async function handleRoleStep(
  body: string,
  session: OnboardingSession & { _memory_id: string }
): Promise<void> {
  const roles = await loadRoles(session.company_id);
  const num = parseInt(body.trim(), 10);

  if (isNaN(num) || num < 1 || num > roles.length) {
    await textEmployee(session, `Please reply with a number between 1 and ${roles.length}.`);
    return;
  }

  session.collected.role = roles[num - 1];
  session.step = 'availability';
  const bounds = await loadShiftBounds(session.company_id);
  await saveOnboardingSession(session);
  await sendAvailabilityStep(session, bounds);
}

async function handleAvailabilityStep(
  body: string,
  session: OnboardingSession & { _memory_id: string }
): Promise<void> {
  const bounds = await loadShiftBounds(session.company_id);
  const slots = await claudeParseAvailability(body, bounds);

  if (slots.length === 0) {
    session.invalid_availability_attempts++;

    if (session.invalid_availability_attempts >= 2) {
      await saveOnboardingSession(session);
      await textEmployee(
        session,
        `I'm having trouble understanding that. Try a simpler format — for example: ` +
          `"Monday 9am to 5pm, Tuesday 10am to 3pm, weekends off."`
      );
      return;
    }

    await saveOnboardingSession(session);
    await textEmployee(
      session,
      `I didn't quite catch that. Could you describe which days and hours you're available?`
    );
    return;
  }

  const clamped = slots
    .map(s => ({
      ...s,
      start_time: clampTime(s.start_time, bounds.earliest_start, bounds.latest_end),
      end_time: clampTime(s.end_time, bounds.earliest_start, bounds.latest_end),
    }))
    .filter(s => s.start_time < s.end_time);

  if (clamped.length === 0) {
    await saveOnboardingSession(session);
    await textEmployee(
      session,
      `Your availability falls outside our schedule window (${formatTime12h(bounds.earliest_start)}–${formatTime12h(bounds.latest_end)}). ` +
        `Could you tell me when within those hours you're available?`
    );
    return;
  }

  session.collected.availability_raw = body;
  session.collected.availability_parsed = clamped;
  session.invalid_availability_attempts = 0;
  session.step = 'availability_confirm';
  await saveOnboardingSession(session);
  await sendAvailabilityConfirmStep(session);
}

async function handleAvailabilityConfirmStep(
  body: string,
  session: OnboardingSession & { _memory_id: string },
  managerContact: VerifiedContact,
  managerMsg: InboundMessage
): Promise<void> {
  const verdict = await claudeClassifyYesNo(
    body,
    `The employee was asked to confirm their availability. Did they confirm (yes) or request changes (no)?`
  );

  if (verdict === 'no') {
    session.step = 'availability';
    session.collected.availability_raw = null;
    session.collected.availability_parsed = [];
    session.invalid_availability_attempts = 0;
    const bounds = await loadShiftBounds(session.company_id);
    await saveOnboardingSession(session);
    await sendAvailabilityStep(session, bounds);
    return;
  }

  session.collected.availability_confirmed = true;
  const bounds = await loadShiftBounds(session.company_id);
  const weeklyHours = totalWeeklyHours(session.collected.availability_parsed);

  if (weeklyHours < bounds.min_shift_hours) {
    session.flagged_low_availability = true;
    await reply(
      managerContact,
      managerMsg,
      `${session.employee_name} submitted limited availability — only ${weeklyHours.toFixed(1)}h/week. ` +
        `Saved as submitted but flagging for your review.`
    );
    await logActivity({
      company_id: session.company_id,
      action: 'onboarding_low_availability_flagged',
      entity_type: 'employee',
      entity_id: session.employee_id,
      summary: `${session.employee_name} has low availability: ${weeklyHours.toFixed(1)}h/week`,
      metadata: { weekly_hours: weeklyHours, min_shift_hours: bounds.min_shift_hours },
    });
  }

  session.step = 'time_off';
  await saveOnboardingSession(session);
  await sendTimeOffStep(session);
}

async function handleTimeOffStep(
  body: string,
  session: OnboardingSession & { _memory_id: string },
  managerContact: VerifiedContact,
  managerMsg: InboundMessage
): Promise<void> {
  const dates = await claudeExtractDates(body);

  if (dates.length === 0) {
    // Don't silently complete on an empty parse — confirm the employee really
    // means "no time off" before closing out the workflow. Claude classifies
    // whether the message is a clear no vs. ambiguous mention.
    const clearlyNoTimeOff = await claudeClassifyYesNo(
      body,
      `The employee was asked if they have any upcoming time off. Did they clearly say they have no upcoming time off?`
    );

    if (clearlyNoTimeOff === 'yes') {
      session.step = 'complete';
      await saveOnboardingSession(session);
      await completeOnboarding(session, managerContact, managerMsg);
      return;
    }

    // Ambiguous — stay in the time_off step and ask for clarification.
    await textEmployee(
      session,
      `Just to confirm — you don't have any upcoming dates you need off? ` +
        `Reply YES if that's correct, or tell me the specific dates.`
    );
    return;
  }

  for (const { start_date, end_date } of dates) {
    const { data: torData } = await supabase
      .from('time_off_requests')
      .insert({
        employee_id: session.employee_id,
        company_id: session.company_id,
        start_date,
        end_date,
        reason: 'submitted during onboarding',
        status: 'pending',
        requested_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (torData) {
      const tor = torData as { id: string };
      await logActivity({
        company_id: session.company_id,
        action: 'time_off_request_created',
        entity_type: 'time_off_request',
        entity_id: tor.id,
        summary: `${session.employee_name} requested time off during onboarding for ${formatDateRange(start_date, end_date)}`,
        metadata: { source: 'onboarding' },
      });
      const dateStr = start_date === end_date ? start_date : `${start_date} to ${end_date}`;
      await reply(
        managerContact,
        managerMsg,
        `${session.employee_name} requested time off for ${dateStr} during onboarding. Status: pending your approval.`
      );
    }
  }

  session.collected.time_off_submitted = true;
  session.step = 'complete';
  await saveOnboardingSession(session);
  await completeOnboarding(session, managerContact, managerMsg);
}

// ── Completion ────────────────────────────────────────────────────────────────

async function completeOnboarding(
  session: OnboardingSession & { _memory_id: string },
  managerContact: VerifiedContact,
  managerMsg: InboundMessage
): Promise<void> {
  const firstName = session.employee_name.split(' ')[0];

  await textEmployee(
    session,
    `You're all set ${firstName}. I've saved your availability and contact info. ` +
      `You'll receive your schedule from Aegis each week. Welcome to the team.`
  );

  // Write to employees table
  const updates: Record<string, unknown> = {};
  if (session.collected.email) updates['contact_email'] = session.collected.email;
  if (session.collected.role) updates['primary_role'] = session.collected.role;

  if (Object.keys(updates).length > 0) {
    await supabase.from('employees').update(updates).eq('id', session.employee_id);
  }

  // Add primary_role to qualified_roles if not already present
  if (session.collected.role) {
    const { data: empData } = await supabase
      .from('employees')
      .select('qualified_roles')
      .eq('id', session.employee_id)
      .single();
    const emp = empData as { qualified_roles: string[] } | null;
    if (emp && !emp.qualified_roles.includes(session.collected.role)) {
      await supabase
        .from('employees')
        .update({ qualified_roles: [...emp.qualified_roles, session.collected.role] })
        .eq('id', session.employee_id);
    }
  }

  // Replace availability
  if (session.collected.availability_parsed.length > 0) {
    await supabase.from('availability').delete().eq('employee_id', session.employee_id);
    await supabase.from('availability').insert(
      session.collected.availability_parsed.map(s => ({
        company_id: session.company_id,
        employee_id: session.employee_id,
        day_of_week: s.day_of_week,
        start_time: s.start_time,
        end_time: s.end_time,
      }))
    );
  }

  const weeklyHours = totalWeeklyHours(session.collected.availability_parsed);

  await logActivity({
    company_id: session.company_id,
    action: 'onboarding_complete',
    entity_type: 'employee',
    entity_id: session.employee_id,
    summary: `${session.employee_name} completed onboarding`,
    metadata: {
      availability_raw: session.collected.availability_raw,
      availability_parsed: session.collected.availability_parsed,
      email_collected: !!session.collected.email,
      role_collected: !!session.collected.role,
      time_off_submitted: session.collected.time_off_submitted,
      flagged_low_availability: session.flagged_low_availability,
      total_weekly_hours: weeklyHours,
    },
  });

  const flagNote = session.flagged_low_availability
    ? ` Note: limited availability flagged (${weeklyHours.toFixed(1)}h/week).`
    : '';

  await reply(
    managerContact,
    managerMsg,
    `${session.employee_name} completed onboarding. ${weeklyHours.toFixed(1)}h/week availability saved.${flagNote}`
  );

  await clearOnboardingSession(session.company_id, session.employee_id);
}

// ── Public: employee response handler ────────────────────────────────────────

export async function handleOnboardingResponse(
  message: InboundMessage,
  contact: VerifiedContact,
  session: OnboardingSession & { _memory_id: string }
): Promise<void> {
  const managerContact = buildManagerContact(session);
  const managerMsg = buildManagerMsg(session);

  const { data: empData } = await supabase
    .from('employees')
    .select('*')
    .eq('id', session.employee_id)
    .single();
  const employee = empData as Employee | null;

  if (!employee) {
    await textEmployee(session, `I couldn't locate your employee record. Please contact your manager.`);
    await clearOnboardingSession(session.company_id, session.employee_id);
    return;
  }

  switch (session.step) {
    case 'opt_in': {
      const companyName = await loadCompanyName(session.company_id);
      await handleOptInStep(message.body, session, companyName);
      break;
    }
    case 'name_confirm': {
      const companyName = await loadCompanyName(session.company_id);
      await handleNameConfirmStep(message.body, session, employee, companyName);
      break;
    }
    case 'email':
      await handleEmailStep(message.body, session, employee, managerContact, managerMsg);
      break;
    case 'role':
      await handleRoleStep(message.body, session);
      break;
    case 'availability':
      await handleAvailabilityStep(message.body, session);
      break;
    case 'availability_confirm':
      await handleAvailabilityConfirmStep(message.body, session, managerContact, managerMsg);
      break;
    case 'time_off':
      await handleTimeOffStep(message.body, session, managerContact, managerMsg);
      break;
    case 'complete':
      await textEmployee(
        session,
        `You've already completed onboarding. If you need to make changes, please contact your manager.`
      );
      break;
    default:
      break;
  }
}

// ── Public: manager initiates onboarding ─────────────────────────────────────

export async function handleInitiateOnboarding(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  const { data: channelData } = await supabase
    .from('company_channels')
    .select('channel_value')
    .eq('company_id', contact.company_id)
    .eq('channel_type', 'sms')
    .maybeSingle();

  const aegisSmsChannel = (channelData as { channel_value: string } | null)?.channel_value;

  if (!aegisSmsChannel) {
    await reply(
      contact,
      message,
      `Onboarding requires an Aegis SMS channel configured for your company. Please contact support.`
    );
    return;
  }

  const companyName = await loadCompanyName(contact.company_id);
  const roles = await loadRoles(contact.company_id);
  const targetName = extracted['employee_name'] as string | undefined;

  let candidates: Employee[];

  if (targetName) {
    const incomplete = await getIncompleteEmployees(contact.company_id);
    const lower = targetName.toLowerCase();
    candidates = incomplete.filter(e => e.name.toLowerCase().includes(lower));

    if (candidates.length === 0) {
      const { data: allData } = await supabase
        .from('employees')
        .select('*')
        .eq('company_id', contact.company_id)
        .eq('active', true);
      const all = (allData ?? []) as Employee[];
      const found = all.find(e => e.name.toLowerCase().includes(lower));

      if (found) {
        await reply(contact, message, `${found.name} already has all required information on file.`);
      } else {
        await reply(contact, message, `I couldn't find an employee matching "${targetName}". Please check the name and try again.`);
      }
      return;
    }

    // Named target — proceed immediately, even if substring matches multiple.
    await executeOnboardingForCandidates(
      candidates,
      companyName,
      roles,
      aegisSmsChannel,
      contact,
      message
    );
    return;
  }

  // No name specified — onboard all incomplete employees.
  candidates = await getIncompleteEmployees(contact.company_id);
  if (candidates.length === 0) {
    await reply(contact, message, `All active employees already have their information on file. No onboarding needed.`);
    return;
  }

  // Fan-out confirmation gate: if 2+ reachable employees would be contacted at once,
  // ask the manager to confirm first so they don't accidentally spam staff.
  const reachable = candidates.filter(e => e.contact_phone || e.contact_email);
  if (reachable.length > 1) {
    const pending: OnboardingFanoutPending = {
      company_id: contact.company_id,
      manager_contact: contact.matched_identifier,
      manager_channel: message.channel,
      manager_sender: message.sender,
      manager_recipient: message.recipient,
      aegis_sms_channel: aegisSmsChannel,
      target_employee_ids: candidates.map(e => e.id),
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
    await saveFanoutPending(pending);

    const previewNames = reachable.slice(0, 10).map(e => e.name);
    const overflow = reachable.length > 10 ? `\n...and ${reachable.length - 10} more` : '';
    const noContact = candidates.filter(e => !e.contact_phone && !e.contact_email);
    const skipNote = noContact.length > 0
      ? `\n\n${noContact.length} will be skipped (no contact info): ${noContact.map(e => e.name).join(', ')}.`
      : '';

    await reply(
      contact,
      message,
      `I'm about to start onboarding for ${reachable.length} employees:\n` +
        previewNames.join('\n') +
        overflow +
        skipNote +
        `\n\nReply YES to begin or NO to cancel.`
    );
    return;
  }

  // Single reachable (or all unreachable) — execute immediately, existing
  // executeOnboardingForCandidates handles the skip-no-contact reporting.
  await executeOnboardingForCandidates(
    candidates,
    companyName,
    roles,
    aegisSmsChannel,
    contact,
    message
  );
}

async function executeOnboardingForCandidates(
  candidates: Employee[],
  companyName: string,
  roles: string[],
  aegisSmsChannel: string,
  contact: VerifiedContact,
  message: InboundMessage
): Promise<void> {
  const started: string[] = [];
  const skippedNoContact: string[] = [];

  for (const employee of candidates) {
    if (!employee.contact_phone && !employee.contact_email) {
      skippedNoContact.push(employee.name);
      await logActivity({
        company_id: contact.company_id,
        action: 'onboarding_skipped_no_contact',
        entity_type: 'employee',
        entity_id: employee.id,
        summary: `Onboarding skipped for ${employee.name} — no phone or email on file`,
        metadata: { employee_id: employee.id },
      });
      continue;
    }

    const existing = await getOnboardingSession(contact.company_id, employee.id);
    if (existing) {
      started.push(`${employee.name} (already in progress)`);
      continue;
    }

    const now = new Date();
    const session: OnboardingSession = {
      company_id: contact.company_id,
      employee_id: employee.id,
      employee_name: employee.name,
      employee_phone: employee.contact_phone ?? null,
      employee_email: employee.contact_email ?? null,
      employee_channel: employee.contact_phone ? 'sms' : 'email',
      aegis_sms_channel: aegisSmsChannel,
      manager_contact: contact.matched_identifier,
      manager_channel: message.channel,
      manager_sender: message.sender,
      manager_recipient: message.recipient,
      step: 'opt_in',
      collected: {
        name_confirmed: false,
        email: null,
        // Auto-assign when exactly one role exists and employee has none
        role: roles.length === 1 && !employee.primary_role ? roles[0] : null,
        availability_raw: null,
        availability_parsed: [],
        availability_confirmed: false,
        time_off_submitted: false,
      },
      flagged_low_availability: false,
      invalid_email_attempts: 0,
      invalid_availability_attempts: 0,
      warned_24h: false,
      opt_in_confirmed: false,
      opt_in_sent_at: now.toISOString(),
      started_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString(),
    };

    await saveOnboardingSession(session);
    await sendOptInStep(session, companyName);
    started.push(employee.name);

    await logActivity({
      company_id: contact.company_id,
      action: 'onboarding_started',
      entity_type: 'employee',
      entity_id: employee.id,
      summary: `Onboarding started for ${employee.name} by manager`,
      metadata: { triggered_by: message.channel },
    });
  }

  const lines: string[] = [];
  if (started.length > 0) {
    lines.push(
      `Onboarding started for ${started.length} employee${started.length !== 1 ? 's' : ''}: ${started.join(', ')}.`
    );
  }
  if (skippedNoContact.length > 0) {
    lines.push(
      `Skipped ${skippedNoContact.length} (no contact info): ${skippedNoContact.join(', ')}. Update their phone or email in Homebase and try again.`
    );
  }

  await reply(contact, message, lines.join(' '));
}

// ── Fan-out confirmation ─────────────────────────────────────────────────────

async function saveFanoutPending(pending: OnboardingFanoutPending): Promise<void> {
  await supabase
    .from('aegis_memory')
    .delete()
    .eq('company_id', pending.company_id)
    .eq('source', fanoutSource(pending.company_id, pending.manager_contact));
  await supabase.from('aegis_memory').insert({
    company_id: pending.company_id,
    memory_type: 'observation',
    source: fanoutSource(pending.company_id, pending.manager_contact),
    content: JSON.stringify(pending),
  });
}

export async function getOnboardingFanoutPending(
  companyId: string,
  managerIdentifier: string
): Promise<(OnboardingFanoutPending & { _memory_id: string }) | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .eq('source', fanoutSource(companyId, managerIdentifier))
    .maybeSingle();

  if (!data) return null;

  try {
    const row = data as { id: string; content: string };
    const pending = JSON.parse(row.content) as OnboardingFanoutPending;
    if (new Date(pending.expires_at) < new Date()) {
      await supabase.from('aegis_memory').delete().eq('id', row.id);
      return null;
    }
    return { ...pending, _memory_id: row.id };
  } catch {
    return null;
  }
}

export async function handleOnboardingFanoutConfirm(
  message: InboundMessage,
  contact: VerifiedContact,
  pending: OnboardingFanoutPending & { _memory_id: string }
): Promise<void> {
  const lower = message.body.trim().toLowerCase();
  const isYes = /^(yes|yeah|yep|y\b|confirm|go(\s|$)|start|begin|do\s?it|proceed|sure|ok|okay)/i.test(lower);
  const isNo = /^(no|nope|n\b|cancel|stop|nah|don'?t|never\s?mind)/i.test(lower);

  if (!isYes && !isNo) {
    await reply(contact, message, `Reply YES to start onboarding or NO to cancel.`);
    return;
  }

  await supabase.from('aegis_memory').delete().eq('id', pending._memory_id);

  if (isNo) {
    await reply(contact, message, `Onboarding cancelled.`);
    return;
  }

  // YES — load the employees that were queued and execute. Re-fetch in case
  // anyone became inactive or got deleted in the 10-minute confirmation window.
  const { data: empData } = await supabase
    .from('employees')
    .select('*')
    .in('id', pending.target_employee_ids)
    .eq('active', true);
  const employees = (empData ?? []) as Employee[];

  if (employees.length === 0) {
    await reply(contact, message, `No active employees found to onboard. They may have been removed or deactivated.`);
    return;
  }

  const companyName = await loadCompanyName(pending.company_id);
  const roles = await loadRoles(pending.company_id);

  await executeOnboardingForCandidates(
    employees,
    companyName,
    roles,
    pending.aegis_sms_channel,
    contact,
    message
  );
}

// ── Update availability flow ──────────────────────────────────────────────────

export async function getPendingAvailConfirm(
  companyId: string,
  employeeId: string
): Promise<(PendingAvailUpdate & { _memory_id: string }) | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .eq('source', availConfirmSource(employeeId))
    .maybeSingle();

  if (!data) return null;

  try {
    const row = data as { id: string; content: string };
    const pending = JSON.parse(row.content) as PendingAvailUpdate;
    if (new Date(pending.expires_at) < new Date()) {
      await supabase.from('aegis_memory').delete().eq('id', row.id);
      return null;
    }
    return { ...pending, _memory_id: row.id };
  } catch {
    return null;
  }
}

export async function getPendingManagerAvailApproval(
  companyId: string
): Promise<(PendingManagerAvailApproval & { _memory_id: string }) | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .like('source', `avail_pending_mgr:${companyId}:%`)
    .maybeSingle();

  if (!data) return null;

  try {
    const row = data as { id: string; content: string };
    const pending = JSON.parse(row.content) as PendingManagerAvailApproval;
    if (new Date(pending.expires_at) < new Date()) {
      await supabase.from('aegis_memory').delete().eq('id', row.id);
      return null;
    }
    return { ...pending, _memory_id: row.id };
  } catch {
    return null;
  }
}

export async function handleUpdateAvailability(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  // Conversational ack on email so the employee sees an immediate in-thread
  // reply while the availability parse runs. The YES/NO confirmation follows
  // in the same thread; delay ensures the ack lands first.
  if (message.channel === 'email') {
    const firstName = contact.name?.trim().split(/\s+/)[0] ?? '';
    const bodyText = firstName
      ? `Got it, ${firstName}. Looking at your availability update now — back to you in just a moment.`
      : `Got it. Looking at your availability update now — back to you in just a moment.`;
    await sendInThreadAck({ message, contact, bodyText });
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  const employeeId = contact.employee_id!;
  const bounds = await loadShiftBounds(contact.company_id);

  const { data: currentData } = await supabase
    .from('availability')
    .select('day_of_week, start_time, end_time')
    .eq('employee_id', employeeId);

  const currentAvail = (currentData ?? []) as AvailabilitySlot[];

  // ROTATING ("every other week") custom availability is its own path: parse the
  // multi-week cycle, anchor it to this calendar week, and confirm the grid
  // before sending to the manager. Falls through to the normal parser otherwise.
  if (isRotatingAvailabilityRequest(message.body)) {
    const parsedRotation = await parseRotatingAvailability(message.body, bounds);
    if (!parsedRotation || parsedRotation.weeks.every(w => w.days.length === 0)) {
      await reply(
        contact,
        message,
        `It sounds like your availability rotates week to week, but I couldn't pin down the pattern. ` +
          `Try describing each week, e.g. "Week one I can work mornings; week two I can only work weekends."`
      );
      return;
    }

    const anchor = startOfWeekSunday(new Date().toISOString().slice(0, 10));
    const rotation: RotationSpec = {
      cycle_weeks: parsedRotation.cycle_weeks,
      cycle_start_date: anchor,
      weeks: parsedRotation.weeks,
      end_date: parsedRotation.end_date,
    };

    const pendingRot: PendingAvailUpdate = {
      employee_id: employeeId,
      employee_name: contact.name,
      company_id: contact.company_id,
      current_availability: currentAvail,
      proposed_availability: rotation.weeks[0]?.days ?? [],
      availability_raw: message.body,
      employee_sender: message.sender,
      employee_recipient: message.recipient,
      custom_end_date: null,
      rotation,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };

    await supabase
      .from('aegis_memory')
      .delete()
      .eq('company_id', contact.company_id)
      .eq('source', availConfirmSource(employeeId));
    await supabase.from('aegis_memory').insert({
      company_id: contact.company_id,
      memory_type: 'observation',
      source: availConfirmSource(employeeId),
      content: JSON.stringify(pendingRot),
    });

    const endTail = rotation.end_date
      ? ` This rotation would run until ${formatDateRange(rotation.end_date, rotation.end_date)}.`
      : '';
    await reply(
      contact,
      message,
      `Got it — a rotating schedule on a ${rotation.cycle_weeks}-week cycle, starting the week of ${formatDateRange(anchor, anchor)}:\n\n` +
        `${formatRotationWeeks(rotation)}\n\n` +
        `Then it repeats from week 1.${endTail}\n\nReply YES to send this to your manager, or NO to redo it.`
    );
    return;
  }

  const intent = await parseAvailabilityIntent(message.body, bounds);

  const clamp = (s: AvailabilitySlot): AvailabilitySlot => ({
    day_of_week: s.day_of_week,
    start_time: clampTime(s.start_time, bounds.earliest_start, bounds.latest_end),
    end_time: clampTime(s.end_time, bounds.earliest_start, bounds.latest_end),
  });

  let proposed: AvailabilitySlot[];
  let assumedFullWeek = false;
  if (intent.mode === 'remove') {
    let baseline: AvailabilitySlot[];
    if (currentAvail.length === 0) {
      // Nothing on file → "I can't work X" reads as "available the whole operating
      // week EXCEPT X." Assume that and confirm it explicitly, so they can correct
      // it if they actually meant only a few specific days.
      baseline = [];
      for (let d = 0; d <= 6; d++) {
        baseline.push({ day_of_week: d, start_time: bounds.earliest_start, end_time: bounds.latest_end });
      }
      assumedFullWeek = true;
    } else {
      // Availability on file → subtract precisely from what they already have.
      baseline = currentAvail;
    }
    // Whole-day "can't work X" drops the day entirely; partial removals trim it.
    proposed = applyNegativeRemovals(baseline, intent.slots, bounds);
    if (proposed.length === 0) {
      await reply(
        contact,
        message,
        `That would leave you with no availability at all. If you need to stop working or take time off, let your manager know directly — otherwise tell me the days and times you CAN work.`
      );
      return;
    }
  } else {
    proposed = intent.slots.map(clamp).filter(s => s.start_time < s.end_time);
    if (proposed.length === 0) {
      await reply(
        contact,
        message,
        `I wasn't able to understand your availability. Could you be more specific? ` +
          `For example: "Monday 9am to 5pm and Friday 10am to 3pm."`
      );
      return;
    }
  }

  // A bounded "until <date>" change is a TEMPORARY (date-limited) custom override,
  // not a permanent availability change. The classifier surfaces end_date when it
  // sees the boundary; we only treat it as custom when it's a valid YYYY-MM-DD.
  const endRaw = typeof extracted.end_date === 'string' ? extracted.end_date.trim() : '';
  const customEndDate = /^\d{4}-\d{2}-\d{2}$/.test(endRaw) ? endRaw : null;

  const pending: PendingAvailUpdate = {
    employee_id: employeeId,
    employee_name: contact.name,
    company_id: contact.company_id,
    current_availability: currentAvail,
    proposed_availability: proposed,
    availability_raw: message.body,
    employee_sender: message.sender,
    employee_recipient: message.recipient,
    custom_end_date: customEndDate,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };

  await supabase
    .from('aegis_memory')
    .delete()
    .eq('company_id', contact.company_id)
    .eq('source', availConfirmSource(employeeId));

  await supabase.from('aegis_memory').insert({
    company_id: contact.company_id,
    memory_type: 'observation',
    source: availConfirmSource(employeeId),
    content: JSON.stringify(pending),
  });

  const proposedDisplay = formatAvailabilityList(proposed);
  let confirmBody: string;
  if (assumedFullWeek) {
    // We inferred "available the whole week except what you can't do" because
    // nothing was on file — say so plainly so they can catch a wrong assumption.
    const tail = customEndDate
      ? ` This would run through ${formatDateRange(customEndDate, customEndDate)}, then back to normal.`
      : '';
    confirmBody =
      `You don't have any availability on file yet, so I'm reading that as: you can work your usual hours every day EXCEPT what you mentioned.${tail}\n\n` +
      `Here's what I'd set:\n${proposedDisplay}\n\n` +
      `Reply YES to send it to your manager — or NO to redo it, then just tell me the exact days and times you CAN work.`;
  } else if (customEndDate) {
    confirmBody = `Got it — through ${formatDateRange(customEndDate, customEndDate)} you'd be available:\n${proposedDisplay}\nThen you're back to your normal hours. Look right? Reply YES and I'll send it to your manager to approve — or NO and we'll fix it.`;
  } else {
    confirmBody = `Got it — here's what I'd set your availability to:\n${proposedDisplay}\nLook right? Reply YES and I'll pass it to your manager to approve — or NO and we'll tweak it.`;
  }
  await reply(contact, message, confirmBody);
}

export async function handleAvailabilityConfirmResponse(
  message: InboundMessage,
  contact: VerifiedContact,
  pending: PendingAvailUpdate & { _memory_id: string }
): Promise<void> {
  const lower = message.body.trim().toLowerCase();
  const isYes = /^(yes|yeah|yep|y\b|correct|confirmed|ok|okay|sure)/i.test(lower);
  const isNo = /^(no|nope|n\b|cancel|wrong|nah)/i.test(lower);

  if (!isYes && !isNo) {
    await reply(contact, message, `Please reply YES to send to your manager or NO to cancel.`);
    return;
  }

  await supabase.from('aegis_memory').delete().eq('id', pending._memory_id);

  if (isNo) {
    await reply(
      contact,
      message,
      `No problem — I've scrapped that. To redo it, just send me the days and times you can work (or describe the rotation again) and I'll set it back up.`
    );
    return;
  }

  // Notify ALL managers/owners (mirrors the time-off manager fan-out rather
  // than picking a single arbitrary row).
  const { data: mgrData } = await supabase
    .from('users')
    .select('id, email, name')
    .eq('company_id', contact.company_id)
    .in('role', ['manager', 'owner']);

  const managers = (mgrData ?? []) as { id: string; email: string; name: string }[];
  if (managers.length === 0) {
    await reply(contact, message, `I couldn't locate a manager. Please speak with them directly.`);
    return;
  }

  // Outbound SMS channel — manager-independent, fetch once.
  const { data: chData } = await supabase
    .from('company_channels')
    .select('channel_value')
    .eq('company_id', contact.company_id)
    .eq('channel_type', 'sms')
    .maybeSingle();

  const aegisSmsChannel = (chData as { channel_value: string } | null)?.channel_value;

  // Store the pending approval ONCE, keyed by employee. Any manager who replies
  // YES consumes this record, so a single shared record is correct even when
  // multiple managers are notified.
  const approval: PendingManagerAvailApproval = {
    ...pending,
    employee_channel: message.channel,
    thread_id: message.thread_id ?? null,
    raw_subject: message.raw_subject ?? null,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  await supabase
    .from('aegis_memory')
    .delete()
    .eq('company_id', contact.company_id)
    .eq('source', availApprovalSource(contact.company_id, pending.employee_id));

  await supabase.from('aegis_memory').insert({
    company_id: contact.company_id,
    memory_type: 'observation',
    source: availApprovalSource(contact.company_id, pending.employee_id),
    content: JSON.stringify(approval),
  });

  const currentDisplay =
    pending.current_availability.length > 0
      ? formatAvailabilityList(pending.current_availability)
      : 'Not on file';
  const proposedDisplay = formatAvailabilityList(pending.proposed_availability);

  // A date-limited request reads as a TEMPORARY override through a date, then
  // back to normal; a permanent change reads as a plain availability update.
  const customEndDate = approval.custom_end_date ?? null;
  const rotation = approval.rotation ?? null;
  const headline = rotation
    ? `${pending.employee_name} wants a rotating availability change (a ${rotation.cycle_weeks}-week cycle, starting the week of ${formatDateRange(rotation.cycle_start_date, rotation.cycle_start_date)}).`
    : customEndDate
    ? `${pending.employee_name} wants a temporary availability change through ${formatDateRange(customEndDate, customEndDate)} (then back to normal).`
    : `${pending.employee_name} wants to update their availability.`;
  const proposedBlock = rotation
    ? `PROPOSED ROTATION:\n${formatRotationWeeks(rotation)}`
    : `CURRENT:\n${currentDisplay}\n\nPROPOSED:\n${proposedDisplay}`;
  const managerBody =
    `${headline}\n\n` +
    `${proposedBlock}\n\n` +
    `Reply YES to approve or NO to deny.`;

  // Email-first per manager; SMS only when a manager has no email but has a
  // phone and an outbound SMS channel exists.
  let notifiedCount = 0;
  for (const mgr of managers) {
    const { data: mgrEmpData } = await supabase
      .from('employees')
      .select('contact_phone')
      .eq('company_id', contact.company_id)
      .eq('contact_email', mgr.email)
      .maybeSingle();

    const managerPhone = (mgrEmpData as { contact_phone: string | null } | null)?.contact_phone;
    const smsAvailable = !!(managerPhone && aegisSmsChannel);
    const emailAvailable = !!mgr.email;
    if (!smsAvailable && !emailAvailable) continue;

    if (emailAvailable) {
      // Email managers get a real magic-link Approve / Deny email (mirrors the
      // time-off manager email). The reply-"YES" text path stays as a fallback
      // (the email also tells them they can reply YES/NO).
      const { subject, text, html } = await buildAvailabilityManagerEmail({
        company_id: contact.company_id,
        manager_email: mgr.email,
        manager_user_id: mgr.id ?? undefined,
        manager_name: mgr.name,
        employee_name: pending.employee_name,
        current_availability: pending.current_availability,
        proposed_availability: pending.proposed_availability,
        custom_end_date: customEndDate,
        rotation,
        // The token payload is the self-contained approval snapshot — the
        // magic-link handler applies the decision from this alone (no dependence
        // on the aegis_memory pending row, so a later re-submit can't strand it).
        token_payload: approval as unknown as Record<string, unknown>,
      });
      await sendEmail({ to: mgr.email, subject, text, html, company_id: contact.company_id });
    } else {
      // SMS-only manager: buttons aren't possible over SMS, so keep the
      // reply-"YES"/"NO" text path.
      const managerMessage: InboundMessage = {
        sender: managerPhone!,
        recipient: aegisSmsChannel!,
        body: '',
        channel: 'sms',
      };
      const managerContact: VerifiedContact = {
        role: 'manager',
        company_id: contact.company_id,
        employee_id: null,
        user_id: null,
        name: mgr.name,
        matched_identifier: managerPhone!,
        channel: 'sms',
      };
      await reply(managerContact, managerMessage, `${greeting(mgr.name)}\n\n${managerBody}`);
    }
    notifiedCount++;
  }

  if (notifiedCount === 0) {
    await reply(contact, message, `I couldn't reach your manager. Please speak with them directly.`);
    return;
  }

  await reply(
    contact,
    message,
    `${greeting(contact.name)}\n\nYour availability request has been sent to your manager for approval. You'll hear back soon.`
  );
}

// ── Availability manager-notify email (magic-link Approve / Deny) ──────────────
//
// Mirrors buildTimeOffManagerEmail: mints approve_availability / deny_availability
// tokens and renders Approve / Deny buttons. The token payload is the full
// approval snapshot so the Homebase /api/aegis-action dispatcher can hand it to
// Aegis /internal/apply-availability-decision and the decision applies with no
// dependence on server-side pending state.

function escAvail(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function availMultiline(s: string): string {
  return escAvail(s).replace(/\n/g, '<br>');
}

export async function buildAvailabilityManagerEmail(params: {
  company_id: string;
  manager_email: string;
  manager_user_id?: string;
  manager_name: string;
  employee_name: string;
  current_availability: AvailabilitySlot[];
  proposed_availability: AvailabilitySlot[];
  // When set (YYYY-MM-DD), this is a TEMPORARY date-limited custom-availability
  // request: the buttons mint approve/deny_custom_availability and the copy says
  // "through <date>, then back to normal".
  custom_end_date?: string | null;
  // Set for a ROTATING request — rendered as a per-week grid; also mints the
  // custom-availability tokens (same buttons as date-limited).
  rotation?: RotationSpec | null;
  token_payload: Record<string, unknown>;
}): Promise<{ subject: string; text: string; html: string }> {
  const isRotating = !!params.rotation;
  const isCustom = !!params.custom_end_date || isRotating;
  const throughLabel = params.custom_end_date
    ? formatDateRange(params.custom_end_date, params.custom_end_date)
    : '';
  const [approveTok, denyTok] = await Promise.all([
    generateActionToken({
      action_type: isCustom ? 'approve_custom_availability' : 'approve_availability',
      payload: params.token_payload,
      company_id: params.company_id,
      issued_to_email: params.manager_email,
      issued_to_user_id: params.manager_user_id,
      ttl_minutes: 4320,
    }),
    generateActionToken({
      action_type: isCustom ? 'deny_custom_availability' : 'deny_availability',
      payload: params.token_payload,
      company_id: params.company_id,
      issued_to_email: params.manager_email,
      issued_to_user_id: params.manager_user_id,
      ttl_minutes: 4320,
    }),
  ]);

  const currentDisplay =
    params.current_availability.length > 0
      ? formatAvailabilityList(params.current_availability)
      : 'Not on file';
  const rotationEndTail = params.rotation?.end_date
    ? ` until ${formatDateRange(params.rotation.end_date, params.rotation.end_date)}`
    : '';
  const proposedDisplay = isRotating
    ? formatRotationWeeks(params.rotation!)
    : formatAvailabilityList(params.proposed_availability);

  const subject = isRotating
    ? `Rotating availability request from ${params.employee_name}`
    : isCustom
    ? `Temporary availability request from ${params.employee_name} (through ${throughLabel})`
    : `Availability update request from ${params.employee_name}`;

  const intro = isRotating
    ? `${params.employee_name} wants a rotating availability change — a ${params.rotation!.cycle_weeks}-week cycle starting the week of ${formatDateRange(params.rotation!.cycle_start_date, params.rotation!.cycle_start_date)}${rotationEndTail}, then repeating.`
    : isCustom
    ? `${params.employee_name} wants a temporary availability change through ${throughLabel}, then back to normal.`
    : `${params.employee_name} wants to update their availability.`;
  const proposedHeading = isRotating
    ? 'PROPOSED ROTATION'
    : isCustom
    ? `AVAILABLE THROUGH ${throughLabel.toUpperCase()}`
    : 'PROPOSED';

  const text =
    `${greeting(params.manager_name)}\n\n` +
    `${intro}\n\n` +
    `CURRENT:\n${currentDisplay}\n\n${proposedHeading}:\n${proposedDisplay}\n\n` +
    `Approve: ${approveTok.url}\n\nDeny: ${denyTok.url}\n\n` +
    `(You can also just reply YES to approve or NO to deny.)`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#111827;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f3f4f6;padding:24px 0;">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="640" style="max-width:640px;background:#ffffff;border-radius:8px;padding:28px;border:1px solid #e5e7eb;">
      <tr><td style="font-size:16px;line-height:1.5;">
        <p style="margin:0 0 14px;">${escAvail(greeting(params.manager_name))}</p>
        <p style="margin:0 0 18px;">${escAvail(intro)}</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 22px;">
          <tr>
            <td valign="top" width="48%" style="padding:12px 14px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;font-size:13px;line-height:1.5;">
              <div style="font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;font-size:11px;margin-bottom:6px;">Current</div>
              ${availMultiline(currentDisplay)}
            </td>
            <td width="4%">&nbsp;</td>
            <td valign="top" width="48%" style="padding:12px 14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;font-size:13px;line-height:1.5;">
              <div style="font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:.04em;font-size:11px;margin-bottom:6px;">${escAvail(proposedHeading)}</div>
              ${availMultiline(proposedDisplay)}
            </td>
          </tr>
        </table>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 18px;">
          <tr>
            <td style="padding:0 6px;">
              <a href="${escAvail(approveTok.url)}" style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 28px;border-radius:6px;">Approve</a>
            </td>
            <td style="padding:0 6px;">
              <a href="${escAvail(denyTok.url)}" style="display:inline-block;background:#dc2626;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 28px;border-radius:6px;">Deny</a>
            </td>
          </tr>
        </table>
        <p style="margin:0;font-size:13px;color:#6b7280;">You can also just reply <strong>YES</strong> to approve or <strong>NO</strong> to deny.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  return { subject, text, html };
}

// ── Shared availability-decision effect (reply-"YES" AND email magic-link) ─────
//
// The single implementation of "apply a manager's availability approve/deny": the
// DB write + the employee notification. Both the reply-"YES" path
// (handleManagerAvailabilityApproval) and the email magic-link path (Aegis
// /internal/apply-availability-decision) call this, so the two produce the
// IDENTICAL DB effect and employee notice — no drift. The employee notice never
// links to Homebase (BUG-4).
export interface AvailabilityDecisionInput {
  decision: 'approved' | 'denied';
  company_id: string;
  employee_id: string;
  employee_name: string;
  current_availability: AvailabilitySlot[];
  proposed_availability: AvailabilitySlot[];
  availability_raw: string;
  decided_by?: string;          // manager name/email — recorded in the activity log
  // Employee notify context (rebuilds their channel/thread for the decision notice):
  employee_sender: string;
  employee_recipient: string;
  employee_channel: 'sms' | 'email';
  thread_id?: string | null;
  raw_subject?: string | null;
}

export async function applyAvailabilityDecision(input: AvailabilityDecisionInput): Promise<void> {
  const notifyContext: PendingManagerAvailApproval = {
    employee_id: input.employee_id,
    employee_name: input.employee_name,
    company_id: input.company_id,
    current_availability: input.current_availability,
    proposed_availability: input.proposed_availability,
    availability_raw: input.availability_raw,
    employee_sender: input.employee_sender,
    employee_recipient: input.employee_recipient,
    employee_channel: input.employee_channel,
    thread_id: input.thread_id ?? null,
    raw_subject: input.raw_subject ?? null,
    expires_at: '',
  };

  if (input.decision === 'approved') {
    // Identical to the reply-"YES" effect: replace the employee's availability
    // rows with the proposed set.
    await supabase.from('availability').delete().eq('employee_id', input.employee_id);
    await supabase.from('availability').insert(
      input.proposed_availability.map(s => ({
        company_id: input.company_id,
        employee_id: input.employee_id,
        day_of_week: s.day_of_week,
        start_time: s.start_time,
        end_time: s.end_time,
      }))
    );

    await logActivity({
      company_id: input.company_id,
      action: 'availability_updated',
      entity_type: 'employee',
      entity_id: input.employee_id,
      summary: `${input.decided_by ?? 'A manager'} approved ${input.employee_name}'s availability update`,
      metadata: {
        approved_by: input.decided_by ?? 'manager',
        previous: input.current_availability,
        updated: input.proposed_availability,
        raw_request: input.availability_raw,
      },
    });

    await notifyEmployeeOfAvailabilityDecision(
      notifyContext,
      `Good news — your availability change is approved. Your schedule will reflect it from here on. Thanks!`
    );
  } else {
    await logActivity({
      company_id: input.company_id,
      action: 'availability_update_denied',
      entity_type: 'employee',
      entity_id: input.employee_id,
      summary: `${input.decided_by ?? 'A manager'} denied ${input.employee_name}'s availability update`,
      metadata: { denied_by: input.decided_by ?? 'manager' },
    });

    await notifyEmployeeOfAvailabilityDecision(
      notifyContext,
      `Your availability change wasn't approved this time — give your manager a shout if you'd like to talk it through.`
    );
  }
}

// ── Shared CUSTOM-availability decision effect (date-limited override) ─────────
//
// Sibling to applyAvailabilityDecision, but on approve it writes a date-limited
// custom_availability OVERRIDE (the same kind the Employees tab + Soteria create)
// instead of replacing the permanent availability. Used by both the reply-"YES"
// path and the email magic-link path (/internal/apply-custom-availability-decision),
// so the two produce the identical effect. Employee notice never links to Homebase.
export interface CustomAvailabilityDecisionInput {
  decision: 'approved' | 'denied';
  company_id: string;
  employee_id: string;
  employee_name: string;
  proposed_availability: AvailabilitySlot[];  // days/times available DURING the override
  custom_end_date: string | null;             // YYYY-MM-DD when a date_limited override expires; null for an open-ended rotation
  rotation?: RotationSpec | null;              // set for a ROTATING override
  current_availability: AvailabilitySlot[];
  availability_raw: string;
  decided_by?: string;
  employee_sender: string;
  employee_recipient: string;
  employee_channel: 'sms' | 'email';
  thread_id?: string | null;
  raw_subject?: string | null;
}

export async function applyCustomAvailabilityDecision(input: CustomAvailabilityDecisionInput): Promise<void> {
  const notifyContext: PendingManagerAvailApproval = {
    employee_id: input.employee_id,
    employee_name: input.employee_name,
    company_id: input.company_id,
    current_availability: input.current_availability,
    proposed_availability: input.proposed_availability,
    availability_raw: input.availability_raw,
    employee_sender: input.employee_sender,
    employee_recipient: input.employee_recipient,
    employee_channel: input.employee_channel,
    thread_id: input.thread_id ?? null,
    raw_subject: input.raw_subject ?? null,
    custom_end_date: input.custom_end_date,
    rotation: input.rotation ?? null,
    expires_at: '',
  };
  const throughLabel = input.custom_end_date
    ? formatDateRange(input.custom_end_date, input.custom_end_date)
    : '';

  if (input.decision === 'approved') {
    // Switch off any existing active override for this employee, then insert the
    // new one (same write the Employees tab + Soteria do).
    await supabase
      .from('custom_availability')
      .update({ active: false })
      .eq('employee_id', input.employee_id)
      .eq('company_id', input.company_id);

    // ROTATING override: a multi-week cycle anchored to cycle_start_date.
    if (input.rotation) {
      const rot = input.rotation;
      const patterns = rot.weeks.map(w => ({
        week: w.week,
        days: w.days.map(s => ({ day_of_week: s.day_of_week, start_time: s.start_time, end_time: s.end_time })),
      }));
      await supabase.from('custom_availability').insert({
        company_id: input.company_id,
        employee_id: input.employee_id,
        type: 'rotating',
        end_date: rot.end_date ?? null,
        cycle_weeks: rot.cycle_weeks,
        cycle_start_date: rot.cycle_start_date,
        patterns,
        active: true,
      });
      await logActivity({
        company_id: input.company_id,
        action: 'custom_availability_set',
        entity_type: 'custom_availability',
        entity_id: input.employee_id,
        summary: `${input.decided_by ?? 'A manager'} approved ${input.employee_name}'s rotating availability (${rot.cycle_weeks}-week cycle)`,
        metadata: {
          approved_by: input.decided_by ?? 'manager',
          type: 'rotating',
          cycle_weeks: rot.cycle_weeks,
          cycle_start_date: rot.cycle_start_date,
          patterns,
          raw_request: input.availability_raw,
        },
      });
      await notifyEmployeeOfAvailabilityDecision(
        notifyContext,
        `Nice — your rotating availability is approved, set on a ${rot.cycle_weeks}-week cycle${rot.end_date ? ` through ${formatDateRange(rot.end_date, rot.end_date)}` : ''}. I'll work your schedule around it. Thanks!`
      );
      return;
    }

    // DATE-LIMITED override.
    const patterns = input.proposed_availability.map(s => ({
      day_of_week: s.day_of_week,
      start_time: s.start_time,
      end_time: s.end_time,
    }));

    await supabase.from('custom_availability').insert({
      company_id: input.company_id,
      employee_id: input.employee_id,
      type: 'date_limited',
      end_date: input.custom_end_date,
      cycle_weeks: null,
      cycle_start_date: null,
      patterns,
      active: true,
    });

    await logActivity({
      company_id: input.company_id,
      action: 'custom_availability_set',
      entity_type: 'custom_availability',
      entity_id: input.employee_id,
      summary: `${input.decided_by ?? 'A manager'} approved ${input.employee_name}'s temporary availability through ${throughLabel}`,
      metadata: {
        approved_by: input.decided_by ?? 'manager',
        end_date: input.custom_end_date,
        patterns,
        raw_request: input.availability_raw,
      },
    });

    await notifyEmployeeOfAvailabilityDecision(
      notifyContext,
      `Good news — your temporary availability is approved, set through ${throughLabel}. After that you're back to your normal hours. Thanks!`
    );
  } else {
    await logActivity({
      company_id: input.company_id,
      action: 'custom_availability_denied',
      entity_type: 'custom_availability',
      entity_id: input.employee_id,
      summary: `${input.decided_by ?? 'A manager'} denied ${input.employee_name}'s ${input.rotation ? 'rotating' : 'temporary'} availability change`,
      metadata: { denied_by: input.decided_by ?? 'manager', end_date: input.custom_end_date, rotating: !!input.rotation },
    });

    await notifyEmployeeOfAvailabilityDecision(
      notifyContext,
      `That change wasn't approved this time — give your manager a shout if you'd like to talk it through.`
    );
  }
}

export async function handleManagerAvailabilityApproval(
  message: InboundMessage,
  contact: VerifiedContact,
  pending: PendingManagerAvailApproval & { _memory_id: string }
): Promise<void> {
  const lower = message.body.trim().toLowerCase();
  const isYes = /^(yes|yeah|y\b|approve|approved|ok|okay|sure)/i.test(lower);
  const isNo = /^(no|nope|n\b|deny|denied|decline)/i.test(lower);

  if (!isYes && !isNo) {
    await reply(
      contact,
      message,
      `Please reply YES to approve or NO to deny ${pending.employee_name}'s availability update.`
    );
    return;
  }

  await supabase.from('aegis_memory').delete().eq('id', pending._memory_id);

  // Apply the decision via the shared effect (same code the email magic-link
  // path runs), then send the manager their confirmation. reply-"YES" stays the
  // fallback for SMS managers and anyone who replies instead of clicking.
  const decisionInput = {
    company_id: pending.company_id,
    employee_id: pending.employee_id,
    employee_name: pending.employee_name,
    current_availability: pending.current_availability,
    proposed_availability: pending.proposed_availability,
    availability_raw: pending.availability_raw,
    decided_by: contact.name,
    employee_sender: pending.employee_sender,
    employee_recipient: pending.employee_recipient,
    employee_channel: pending.employee_channel,
    thread_id: pending.thread_id,
    raw_subject: pending.raw_subject,
  };

  const customEndDate = pending.custom_end_date ?? null;
  const rotation = pending.rotation ?? null;
  if (isYes) {
    if (rotation) {
      await applyCustomAvailabilityDecision({ ...decisionInput, custom_end_date: customEndDate, rotation, decision: 'approved' });
      await reply(contact, message, `${pending.employee_name}'s rotating availability is set (${rotation.cycle_weeks}-week cycle).`);
    } else if (customEndDate) {
      await applyCustomAvailabilityDecision({ ...decisionInput, custom_end_date: customEndDate, decision: 'approved' });
      await reply(contact, message, `${pending.employee_name}'s temporary availability is set through ${formatDateRange(customEndDate, customEndDate)}.`);
    } else {
      await applyAvailabilityDecision({ ...decisionInput, decision: 'approved' });
      await reply(contact, message, `${pending.employee_name}'s availability has been updated.`);
    }
  } else {
    if (rotation) {
      await applyCustomAvailabilityDecision({ ...decisionInput, custom_end_date: customEndDate, rotation, decision: 'denied' });
      await reply(contact, message, `${pending.employee_name}'s rotating availability change has been denied.`);
    } else if (customEndDate) {
      await applyCustomAvailabilityDecision({ ...decisionInput, custom_end_date: customEndDate, decision: 'denied' });
      await reply(contact, message, `${pending.employee_name}'s temporary availability change has been denied.`);
    } else {
      await applyAvailabilityDecision({ ...decisionInput, decision: 'denied' });
      await reply(contact, message, `${pending.employee_name}'s availability update has been denied.`);
    }
  }
}

// Send the approve/deny notice back to the employee on their original channel.
// Reconstructs the inbound-message context from the persisted pending row so
// reply() does the channel branching (sendSms for SMS; threaded sendEmail with
// normalized Re: subject for email).
async function notifyEmployeeOfAvailabilityDecision(
  pending: PendingManagerAvailApproval,
  bodyText: string
): Promise<void> {
  const employeeMessage: InboundMessage = {
    sender: pending.employee_sender,
    recipient: pending.employee_recipient,
    body: '',
    channel: pending.employee_channel,
    raw_subject: pending.raw_subject ?? undefined,
    thread_id: pending.thread_id ?? undefined,
  };
  const employeeContact: VerifiedContact = {
    role: 'employee',
    company_id: pending.company_id,
    employee_id: pending.employee_id,
    user_id: null,
    name: pending.employee_name,
    matched_identifier: pending.employee_sender,
    channel: pending.employee_channel,
  };
  await reply(employeeContact, employeeMessage, `${greeting(pending.employee_name)}\n\n${bodyText}`);
}

// ── Proactive expiry (called by scheduler) ────────────────────────────────────
// Scans every onboarding session and deletes any past its 48h expires_at,
// notifying the manager on their original channel. Without this, the lazy
// check inside getOnboardingSession only fires if the employee sends another
// message — fully-silent sessions would otherwise linger indefinitely.

export async function expireOldOnboardingSessions(): Promise<void> {
  const { data: rows, error } = await supabase
    .from('aegis_memory')
    .select('id, company_id, content')
    .like('source', 'onboarding:%');

  if (error) {
    console.error('[onboarding-expire] DB query failed:', error.message);
    return;
  }

  const records = (rows ?? []) as { id: string; company_id: string; content: string }[];
  const now = new Date();
  let expired = 0;

  for (const record of records) {
    try {
      const session = JSON.parse(record.content) as OnboardingSession;
      if (new Date(session.expires_at) > now) continue;

      // Delete first so a transient notify failure doesn't leave the row stuck.
      await supabase.from('aegis_memory').delete().eq('id', record.id);

      await logActivity({
        company_id: session.company_id,
        action: 'onboarding_timeout',
        entity_type: 'employee',
        entity_id: session.employee_id,
        summary: `Onboarding session expired for ${session.employee_name}`,
        metadata: {
          step_reached: session.step,
          started_at: session.started_at,
          reaped_by: 'proactive_expiry',
        },
      });

      const managerContact = buildManagerContact(session);
      const managerMsg = buildManagerMsg(session);
      await reply(
        managerContact,
        managerMsg,
        `${session.employee_name}'s onboarding window expired without completion. ` +
          `Their session has been cleared. You can restart onboarding anytime.`
      );

      expired++;
    } catch (err) {
      console.error('[onboarding-expire] error processing record:', err);
    }
  }

  if (expired > 0) {
    console.log(`[onboarding-expire] expired ${expired} stale onboarding session(s)`);
  }
}

// ── Stale session checker (called by scheduler) ───────────────────────────────

export async function checkStaleOnboardingSessions(): Promise<void> {
  const { data: rows, error } = await supabase
    .from('aegis_memory')
    .select('id, company_id, content')
    .like('source', 'onboarding:%');

  if (error) {
    console.error('[onboarding-timeout] DB query failed:', error.message);
    return;
  }

  const records = (rows ?? []) as { id: string; company_id: string; content: string }[];
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  for (const record of records) {
    try {
      const session = JSON.parse(record.content) as OnboardingSession;

      if (session.step === 'complete') continue;
      if (session.warned_24h) continue;
      if (new Date(session.started_at) > twentyFourHoursAgo) continue;

      // Mark warned before sending so a service restart doesn't double-notify
      const updated: OnboardingSession = { ...session, warned_24h: true };
      await supabase
        .from('aegis_memory')
        .update({ content: JSON.stringify(updated) })
        .eq('id', record.id);

      const managerContact = buildManagerContact(session);
      const managerMsg = buildManagerMsg(session);
      await reply(
        managerContact,
        managerMsg,
        `${session.employee_name} hasn't completed onboarding yet. You may want to follow up directly.`
      );

      await logActivity({
        company_id: session.company_id,
        action: 'onboarding_24h_warning_sent',
        entity_type: 'employee',
        entity_id: session.employee_id,
        summary: `24h onboarding warning sent for ${session.employee_name}`,
        metadata: { step_reached: session.step },
      });
    } catch {
      // Corrupted record — skip
    }
  }
}
