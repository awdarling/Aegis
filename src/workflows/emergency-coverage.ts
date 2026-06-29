import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { reply } from '../messaging/reply';
import { sendSms } from '../messaging/sms';
import { sendEmail } from '../messaging/email';
import { greeting } from '../messaging/greeting';
import {
  BRAND,
  brandedEmailShell,
  brandActionCard,
  brandedButtonRow,
} from '../messaging/brand';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { generateReply } from '../ai/claude';
import { getSpecialNotes } from './special-notes';
import type { InboundMessage, VerifiedContact } from '../security/types';
import type { Employee, Availability, Event } from '../db/types';
import { coerceJsonObject } from '../utils/coerce-json';

// Re-exported so existing tests importing it from this module keep working.
export { coerceJsonObject };

// Fan-out tuning. The manager blasts a batch; if no one accepts within this
// window we ask the manager whether to send another batch (we never auto-send).
// TODO (DEV_ROADMAP): make this a per-company Homebase setting rather than a constant.
const NEXT_BATCH_PROMPT_MINUTES = 30;
const NEXT_BATCH_SIZE = 5;

// ── Internal schedule types ───────────────────────────────────────────────────
// These define the expected shape of schedules.data — schedule-build must match.

export interface ScheduleAssignment {
  date: string;
  employee_id: string;
  employee_name: string;
  shift_name: string;
  role: string;
  start_time: string;
  end_time: string;
  hours: number;
}

interface ScheduleGap {
  date: string;
  shift_name: string;
  role: string;
  start_time: string;
  end_time: string;
}

interface ScheduleData {
  assignments: ScheduleAssignment[];
  gaps?: ScheduleGap[];
}

// ── Public state types ────────────────────────────────────────────────────────

export interface ShiftInfo {
  shift_name: string;
  role: string;
  start_time: string;
  end_time: string;
  hours: number;
}

export interface OutreachResult {
  employee_id: string;
  employee_name: string;
  response: 'yes' | 'no' | 'no_response' | 'pending';
  responded_at: string | null;
}

export interface CoverageSession {
  _memory_id?: string;
  company_id: string;
  manager_contact: string;
  manager_channel: 'sms' | 'email';
  manager_sender: string;
  manager_recipient: string;
  manager_raw_subject?: string;
  manager_thread_id?: string;
  callout_employee_id: string | null;
  callout_employee_name: string;
  shift_date: string;
  shift_info: ShiftInfo;
  state: 'awaiting_names' | 'outreach_in_progress' | 'awaiting_next_batch_decision';
  outreach_queue: string[];
  outreach_results: OutreachResult[];
  coverage_filled: boolean;
  covered_by_employee_id: string | null;
  urgency_window_minutes: number;
  // The full engine-ranked candidate pool + how many have been shown, so the
  // manager can ask for "more" (additional batch) without recomputing.
  candidate_pool?: PoolCandidate[];
  shown_count?: number;
  expires_at: string;
}

// Lightweight, serializable candidate row stored on the session for additional batches.
export interface PoolCandidate {
  employee_id: string;
  name: string;
  primary_role: string;
  phone: string | null;
  current_weekly_hours: number;
  shift_hours: number;
  would_exceed_max: boolean;
  max_weekly_hours: number;
  tier: 1 | 2 | 3;
}

export interface ActiveOutreach {
  _memory_id?: string;
  company_id: string;
  employee_id: string;
  shift_date: string;
  shift_info: ShiftInfo;
  callout_employee_name: string;
  // The absent employee's id, carried so we can swap them out of the schedule on
  // accept even if the manager's session has since expired.
  callout_employee_id: string | null;
  aegis_sms_channel: string | null;
  employee_phone: string | null;
  // The channel the outreach was sent on + the employee's email, so "shift filled"
  // notices reach email-contacted employees too (not just SMS).
  employee_channel: 'sms' | 'email';
  employee_email: string | null;
  manager_contact: string;
  manager_channel: 'sms' | 'email';
  manager_sender: string;
  manager_recipient: string;
  manager_raw_subject?: string;
  manager_thread_id?: string;
  outreach_sent_at: string;
  window_expires_at: string;
  coverage_filled: boolean;
}

interface CoverageCandidate {
  employee: Employee;
  tier: 1 | 2 | 3;
  current_weekly_hours: number;
  shift_hours: number;
  would_exceed_max: boolean;
  tier_label: 'Preferred' | 'Overtime Risk' | 'Already Working';
}

// ── Store helpers ─────────────────────────────────────────────────────────────

export async function getActiveCoverageSession(
  companyId: string,
  managerContact: string
): Promise<CoverageSession | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .eq('source', `coverage_session:${companyId}`)
    .maybeSingle();

  if (!data) return null;

  try {
    const row = data as { id: string; content: string };
    const session = JSON.parse(row.content) as CoverageSession;
    if (session.manager_contact !== managerContact) return null;
    if (new Date(session.expires_at) < new Date()) {
      await supabase.from('aegis_memory').delete().eq('id', row.id);
      return null;
    }
    return { ...session, _memory_id: row.id };
  } catch {
    return null;
  }
}

export async function getActiveOutreach(
  companyId: string,
  employeeId: string
): Promise<ActiveOutreach | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .eq('source', `outreach_active:${employeeId}`)
    .maybeSingle();

  if (!data) return null;

  try {
    const row = data as { id: string; content: string };
    const outreach = JSON.parse(row.content) as ActiveOutreach;
    return { ...outreach, _memory_id: row.id };
  } catch {
    return null;
  }
}

async function storeSession(session: CoverageSession): Promise<void> {
  const { _memory_id, ...data } = session;
  await supabase.from('aegis_memory').delete()
    .eq('company_id', session.company_id)
    .eq('source', `coverage_session:${session.company_id}`);
  await supabase.from('aegis_memory').insert({
    company_id: session.company_id,
    memory_type: 'observation',
    source: `coverage_session:${session.company_id}`,
    content: JSON.stringify(data),
  });
}

async function updateSession(session: CoverageSession): Promise<void> {
  if (!session._memory_id) { await storeSession(session); return; }
  const { _memory_id, ...data } = session;
  await supabase.from('aegis_memory').update({ content: JSON.stringify(data) }).eq('id', _memory_id);
}

async function clearSession(companyId: string): Promise<void> {
  await supabase.from('aegis_memory').delete()
    .eq('company_id', companyId)
    .eq('source', `coverage_session:${companyId}`);
}

async function storeOutreach(outreach: ActiveOutreach): Promise<void> {
  await supabase.from('aegis_memory').delete()
    .eq('company_id', outreach.company_id)
    .eq('source', `outreach_active:${outreach.employee_id}`);
  await supabase.from('aegis_memory').insert({
    company_id: outreach.company_id,
    memory_type: 'observation',
    source: `outreach_active:${outreach.employee_id}`,
    content: JSON.stringify(outreach),
  });
}

async function clearOutreach(companyId: string, employeeId: string): Promise<void> {
  await supabase.from('aegis_memory').delete()
    .eq('company_id', companyId)
    .eq('source', `outreach_active:${employeeId}`);
}

async function clearAllOutreach(companyId: string, employeeIds: string[]): Promise<void> {
  await Promise.all(employeeIds.map(id => clearOutreach(companyId, id)));
}

// ── Low-level helpers ─────────────────────────────────────────────────────────

function computeShiftHours(startTime: string, endTime: string): number {
  const toMins = (t: string) => {
    const [h, m] = t.slice(0, 5).split(':').map(Number);
    return h * 60 + m;
  };
  let mins = toMins(endTime) - toMins(startTime);
  if (mins < 0) mins += 24 * 60;
  return Math.round((mins / 60) * 10) / 10;
}

function formatPhone(phone: string | null): string {
  if (!phone) return 'no phone on file';
  const d = phone.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return phone;
}

function formatDisplayDate(dateStr: string): string {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

function formatShortDate(dateStr: string): string {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
  });
}

// Escape user-supplied / dynamic text before inlining into branded HTML.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function getCompanyDate(companyId: string): Promise<string> {
  const { data } = await supabase.from('companies').select('timezone').eq('id', companyId).single();
  const tz = (data as { timezone: string } | null)?.timezone ?? 'America/New_York';
  // 'en-CA' locale returns YYYY-MM-DD format
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

function calcUrgencyWindowMinutes(shiftDate: string, shiftStartTime: string): number {
  const d = new Date(`${shiftDate}T${shiftStartTime.slice(0, 5)}:00Z`);
  const minsUntil = Math.floor((d.getTime() - Date.now()) / 60000);
  if (minsUntil >= 60) return 20;
  if (minsUntil >= 30) return 15;
  return 10;
}

function isAvailableForShift(
  dayOfWeek: number,
  shiftStart: string,
  shiftEnd: string,
  records: Availability[]
): boolean {
  const ns = shiftStart.slice(0, 5);
  const ne = shiftEnd.slice(0, 5);
  return records.some(
    a => a.day_of_week === dayOfWeek &&
         a.start_time.slice(0, 5) <= ns &&
         a.end_time.slice(0, 5) >= ne
  );
}

function parseEmployeeResponse(body: string): 'yes' | 'no' | 'unclear' {
  const lower = body.trim().toLowerCase();
  if (/^(yes|yeah|yep|sure|ok|okay|can do|i can|i will|absolutely|coming|on my way)/.test(lower)) return 'yes';
  if (/^(no|nope|can'?t|cannot|sorry|not able|unavailable|won'?t|nah|negative)/.test(lower)) return 'no';
  return 'unclear';
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function findSchedule(companyId: string, date: string): Promise<ScheduleData | null> {
  const query = supabase.from('schedules').select('data').is('deleted_at', null)
    .eq('company_id', companyId)
    .lte('week_start', date)
    .gte('week_end', date)
    .order('generated_at', { ascending: false })
    .limit(1);

  const { data: pub } = await query.eq('status', 'published').maybeSingle();
  if (pub) return (pub as { data: ScheduleData }).data;

  const { data: draft } = await query.eq('status', 'draft').maybeSingle();
  if (draft) return (draft as { data: ScheduleData }).data;

  return null;
}

// Pure swap: replace the absent employee with the coverer on the matching shift.
// Matched by date + absent employee + start time (HH:MM), which uniquely
// identifies their assignment. Returns a new array + whether a swap happened.
export function swapScheduleAssignment(
  assignments: ScheduleAssignment[],
  params: {
    shift_date: string;
    start_time: string;
    absent_employee_id: string;
    coverer_employee_id: string;
    coverer_name: string;
  }
): { assignments: ScheduleAssignment[]; swapped: boolean } {
  const idx = assignments.findIndex(
    a =>
      a.date === params.shift_date &&
      a.employee_id === params.absent_employee_id &&
      a.start_time.slice(0, 5) === params.start_time.slice(0, 5)
  );
  if (idx === -1) return { assignments, swapped: false };
  const next = assignments.slice();
  next[idx] = {
    ...next[idx],
    employee_id: params.coverer_employee_id,
    employee_name: params.coverer_name,
  };
  return { assignments: next, swapped: true };
}

// Loads the schedule row (id + data) covering a date — published first, else draft.
async function loadScheduleRow(
  companyId: string,
  date: string
): Promise<{ id: string; data: ScheduleData } | null> {
  for (const status of ['published', 'draft'] as const) {
    const { data } = await supabase
      .from('schedules')
      .select('id, data')
      .is('deleted_at', null)
      .eq('company_id', companyId)
      .lte('week_start', date)
      .gte('week_end', date)
      .eq('status', status)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) return data as { id: string; data: ScheduleData };
  }
  return null;
}

// On accept, swap the absent employee for the coverer on the matching shift in
// the published/draft schedule, so Homebase reflects reality and the coverer's
// hours follow. Best-effort: returns whether it actually updated.
async function applyCoverageToSchedule(params: {
  company_id: string;
  shift_date: string;
  shift_info: ShiftInfo;
  absent_employee_id: string | null;
  coverer_employee_id: string;
  coverer_name: string;
}): Promise<{ updated: boolean; reason?: string }> {
  if (!params.absent_employee_id) return { updated: false, reason: 'no_absent_id' };

  const row = await loadScheduleRow(params.company_id, params.shift_date);
  if (!row) return { updated: false, reason: 'no_schedule' };

  const data: ScheduleData = row.data ?? { assignments: [] };
  const { assignments, swapped } = swapScheduleAssignment(data.assignments ?? [], {
    shift_date: params.shift_date,
    start_time: params.shift_info.start_time,
    absent_employee_id: params.absent_employee_id,
    coverer_employee_id: params.coverer_employee_id,
    coverer_name: params.coverer_name,
  });
  if (!swapped) return { updated: false, reason: 'assignment_not_found' };

  const { error } = await supabase
    .from('schedules')
    .update({ data: { ...data, assignments } })
    .eq('id', row.id);
  if (error) return { updated: false, reason: error.message };
  return { updated: true };
}

async function findShiftInfo(
  companyId: string,
  shiftDate: string,
  calledOutEmployeeId: string | null,
  shiftNameHint: string | null,
  scheduleData: ScheduleData | null
): Promise<ShiftInfo | null> {
  // Best case: find the called-out employee's shift in the schedule
  if (scheduleData && calledOutEmployeeId) {
    const entry = scheduleData.assignments.find(
      s => s.employee_id === calledOutEmployeeId && s.date === shiftDate
    );
    if (entry) {
      return {
        shift_name: entry.shift_name,
        role: entry.role,
        start_time: entry.start_time,
        end_time: entry.end_time,
        hours: entry.hours,
      };
    }
  }

  // Fall back: look for a shift_type matching the hint, or the only active one today
  const dayOfWeek = new Date(shiftDate + 'T12:00:00Z').getUTCDay();
  const { data: stData } = await supabase
    .from('shift_types')
    .select('*')
    .eq('company_id', companyId)
    .eq('active', true);

  const shiftTypes = ((stData ?? []) as Array<{
    id: string; name: string; start_time: string; end_time: string; days_active: number[];
  }>).filter(st => st.days_active.includes(dayOfWeek));

  if (shiftTypes.length === 0) return null;

  const match = shiftNameHint
    ? shiftTypes.find(st => st.name.toLowerCase().includes(shiftNameHint.toLowerCase()))
    : null;

  const target = match ?? shiftTypes[0];

  // Find required role for this shift type
  const { data: reqData } = await supabase
    .from('shift_requirements')
    .select('role')
    .eq('company_id', companyId)
    .eq('shift_type_id', target.id)
    .limit(1)
    .maybeSingle();

  return {
    shift_name: target.name,
    role: (reqData as { role: string } | null)?.role ?? 'General',
    start_time: target.start_time,
    end_time: target.end_time,
    hours: computeShiftHours(target.start_time, target.end_time),
  };
}

async function findEmployeeByName(companyId: string, name: string): Promise<Employee | null> {
  const trimmed = name.trim();

  // Try exact match first
  const { data: exact } = await supabase
    .from('employees')
    .select('*')
    .eq('company_id', companyId)
    .eq('active', true)
    .ilike('name', trimmed)
    .limit(1)
    .maybeSingle();
  if (exact) return exact as Employee;

  // Try first name partial match
  const firstName = trimmed.split(/\s+/)[0];
  const { data: partial } = await supabase
    .from('employees')
    .select('*')
    .eq('company_id', companyId)
    .eq('active', true)
    .ilike('name', `${firstName}%`)
    .limit(1)
    .maybeSingle();
  return (partial as Employee | null) ?? null;
}

function buildWeeklyHoursMap(scheduleData: ScheduleData | null): Map<string, number> {
  const map = new Map<string, number>();
  if (!scheduleData) return map;
  for (const a of scheduleData.assignments) {
    map.set(a.employee_id, (map.get(a.employee_id) ?? 0) + a.hours);
  }
  return map;
}

function buildScheduledTodaySet(scheduleData: ScheduleData | null, date: string): Set<string> {
  const set = new Set<string>();
  if (!scheduleData) return set;
  for (const a of scheduleData.assignments) {
    if (a.date === date) set.add(a.employee_id);
  }
  return set;
}

// ── AI extraction ─────────────────────────────────────────────────────────────

async function extractEmergencyDetails(
  body: string,
  today: string
): Promise<{ employee_name: string | null; shift_date: string; shift_name: string | null }> {
  const weekday = new Date(today + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' });
  const system =
    `You are a data extractor for a workforce scheduling system. ` +
    `Today is ${today} (${weekday}) in the company's local timezone. ` +
    `A manager is reporting that an employee cannot work a shift and needs coverage. Extract three fields:\n` +
    `- employee_name: the full name of the person who is OUT / calling in sick / can't come in, exactly as written. null if no person is named.\n` +
    `- shift_date: the calendar date that needs coverage, as YYYY-MM-DD. Resolve relative words against today (${today}):\n` +
    `    • "today", "tonight", "this morning", or no date mentioned → ${today}\n` +
    `    • "tomorrow", "tomorrow night" → the day after today\n` +
    `    • a weekday name like "Saturday" or "this Friday" → the next occurrence of that weekday on or after today\n` +
    `- shift_name: a shift name or time window if the manager names one (e.g. "morning shift", "3-11", "AM"), else null.\n` +
    `Resolution examples (pretend today is 2026-03-16, a Monday):\n` +
    `  "Maisey Pell can't come in today, I need coverage." → {"employee_name":"Maisey Pell","shift_date":"2026-03-16","shift_name":null}\n` +
    `  "Cover for John tomorrow night" → {"employee_name":"John","shift_date":"2026-03-17","shift_name":"night"}\n` +
    `  "Sarah called in sick for Saturday" → {"employee_name":"Sarah","shift_date":"2026-03-21","shift_name":null}\n` +
    `Respond with ONLY a JSON object — no markdown, no commentary: ` +
    `{"employee_name":string|null,"shift_date":"YYYY-MM-DD","shift_name":string|null}`;
  const text = await generateReply(system, body, []);
  const parsed = coerceJsonObject<{ employee_name: string | null; shift_date: string; shift_name: string | null }>(text);
  if (parsed && typeof parsed.shift_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.shift_date)) {
    return {
      employee_name: parsed.employee_name ?? null,
      shift_date: parsed.shift_date,
      shift_name: parsed.shift_name ?? null,
    };
  }
  return { employee_name: null, shift_date: today, shift_name: null };
}

// Heuristic: does this manager message read as a NEW call-out / coverage
// request rather than a reply naming who to contact? Used to stop a stale
// "awaiting_names" session from hijacking a fresh request. Kept deliberately
// tight — a bare name reply ("Kori", "contact Addison") must NOT match.
export function isNewCoverageRequest(body: string): boolean {
  const t = body.toLowerCase();
  return (
    /\b(can'?t|cannot|can not|unable to)\s+(come in|make it|work|be there|come)\b/.test(t) ||
    /\bneed(s)?\s+(coverage|someone|a sub|a substitute|a replacement|to cover|cover)\b/.test(t) ||
    /\bcall(ed|ing)?\s+(in|out)\b/.test(t) ||
    /\bcalling in sick\b/.test(t) ||
    /\bis\s+(out|sick)\b/.test(t) ||
    /\bcover(ing)?\s+(for|the)\b/.test(t) ||
    /\bno longer (available|able to (come|work))\b/.test(t)
  );
}

export async function extractOutreachNames(body: string): Promise<string[]> {
  const system =
    `You read a manager's reply to a coverage candidate list and extract which ` +
    `employee(s) they want Aegis to contact. The reply is usually just a name or ` +
    `two, sometimes with filler words.\n` +
    `Rules:\n` +
    `- Return the employee NAMES the manager wants contacted, in the order given.\n` +
    `- A bare name on its own (e.g. "Shmubba") means contact that person.\n` +
    `- If the manager is declining or will handle it themselves ("never mind", ` +
    `"I'll do it", "leave it with me"), return an empty list.\n` +
    `Respond with ONLY a JSON object — no markdown, no commentary:\n` +
    `{"names":["Name1","Name2"]}\n` +
    `Examples:\n` +
    `  "Shmubba" → {"names":["Shmubba"]}\n` +
    `  "contact Kori Baumann please" → {"names":["Kori Baumann"]}\n` +
    `  "Addison and Mia" → {"names":["Addison","Mia"]}\n` +
    `  "never mind, I'll handle it" → {"names":[]}`;
  const text = await generateReply(system, body, []);
  const parsed = coerceJsonObject<{ names: unknown }>(text);
  if (parsed && Array.isArray(parsed.names)) {
    return (parsed.names as unknown[]).filter(
      (n): n is string => typeof n === 'string' && n.trim().length > 0
    );
  }
  return [];
}

// ── Candidate pool ────────────────────────────────────────────────────────────

async function buildCandidatePool(params: {
  company_id: string;
  shift_date: string;
  shift_info: ShiftInfo;
  called_out_employee_id: string | null;
  schedule_data: ScheduleData | null;
}): Promise<{ tier1: CoverageCandidate[]; tier2: CoverageCandidate[]; tier3: CoverageCandidate[] }> {
  const { company_id, shift_date, shift_info, called_out_employee_id, schedule_data } = params;

  const dayOfWeek = new Date(shift_date + 'T12:00:00Z').getUTCDay();
  const weeklyHoursMap = buildWeeklyHoursMap(schedule_data);
  const scheduledToday = buildScheduledTodaySet(schedule_data, shift_date);

  const [empRes, availRes, toRes] = await Promise.all([
    supabase.from('employees').select('*').eq('company_id', company_id).eq('active', true),
    supabase.from('availability').select('*').eq('company_id', company_id),
    supabase.from('time_off_requests').select('employee_id')
      .eq('company_id', company_id)
      .eq('status', 'approved')
      .lte('start_date', shift_date)
      .gte('end_date', shift_date),
  ]);

  const employees = (empRes.data ?? []) as Employee[];
  const availability = (availRes.data ?? []) as Availability[];
  const onApprovedTO = new Set((toRes.data ?? []).map((r: { employee_id: string }) => r.employee_id));

  // Group availability by employee
  const availByEmp = new Map<string, Availability[]>();
  for (const a of availability) {
    if (!availByEmp.has(a.employee_id)) availByEmp.set(a.employee_id, []);
    availByEmp.get(a.employee_id)!.push(a);
  }

  const tier1: CoverageCandidate[] = [];
  const tier2: CoverageCandidate[] = [];
  const tier3: CoverageCandidate[] = [];

  for (const emp of employees) {
    if (emp.id === called_out_employee_id) continue;
    if (onApprovedTO.has(emp.id)) continue;

    const hasRole = emp.qualified_roles.includes(shift_info.role);
    const isScheduledToday = scheduledToday.has(emp.id);
    const empAvail = availByEmp.get(emp.id) ?? [];
    const isAvailable = isAvailableForShift(dayOfWeek, shift_info.start_time, shift_info.end_time, empAvail);
    const weeklyHours = weeklyHoursMap.get(emp.id) ?? 0;
    const wouldExceedMax = weeklyHours + shift_info.hours > emp.max_weekly_hours;

    if (hasRole && !isScheduledToday && isAvailable) {
      const candidate: CoverageCandidate = {
        employee: emp,
        tier: wouldExceedMax ? 2 : 1,
        current_weekly_hours: weeklyHours,
        shift_hours: shift_info.hours,
        would_exceed_max: wouldExceedMax,
        tier_label: wouldExceedMax ? 'Overtime Risk' : 'Preferred',
      };
      if (wouldExceedMax) tier2.push(candidate);
      else tier1.push(candidate);
    } else if (hasRole && isScheduledToday) {
      // Tier 3: already working, could potentially extend
      tier3.push({
        employee: emp,
        tier: 3,
        current_weekly_hours: weeklyHours,
        shift_hours: shift_info.hours,
        would_exceed_max: wouldExceedMax,
        tier_label: 'Already Working',
      });
    }
  }

  const sortCandidates = (a: CoverageCandidate, b: CoverageCandidate) =>
    a.current_weekly_hours !== b.current_weekly_hours
      ? a.current_weekly_hours - b.current_weekly_hours
      : a.employee.name.localeCompare(b.employee.name);

  tier1.sort(sortCandidates);
  tier2.sort(sortCandidates);
  tier3.sort(sortCandidates);

  return { tier1, tier2, tier3 };
}

// ── Message formatting ────────────────────────────────────────────────────────

function buildCandidateMessage(
  tier1: CoverageCandidate[],
  tier2: CoverageCandidate[],
  tier3: CoverageCandidate[],
  shiftInfo: ShiftInfo,
  shiftDate: string,
  calledOutName: string,
  specialNotes: Event[]
): { text: string; html: string } {
  const showTier3 = tier1.length === 0 && tier2.length === 0;
  const display = [...tier1, ...tier2, ...(showTier3 ? tier3 : [])].slice(0, 5);

  const dateStr = formatDisplayDate(shiftDate);
  const header = `Coverage needed: ${shiftInfo.shift_name} (${shiftInfo.role}) on ${dateStr}\nShift: ${shiftInfo.start_time}–${shiftInfo.end_time}\nAbsent: ${calledOutName}`;

  if (display.length === 0) {
    const reasons: string[] = [];
    if (tier1.length === 0 && tier2.length === 0 && tier3.length === 0) {
      reasons.push(`No active employees with the ${shiftInfo.role} role are available`);
    } else if (tier3.length > 0 && !showTier3) {
      reasons.push(`${tier3.length} employee(s) are already scheduled today`);
    }
    const noOneText =
      `${header}\n\nNo coverage candidates found.\n` +
      `• Role needed: ${shiftInfo.role}\n` +
      (reasons.length > 0 ? `• ${reasons.join('\n• ')}\n` : '') +
      (specialNotes.length > 0 ? `\n⚠ Note: ${specialNotes.map(e => e.title).join(', ')} may affect staffing today.` : '') +
      '\n\nYou may need to contact staff directly.';

    // Branded "no one available" body — conclusion-first, then the details in a
    // dark action card so it matches the rest of the workflow emails.
    const reasonsListHtml = reasons.length > 0
      ? `<ul style="margin:6px 0 0;padding-left:18px;">${reasons
          .map(r => `<li style="margin:0 0 6px;font-size:14px;color:${BRAND.textPrimary};">${escapeHtml(r)}</li>`)
          .join('')}</ul>`
      : '';
    const noOneSpecialHtml = specialNotes.length > 0
      ? `<div style="margin:14px 0 0;padding:12px 14px;background:${BRAND.warnBg};border:1px solid ${BRAND.warnBorder};border-left:4px solid ${BRAND.warnRule};border-radius:8px;font-size:14px;color:${BRAND.warnText};"><strong>Heads up:</strong> ${escapeHtml(specialNotes.map(e => e.title).join(', '))} may affect staffing today.</div>`
      : '';
    const noOneCardInner = `
<div style="margin:0 0 16px;padding:16px;background:${BRAND.surface2};border:1px solid ${BRAND.borderDefault};border-radius:8px;">
  <div style="font-size:14px;color:${BRAND.textPrimary};"><strong>Shift:</strong> ${escapeHtml(shiftInfo.shift_name)} — ${escapeHtml(shiftInfo.start_time)}–${escapeHtml(shiftInfo.end_time)} (${escapeHtml(shiftInfo.role)})</div>
  <div style="font-size:14px;color:${BRAND.textPrimary};margin-top:8px;"><strong>Date:</strong> ${escapeHtml(dateStr)}</div>
  <div style="font-size:14px;color:${BRAND.textPrimary};margin-top:8px;"><strong>Absent:</strong> ${escapeHtml(calledOutName)}</div>
</div>
<div style="margin:0 0 4px;">
  <div style="font-size:13px;font-weight:600;color:${BRAND.silver};text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Why I came up empty</div>
  <div style="font-size:14px;color:${BRAND.textPrimary};">Role needed: ${escapeHtml(shiftInfo.role)}.</div>
  ${reasonsListHtml}
  ${noOneSpecialHtml}
</div>`;
    const noOneBody = `
<p style="margin:0 0 12px;font-size:16px;color:${BRAND.textPrimary};line-height:1.65;">I went through the whole roster for the ${escapeHtml(shiftInfo.shift_name)} shift on ${escapeHtml(dateStr)} and couldn't find anyone qualified and available to cover for ${escapeHtml(calledOutName)}. You'll likely need to reach out to staff directly — here's what I checked so you're not starting from scratch.</p>
${brandActionCard('Coverage · No candidates found', noOneCardInner)}`;
    const noOneHtml = brandedEmailShell({
      bodyHtml: noOneBody,
      preheader: `No coverage candidates for ${shiftInfo.shift_name} on ${dateStr}`,
    });
    return { text: noOneText, html: noOneHtml };
  }

  // Build text sections by tier
  const sections: string[] = [header, ''];
  let currentTier = 0;
  let rank = 1;

  for (const c of display) {
    if (c.tier !== currentTier) {
      currentTier = c.tier;
      const labels: Record<number, string> = { 1: 'PREFERRED', 2: 'OVERTIME RISK', 3: 'ALREADY WORKING' };
      sections.push(labels[currentTier] ?? '');
    }
    const overtimeNote = c.would_exceed_max
      ? ` ⚠ would be ${(c.current_weekly_hours + c.shift_hours).toFixed(1)}h (max ${c.employee.max_weekly_hours}h)`
      : '';
    sections.push(
      `${rank}. ${c.employee.name} (${c.employee.primary_role}) • ${formatPhone(c.employee.contact_phone)} • ${c.current_weekly_hours.toFixed(1)}h this wk${overtimeNote}`
    );
    rank++;
  }

  if (specialNotes.length > 0) {
    sections.push('');
    sections.push(`⚠ Note: ${specialNotes.map(e => e.title + (e.staffing_notes ? ': ' + e.staffing_notes : '')).join(' | ')}`);
  }

  sections.push('');
  sections.push("Reply ALL and I'll reach out to everyone on this list, a name (or names) to contact just them, or tell me you'll handle it yourself.");

  const text = sections.join('\n');

  // ── Branded (Quria dark theme) HTML ──────────────────────────────────────
  // Conclusion-first: greeting + how to act sits above the action card; the
  // ranked candidate list + reply instructions live inside one brandActionCard.
  // The manager's "action" here is to reply (ALL / a name / handle it), so the
  // reply guidance is the card's call-to-action.
  const tierFg: Record<number, string> = { 1: BRAND.goodText, 2: BRAND.warnText, 3: BRAND.textSecondary };
  const tierLabels: Record<number, string> = { 1: 'Preferred', 2: 'Overtime risk', 3: 'Already working (extend shift)' };

  let candidatesHtml = '';
  let lastTier = 0;
  let htmlRank = 1;

  for (const c of display) {
    if (c.tier !== lastTier) {
      if (lastTier !== 0) candidatesHtml += '</div>';
      lastTier = c.tier;
      candidatesHtml += `<div style="margin:0 0 16px;"><div style="font-size:12px;font-weight:600;color:${tierFg[c.tier]};text-transform:uppercase;letter-spacing:0.07em;margin:0 0 8px;">${tierLabels[c.tier]}</div>`;
    }
    const overtimeNote = c.would_exceed_max
      ? `<span style="color:${BRAND.warnText};font-size:12px;"> ⚠ would be ${(c.current_weekly_hours + c.shift_hours).toFixed(1)}h (max ${c.employee.max_weekly_hours}h)</span>`
      : '';
    candidatesHtml +=
      `<div style="padding:10px 12px;background:${BRAND.surface2};border:1px solid ${BRAND.borderDefault};border-radius:8px;margin-bottom:6px;">` +
      `<strong style="color:${BRAND.textPrimary};">${htmlRank}. ${escapeHtml(c.employee.name)}</strong> <span style="color:${BRAND.textSecondary};">— ${escapeHtml(c.employee.primary_role)}</span><br>` +
      `<span style="color:${BRAND.silver};">${escapeHtml(formatPhone(c.employee.contact_phone))}</span> &bull; ` +
      `<span style="color:${BRAND.textSecondary};font-size:13px;">${c.current_weekly_hours.toFixed(1)}h this week${overtimeNote}</span>` +
      `</div>`;
    htmlRank++;
  }
  if (lastTier !== 0) candidatesHtml += '</div>';

  const specialNotesHtml = specialNotes.length > 0
    ? `<div style="margin:0 0 16px;padding:12px 14px;background:${BRAND.warnBg};border:1px solid ${BRAND.warnBorder};border-left:4px solid ${BRAND.warnRule};border-radius:8px;font-size:14px;color:${BRAND.warnText};">` +
      `<strong>Special notes:</strong> ${specialNotes.map(e => escapeHtml(e.title + (e.staffing_notes ? ': ' + e.staffing_notes : ''))).join('<br>')}` +
      `</div>`
    : '';

  const detailsHtml = `
<div style="margin:0 0 16px;padding:16px;background:${BRAND.surface2};border:1px solid ${BRAND.borderDefault};border-radius:8px;">
  <div style="font-size:14px;color:${BRAND.textPrimary};"><strong>Shift:</strong> ${escapeHtml(shiftInfo.shift_name)} — ${escapeHtml(shiftInfo.start_time)}–${escapeHtml(shiftInfo.end_time)} (${escapeHtml(shiftInfo.role)})</div>
  <div style="font-size:14px;color:${BRAND.textPrimary};margin-top:8px;"><strong>Date:</strong> ${escapeHtml(dateStr)}</div>
  <div style="font-size:14px;color:${BRAND.textPrimary};margin-top:8px;"><strong>Absent:</strong> ${escapeHtml(calledOutName)}</div>
</div>`;

  const replyGuidanceHtml = `
<div style="border-top:1px solid ${BRAND.borderDefault};margin:6px 0 0;padding-top:16px;font-size:14px;color:${BRAND.textPrimary};line-height:1.6;">
  Reply <strong>ALL</strong> and I'll reach out to everyone on this list, reply a <strong>name</strong> (or names) to contact just them, or tell me you'll handle it yourself.
</div>`;

  const cardInner = `${detailsHtml}${specialNotesHtml}${candidatesHtml}${replyGuidanceHtml}`;

  const introHtml = `
<p style="margin:0;font-size:16px;color:${BRAND.textPrimary};line-height:1.65;">${escapeHtml(calledOutName)} is out for the ${escapeHtml(shiftInfo.shift_name)} shift on ${escapeHtml(dateStr)}, so I pulled together who's qualified and available to cover. Just tell me who to reach out to and I'll take it from there.</p>`;

  const html = brandedEmailShell({
    bodyHtml: `${introHtml}
${brandActionCard('Action needed · Coverage', cardInner)}`,
    preheader: `Coverage needed: ${shiftInfo.shift_name} on ${dateStr}`,
  });

  return { text, html };
}

// ── Outreach helpers ──────────────────────────────────────────────────────────

async function getAegisSmsChannel(companyId: string): Promise<string | null> {
  const { data } = await supabase
    .from('company_channels')
    .select('channel_value')
    .eq('company_id', companyId)
    .eq('channel_type', 'sms')
    .maybeSingle();
  return (data as { channel_value: string } | null)?.channel_value ?? null;
}

// Constructs a synthetic InboundMessage/VerifiedContact for replying to manager from decision context
function managerReplyTarget(outreach: ActiveOutreach): { contact: VerifiedContact; message: InboundMessage } {
  const contact: VerifiedContact = {
    role: 'manager',
    company_id: outreach.company_id,
    employee_id: null,
    user_id: null,
    name: 'Manager',
    matched_identifier: outreach.manager_contact,
    channel: outreach.manager_channel,
  };
  const message: InboundMessage = {
    sender: outreach.manager_sender,
    recipient: outreach.manager_recipient,
    body: '',
    channel: outreach.manager_channel,
    raw_subject: outreach.manager_raw_subject,
    thread_id: outreach.manager_thread_id,
  };
  return { contact, message };
}

// Send outreach SMS to one employee and store their outreach record.
// Returns { sent: true } or { sent: false, reason: string }.
export async function dispatchOutreach(params: {
  employee: Employee;
  session: CoverageSession;
  aegisSmsNumber: string | null;
}): Promise<{ sent: true } | { sent: false; reason: string }> {
  const { employee, session, aegisSmsNumber } = params;

  const dateStr = formatDisplayDate(session.shift_date);
  const si = session.shift_info;
  const body =
    `${greeting(employee.name)} this is Aegis. ` +
    `${session.callout_employee_name} is out and we need coverage for the ` +
    `${si.shift_name} shift (${si.start_time}–${si.end_time}, ${si.role}) on ${dateStr}. ` +
    `Can you come in?\n\nReply YES to accept or NO to decline.`;

  // Email-first during the email rollout; fall back to SMS. (When Aegis has a
  // live phone number, flip this to prefer SMS for urgency.) Reply YES/NO works
  // the same on both channels, which is what makes the SMS migration a drop-in.
  let channel: 'sms' | 'email';
  if (employee.contact_email) {
    channel = 'email';
    // Email gets branded Accept/Decline BUTTONS (matching time-off & availability),
    // routed through the shared /webhooks/decision handler (decision_type:
    // 'coverage'). The plain-text body keeps "reply YES/NO" as a fallback for
    // clients that strip HTML, and SMS still uses reply YES/NO.
    const requestId = randomUUID();
    const acceptToken = randomUUID();
    const declineToken = randomUUID();
    // Token outlives the urgency window by 1h so a late click still resolves
    // cleanly (handled as "already filled" if someone else accepted).
    const tokenExpiry = new Date(Date.now() + session.urgency_window_minutes * 60 * 1000 + 60 * 60 * 1000).toISOString();
    const sharedTok = {
      decision_type: 'coverage' as const,
      request_id: requestId,
      company_id: session.company_id,
      employee_id: employee.id,
      employee_name: employee.name,
      expires_at: tokenExpiry,
    };
    await Promise.all([
      supabase.from('aegis_memory').insert({ company_id: session.company_id, memory_type: 'observation', source: `decision_token:${acceptToken}`, content: JSON.stringify({ ...sharedTok, action: 'approve' }) }),
      supabase.from('aegis_memory').insert({ company_id: session.company_id, memory_type: 'observation', source: `decision_token:${declineToken}`, content: JSON.stringify({ ...sharedTok, action: 'deny' }) }),
    ]);
    const acceptUrl = `${env.BASE_URL}/webhooks/decision?action=approve&requestId=${requestId}&token=${acceptToken}`;
    const declineUrl = `${env.BASE_URL}/webhooks/decision?action=deny&requestId=${requestId}&token=${declineToken}`;
    const introHtml = `<p style="margin:0 0 14px;color:${BRAND.textPrimary};font-size:15px;line-height:1.5;">${escapeHtml(greeting(employee.name))} this is Aegis. <strong>${escapeHtml(session.callout_employee_name)}</strong> is out and we need coverage for the <strong>${escapeHtml(si.shift_name)}</strong> shift (${escapeHtml(si.start_time)}–${escapeHtml(si.end_time)}, ${escapeHtml(si.role)}) on ${escapeHtml(dateStr)}.</p>`;
    const cardInner = `${brandedButtonRow([
      { url: acceptUrl, label: 'Yes, I can cover', variant: 'primary' },
      { url: declineUrl, label: "Can't make it", variant: 'secondary' },
    ])}
<div style="font-size:13px;color:${BRAND.textMuted};margin:10px 0 6px;">First to accept gets the shift. This link is just for you.</div>`;
    const html = brandedEmailShell({
      bodyHtml: `${introHtml}${brandActionCard('Coverage needed', cardInner)}`,
      preheader: `Can you cover the ${si.shift_name} shift on ${formatShortDate(session.shift_date)}?`,
    });
    await sendEmail({
      to: employee.contact_email,
      subject: `Can you cover the ${si.shift_name} shift on ${formatShortDate(session.shift_date)}?`,
      text: body,
      html,
      company_id: session.company_id,
    });
  } else if (employee.contact_phone && aegisSmsNumber) {
    channel = 'sms';
    await sendSms({ to: employee.contact_phone, from: aegisSmsNumber, body, company_id: session.company_id });
  } else {
    return { sent: false, reason: `${employee.name} has no email or phone on file` };
  }

  const outreach: ActiveOutreach = {
    company_id: session.company_id,
    employee_id: employee.id,
    shift_date: session.shift_date,
    shift_info: session.shift_info,
    callout_employee_name: session.callout_employee_name,
    callout_employee_id: session.callout_employee_id,
    aegis_sms_channel: aegisSmsNumber,
    employee_phone: employee.contact_phone,
    employee_channel: channel,
    employee_email: employee.contact_email,
    manager_contact: session.manager_contact,
    manager_channel: session.manager_channel,
    manager_sender: session.manager_sender,
    manager_recipient: session.manager_recipient,
    manager_raw_subject: session.manager_raw_subject,
    manager_thread_id: session.manager_thread_id,
    outreach_sent_at: new Date().toISOString(),
    window_expires_at: new Date(Date.now() + session.urgency_window_minutes * 60 * 1000).toISOString(),
    coverage_filled: false,
  };

  await storeOutreach(outreach);
  return { sent: true };
}

// Notify an employee (already outreached) that the shift is now filled.
async function notifyEmployeeShiftFilled(
  outreach: ActiveOutreach,
  employee: Employee
): Promise<void> {
  const body = `${greeting(employee.name)} the ${outreach.shift_info.shift_name} shift on ${formatShortDate(outreach.shift_date)} has been filled — no response needed. Thanks!`;
  if (outreach.employee_channel === 'email' && (outreach.employee_email || employee.contact_email)) {
    await sendEmail({
      to: (outreach.employee_email ?? employee.contact_email)!,
      subject: `Re: coverage for the ${outreach.shift_info.shift_name} shift`,
      text: body,
      company_id: outreach.company_id,
    });
  } else if (employee.contact_phone && outreach.aegis_sms_channel) {
    await sendSms({
      to: employee.contact_phone,
      from: outreach.aegis_sms_channel,
      body,
      company_id: outreach.company_id,
    });
  }
}

// ── Main handlers ─────────────────────────────────────────────────────────────

// Step 1: Manager reports a callout. Parse it, build candidates, send list.
export async function handleEmergencyCoverage(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  const today = await getCompanyDate(contact.company_id);

  // Extract structured details (use extracted if available, else re-parse with Claude)
  const raw = await extractEmergencyDetails(message.body, today);
  const shiftDate = raw.shift_date ?? today;
  const shiftNameHint = raw.shift_name ?? null;

  // Find the called-out employee
  const nameProvided = !!(raw.employee_name && raw.employee_name.trim());
  let calledOutEmployee: Employee | null = null;
  if (nameProvided) {
    calledOutEmployee = await findEmployeeByName(contact.company_id, raw.employee_name!);
  }

  // A name was given but we couldn't match it to the roster — ask rather than
  // guessing a shift, which produces a confidently-wrong candidate list.
  if (nameProvided && !calledOutEmployee) {
    await reply(
      contact,
      message,
      `I couldn't find anyone named "${raw.employee_name}" on the roster. Who needs coverage? ` +
        `Reply with their name as it appears in Homebase, or name the shift directly ` +
        `(for example: "the Saturday morning lifeguard shift").`
    );
    return;
  }

  const calledOutName = calledOutEmployee?.name ?? 'a team member';

  // Find schedule and shift info
  const scheduleData = await findSchedule(contact.company_id, shiftDate);

  // If we matched the employee, their actual scheduled shift is the source of
  // truth for role + times. If they aren't on the schedule that day, don't fall
  // back to an unrelated shift type — clarify instead of guessing.
  if (calledOutEmployee && scheduleData) {
    const scheduledThatDay = scheduleData.assignments.some(
      s => s.employee_id === calledOutEmployee!.id && s.date === shiftDate
    );
    if (!scheduledThatDay) {
      const otherDays = [
        ...new Set(
          scheduleData.assignments
            .filter(s => s.employee_id === calledOutEmployee!.id)
            .map(s => s.date)
        ),
      ].sort();
      const hint = otherDays.length
        ? ` ${calledOutEmployee.name} is scheduled on: ${otherDays.map(formatShortDate).join(', ')}.`
        : '';
      await reply(
        contact,
        message,
        `${calledOutEmployee.name} isn't on the schedule for ${formatDisplayDate(shiftDate)}.${hint} ` +
          `Which date needs coverage? You can also name the shift directly.`
      );
      return;
    }
  }

  const shiftInfo = await findShiftInfo(
    contact.company_id,
    shiftDate,
    calledOutEmployee?.id ?? null,
    shiftNameHint,
    scheduleData
  );

  // Graceful failure: no shift info at all
  if (!shiftInfo) {
    const dayName = new Date(shiftDate + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' });
    await reply(
      contact,
      message,
      `I couldn't find shift information for ${formatDisplayDate(shiftDate)}. ` +
        `No schedule has been published for that week and no shift types are configured for ${dayName}. ` +
        `Please set up shift types in Homebase or be more specific about which shift needs coverage (e.g., "morning shift" or "3pm–11pm").`
    );
    return;
  }

  // Load special notes and policies
  const [specialNotes, policyRes] = await Promise.all([
    getSpecialNotes(contact.company_id, shiftDate),
    supabase.from('policies').select('description, policy_value')
      .eq('company_id', contact.company_id)
      .in('policy_type', ['emergency', 'coverage']),
  ]);
  const policies = (policyRes.data ?? []) as { description: string | null; policy_value: string }[];

  // Build candidate pool
  const { tier1, tier2, tier3 } = await buildCandidatePool({
    company_id: contact.company_id,
    shift_date: shiftDate,
    shift_info: shiftInfo,
    called_out_employee_id: calledOutEmployee?.id ?? null,
    schedule_data: scheduleData,
  });

  // Log intake
  await logActivity({
    company_id: contact.company_id,
    action: 'emergency_coverage_requested',
    summary: `Manager requested coverage for ${calledOutName} — ${shiftInfo.shift_name} (${shiftInfo.role}) on ${shiftDate}`,
    metadata: {
      called_out_employee_id: calledOutEmployee?.id ?? null,
      called_out_name: calledOutName,
      shift_date: shiftDate,
      shift_name: shiftInfo.shift_name,
      role: shiftInfo.role,
      tier1_count: tier1.length,
      tier2_count: tier2.length,
      tier3_count: tier3.length,
      special_notes: specialNotes.map(e => e.title),
      policies: policies.map(p => p.policy_value),
    },
  });

  // Build and send candidate message
  const { text, html } = buildCandidateMessage(
    tier1, tier2, tier3, shiftInfo, shiftDate, calledOutName, specialNotes
  );

  const urgencyWindow = calcUrgencyWindowMinutes(shiftDate, shiftInfo.start_time);

  // Full ranked pool (Preferred → Overtime-risk → Already-working) for "show me
  // more" batches, plus how many the first message displays.
  const orderedPool: PoolCandidate[] = [...tier1, ...tier2, ...tier3].map(c => ({
    employee_id: c.employee.id,
    name: c.employee.name,
    primary_role: c.employee.primary_role,
    phone: c.employee.contact_phone,
    current_weekly_hours: c.current_weekly_hours,
    shift_hours: c.shift_hours,
    would_exceed_max: c.would_exceed_max,
    max_weekly_hours: c.employee.max_weekly_hours,
    tier: c.tier,
  }));
  const t12 = tier1.length + tier2.length;
  const shownCount = t12 > 0 ? Math.min(5, t12) : Math.min(5, tier3.length);

  // Store session (awaiting manager's name reply)
  const session: CoverageSession = {
    company_id: contact.company_id,
    manager_contact: contact.matched_identifier,
    manager_channel: message.channel,
    manager_sender: message.sender,
    manager_recipient: message.recipient,
    manager_raw_subject: message.raw_subject,
    manager_thread_id: message.thread_id,
    callout_employee_id: calledOutEmployee?.id ?? null,
    callout_employee_name: calledOutName,
    shift_date: shiftDate,
    shift_info: shiftInfo,
    state: 'awaiting_names',
    outreach_queue: [],
    outreach_results: [],
    coverage_filled: false,
    covered_by_employee_id: null,
    urgency_window_minutes: urgencyWindow,
    candidate_pool: orderedPool,
    shown_count: shownCount,
    expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
  };
  await storeSession(session);

  await reply(contact, message, text, html);
}

// Manager asked for more candidates ("show me more"): serve the next batch from
// the engine-ranked pool stored on the session.
async function presentAdditionalBatch(
  message: InboundMessage,
  contact: VerifiedContact,
  session: CoverageSession
): Promise<void> {
  const pool = session.candidate_pool ?? [];
  const shown = session.shown_count ?? 0;
  const next = pool.slice(shown, shown + 5);

  if (next.length === 0) {
    await reply(
      contact,
      message,
      `That's everyone qualified and available I could find for the ${session.shift_info.shift_name} shift. You may need to contact staff directly, or ask someone already working to extend.`
    );
    return;
  }

  const lines = next.map((c, i) => {
    const overtime = c.would_exceed_max
      ? ` ⚠ would be ${(c.current_weekly_hours + c.shift_hours).toFixed(1)}h (max ${c.max_weekly_hours}h)`
      : '';
    return `${shown + i + 1}. ${c.name} (${c.primary_role}) • ${formatPhone(c.phone)} • ${c.current_weekly_hours.toFixed(1)}h this wk${overtime}`;
  });

  await updateSession({ ...session, shown_count: shown + next.length });

  await reply(
    contact,
    message,
    `Here are more candidates:\n\n${lines.join('\n')}\n\nReply ALL to contact everyone shown, a name to contact just them, or "more" for additional options.`
  );

  await logActivity({
    company_id: contact.company_id,
    action: 'emergency_coverage_additional_batch',
    summary: `Showed an additional batch of coverage candidates for ${session.callout_employee_name}'s shift`,
    metadata: { shift_date: session.shift_date, shift_name: session.shift_info.shift_name, batch_from: shown, batch_size: next.length },
  });
}

// Does the manager's reply mean "contact everyone on the list" (vs naming
// specific people)? Kept tight so a bare name never matches.
export function isContactAll(body: string): boolean {
  const t = body.trim();
  return (
    /^(all|everyone|everybody)\b/i.test(t) ||
    /\b(all of them|all of the (employees|guards|staff)|contact all|reach out to all|message all|text all|email all|the whole list|the entire list|everyone on (the|that) list)\b/i.test(t)
  );
}

// Load active employees by id, preserving the given order.
async function loadEmployeesByIds(companyId: string, ids: string[]): Promise<Employee[]> {
  if (ids.length === 0) return [];
  const { data } = await supabase
    .from('employees')
    .select('*')
    .eq('company_id', companyId)
    .in('id', ids)
    .eq('active', true);
  const byId = new Map(((data ?? []) as Employee[]).map(e => [e.id, e]));
  return ids.map(id => byId.get(id)).filter((e): e is Employee => !!e);
}

// Blast outreach to a whole group at once (parallel). First YES wins — the
// accept/decline handlers already lock the shift and tell the rest "it's
// covered." Resets the session's contacted group + window to this batch.
async function blastBatch(params: {
  message: InboundMessage;
  contact: VerifiedContact;
  session: CoverageSession;
  employees: Employee[];
  notFound?: string[];
}): Promise<void> {
  const { message, contact, session, employees } = params;
  const notFound = params.notFound ?? [];
  const aegisSmsNumber = await getAegisSmsChannel(contact.company_id);

  const batchSession: CoverageSession = {
    ...session,
    state: 'outreach_in_progress',
    urgency_window_minutes: NEXT_BATCH_PROMPT_MINUTES,
    outreach_queue: employees.map(e => e.id),
    outreach_results: [
      ...session.outreach_results.filter(r => !employees.some(e => e.id === r.employee_id)),
      ...employees.map(e => ({
        employee_id: e.id,
        employee_name: e.name,
        response: 'pending' as const,
        responded_at: null,
      })),
    ],
  };
  await updateSession(batchSession);

  const sent: string[] = [];
  const failed: string[] = [];
  for (const emp of employees) {
    const r = await dispatchOutreach({ employee: emp, session: batchSession, aegisSmsNumber });
    if (r.sent) sent.push(emp.name);
    else failed.push(`${emp.name} (${r.reason})`);
  }

  const lines: string[] = [];
  if (sent.length) lines.push(`Reaching out to ${sent.join(', ')} now.`);
  if (failed.length) lines.push(`Couldn't reach: ${failed.join(', ')}.`);
  if (notFound.length) lines.push(`Not found: ${notFound.join(', ')}.`);
  lines.push(
    `I'll let you know the moment someone accepts. If no one responds within ${NEXT_BATCH_PROMPT_MINUTES} minutes, ` +
      `I'll check whether you want me to reach out to another batch.`
  );
  await reply(contact, message, lines.join('\n\n'));

  await logActivity({
    company_id: contact.company_id,
    action: 'emergency_coverage_batch_sent',
    summary: `Contacted ${sent.length} employee(s) for ${session.callout_employee_name}'s shift: ${sent.join(', ')}`,
    metadata: {
      shift_date: session.shift_date,
      shift_name: session.shift_info.shift_name,
      contacted: sent,
      failed,
      window_minutes: NEXT_BATCH_PROMPT_MINUTES,
    },
  });
}

// Manager said "yes, send the next batch" — blast the next slice of the pool.
async function blastNextBatch(
  message: InboundMessage,
  contact: VerifiedContact,
  session: CoverageSession
): Promise<void> {
  const pool = session.candidate_pool ?? [];
  const shown = session.shown_count ?? 0;
  const next = pool
    .slice(shown, shown + NEXT_BATCH_SIZE)
    .filter(c => c.employee_id !== session.callout_employee_id);

  if (next.length === 0) {
    await clearSession(contact.company_id);
    await reply(
      contact,
      message,
      `That's everyone qualified and available I could find for the ${session.shift_info.shift_name} shift. ` +
        `You'll need to contact staff directly or ask someone already working to extend.`
    );
    return;
  }

  const employees = await loadEmployeesByIds(contact.company_id, next.map(c => c.employee_id));
  await blastBatch({
    message,
    contact,
    session: { ...session, shown_count: shown + next.length },
    employees,
  });
}

// Pure decision for the manager's "send another batch?" button (#11): given the
// live session (or null) and which button was clicked, what's the outcome?
//  • no session            → not_found (expired / already resolved)
//  • stop                  → stopped
//  • send, more in pool    → sent
//  • send, pool exhausted  → exhausted
export type CoverageBatchOutcome = 'sent' | 'stopped' | 'exhausted' | 'not_found';
export function classifyCoverageBatchButton(
  session: { candidate_pool?: { employee_id: string }[]; shown_count?: number } | null,
  action: 'send' | 'stop',
): CoverageBatchOutcome {
  if (!session) return 'not_found';
  if (action === 'stop') return 'stopped';
  const pool = session.candidate_pool ?? [];
  const shown = session.shown_count ?? 0;
  return shown >= pool.length ? 'exhausted' : 'sent';
}

// #11 — the email-BUTTON version of the "send another batch?" prompt. Called by
// /webhooks/decision (decision_type: 'coverage_batch') when a manager clicks
// "Send next batch" or "No, I've got it". Reconstructs the manager context from
// the stored session and reuses the same blastNextBatch / clear logic as the
// reply path. Returns an outcome for the confirmation page.
export async function processCoverageBatchButton(params: {
  companyId: string;
  managerContact: string;
  action: 'send' | 'stop';
}): Promise<{ outcome: CoverageBatchOutcome; shiftName: string }> {
  const session = await getActiveCoverageSession(params.companyId, params.managerContact);
  const outcome = classifyCoverageBatchButton(session, params.action);
  if (!session) return { outcome: 'not_found', shiftName: '' };
  const shiftName = session.shift_info.shift_name;

  if (outcome === 'stopped') {
    await clearSession(session.company_id);
    await logActivity({
      company_id: session.company_id,
      action: 'emergency_coverage_declined_outreach',
      summary: `Manager declined another batch (email button) for ${session.callout_employee_name}'s shift`,
      metadata: { shift_date: session.shift_date, shift_name: shiftName, via: 'button' },
    });
    return { outcome, shiftName };
  }

  if (outcome === 'exhausted') {
    await clearSession(session.company_id);
    return { outcome, shiftName };
  }

  // outcome === 'sent' — reconstruct the manager context and blast the next batch.
  const managerMessage: InboundMessage = {
    sender: session.manager_sender,
    recipient: session.manager_recipient,
    body: '',
    channel: session.manager_channel,
    raw_subject: session.manager_raw_subject,
    thread_id: session.manager_thread_id,
  };
  const managerContact: VerifiedContact = {
    role: 'manager',
    company_id: session.company_id,
    employee_id: null,
    user_id: null,
    name: 'Manager',
    matched_identifier: session.manager_contact,
    channel: session.manager_channel,
  };
  await blastNextBatch(managerMessage, managerContact, session);
  await logActivity({
    company_id: session.company_id,
    action: 'emergency_coverage_additional_batch',
    summary: `Manager requested another batch (email button) for ${session.callout_employee_name}'s shift`,
    metadata: { shift_date: session.shift_date, shift_name: shiftName, via: 'button', batch_from: session.shown_count ?? 0 },
  });
  return { outcome: 'sent', shiftName };
}

// The contacted group is exhausted with no acceptance (everyone declined or the
// window lapsed). Ask the manager whether to send another batch — we never
// auto-send. Shared by the decline path and the timeout scheduler.
export async function promptForNextBatchOrExhaust(params: {
  session: CoverageSession;
  managerContact: VerifiedContact;
  managerMessage: InboundMessage;
  updatedResults: OutreachResult[];
}): Promise<void> {
  const { session, managerContact, managerMessage, updatedResults } = params;
  const pool = session.candidate_pool ?? [];
  const shown = session.shown_count ?? 0;
  const moreAvailable = shown < pool.length;

  if (moreAvailable) {
    await updateSession({
      ...session,
      outreach_results: updatedResults,
      state: 'awaiting_next_batch_decision',
    });
    const promptText =
      `No one I reached out to has accepted the ${session.shift_info.shift_name} shift on ${formatShortDate(session.shift_date)}. ` +
      `Want me to reach out to another batch of employees?`;
    // Email managers get one-click buttons (#11); the reply-YES/NO path still
    // works as a fallback (handled in handleManagerCoverageReply). SMS managers
    // get the plain reply prompt.
    if (managerContact.channel === 'email') {
      const requestId = randomUUID();
      const sendToken = randomUUID();
      const stopToken = randomUUID();
      const sharedTok = {
        decision_type: 'coverage_batch' as const,
        request_id: requestId,
        company_id: session.company_id,
        manager_contact: session.manager_contact,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      };
      await Promise.all([
        supabase.from('aegis_memory').insert({ company_id: session.company_id, memory_type: 'observation', source: `decision_token:${sendToken}`, content: JSON.stringify({ ...sharedTok, action: 'approve' }) }),
        supabase.from('aegis_memory').insert({ company_id: session.company_id, memory_type: 'observation', source: `decision_token:${stopToken}`, content: JSON.stringify({ ...sharedTok, action: 'deny' }) }),
      ]);
      const sendUrl = `${env.BASE_URL}/webhooks/decision?action=approve&requestId=${requestId}&token=${sendToken}`;
      const stopUrl = `${env.BASE_URL}/webhooks/decision?action=deny&requestId=${requestId}&token=${stopToken}`;
      const detail =
        `<p style="margin:0 0 16px;font-size:15px;color:${BRAND.textPrimary};line-height:1.6;">${escapeHtml(promptText)}</p>` +
        brandedButtonRow([
          { url: sendUrl, label: 'Send next batch', variant: 'primary' },
          { url: stopUrl, label: "No, I've got it", variant: 'secondary' },
        ]);
      const bodyHtml =
        `<p style="margin:0 0 18px;font-size:16px;color:${BRAND.textPrimary};line-height:1.65;">Still looking for coverage on the ${escapeHtml(session.shift_info.shift_name)} shift.</p>` +
        brandActionCard('Coverage still needed', detail);
      await sendEmail({
        to: session.manager_contact,
        subject: `Coverage still needed — send another batch?`,
        text: `${promptText} Reply YES to send the next group, or NO to handle it yourself.`,
        html: brandedEmailShell({ bodyHtml, preheader: 'Send another batch of coverage outreach?' }),
        company_id: session.company_id,
      });
    } else {
      await reply(managerContact, managerMessage, `${promptText} Reply YES to send the next group, or NO to handle it yourself.`);
    }
    await logActivity({
      company_id: session.company_id,
      action: 'emergency_coverage_prompt_next_batch',
      summary: `Asked manager whether to contact another batch for ${session.callout_employee_name}'s shift`,
      metadata: { shift_date: session.shift_date, shift_name: session.shift_info.shift_name, already_contacted: shown },
    });
  } else {
    await clearSession(session.company_id);
    await reply(
      managerContact,
      managerMessage,
      `No one accepted, and I've now reached everyone qualified and available for the ${session.shift_info.shift_name} shift on ${formatShortDate(session.shift_date)}. ` +
        `You'll need to contact staff directly.`
    );
    await logActivity({
      company_id: session.company_id,
      action: 'emergency_coverage_queue_exhausted',
      summary: `All candidates exhausted for ${session.callout_employee_name}'s shift on ${session.shift_date}`,
      metadata: { shift_date: session.shift_date, shift_name: session.shift_info.shift_name },
    });
  }
}

// Step 2: Manager decides who to contact (everyone on the list or specific
// names), or answers a "send another batch?" prompt. Outreach goes out in
// parallel — first YES wins.
export async function handleManagerCoverageReply(
  message: InboundMessage,
  contact: VerifiedContact,
  session: CoverageSession
): Promise<void> {
  // A leftover "awaiting_names" session must NOT swallow a brand-new coverage
  // request. If the manager's message itself reads as a fresh call-out (rather
  // than a name reply like "Kori" or "contact Addison"), abandon the stale
  // session and start a new coverage flow. Without this, "Maisey can't come in,
  // I need coverage" gets parsed as "contact Maisey" — contacting the person
  // who's actually out.
  if (isNewCoverageRequest(message.body)) {
    await clearSession(contact.company_id);
    await handleEmergencyCoverage(message, contact, {});
    return;
  }

  // The manager is answering a "send another batch?" prompt.
  if (session.state === 'awaiting_next_batch_decision') {
    if (parseEmployeeResponse(message.body) === 'yes') {
      await blastNextBatch(message, contact, session);
    } else {
      await clearSession(contact.company_id);
      await reply(
        contact,
        message,
        "Understood — I'll leave it with you. Reply any time if you'd like me to find more coverage."
      );
      await logActivity({
        company_id: contact.company_id,
        action: 'emergency_coverage_declined_outreach',
        summary: `Manager declined another batch for ${session.callout_employee_name}'s shift`,
        metadata: { shift_date: session.shift_date, shift_name: session.shift_info.shift_name },
      });
    }
    return;
  }

  const names = await extractOutreachNames(message.body);

  // "Show me more" (view only — does NOT contact anyone) when the manager isn't
  // asking to contact everyone.
  if (
    names.length === 0 &&
    !isContactAll(message.body) &&
    /\b(more|others?|else|additional|other options?|who else|anyone else)\b/i.test(message.body)
  ) {
    await presentAdditionalBatch(message, contact, session);
    return;
  }

  // "Reach out to everyone on the list" → blast the shown batch in parallel.
  if (isContactAll(message.body)) {
    const shown = session.shown_count ?? 0;
    const pool = session.candidate_pool ?? [];
    const ids = (shown > 0 ? pool.slice(0, shown) : pool)
      .map(c => c.employee_id)
      .filter(id => id !== session.callout_employee_id);
    const employees = await loadEmployeesByIds(contact.company_id, ids);
    if (employees.length === 0) {
      await reply(contact, message, "I don't have any candidates to contact for this shift. Reply with a specific name if you have someone in mind.");
      return;
    }
    await blastBatch({ message, contact, session, employees });
    return;
  }

  if (names.length === 0) {
    // Manager is declining Aegis outreach or just following up.
    await clearSession(contact.company_id);
    await reply(
      contact,
      message,
      "Understood — I'll leave it with you. Let me know if you need a new candidate list."
    );
    await logActivity({
      company_id: contact.company_id,
      action: 'emergency_coverage_declined_outreach',
      summary: `Manager declined Aegis outreach for ${session.callout_employee_name}'s shift`,
      metadata: { shift_date: session.shift_date, shift_name: session.shift_info.shift_name },
    });
    return;
  }

  // Specific names → contact just those (in parallel).
  const employees: Employee[] = [];
  const notFound: string[] = [];
  const skippedCallout: string[] = [];

  for (const name of names) {
    const emp = await findEmployeeByName(contact.company_id, name);
    if (!emp) {
      notFound.push(name);
      continue;
    }
    // Never contact the person who's out for their own shift.
    if (session.callout_employee_id && emp.id === session.callout_employee_id) {
      skippedCallout.push(emp.name);
      continue;
    }
    // Avoid queueing the same person twice if the manager repeats a name.
    if (!employees.some(e => e.id === emp.id)) employees.push(emp);
  }

  if (employees.length === 0) {
    if (skippedCallout.length > 0) {
      await reply(
        contact,
        message,
        `${skippedCallout.join(', ')} is the person who's out for this shift, so I can't ask them to cover it. ` +
          `Who else would you like me to contact? Reply "all" to contact everyone on the list, or "more" to see additional options.`
      );
      return;
    }
    await reply(
      contact,
      message,
      `I couldn't find employees named ${notFound.join(', ')} in the system. Please check the names and try again.`
    );
    return;
  }

  await blastBatch({ message, contact, session, employees, notFound });
}

// Step 3: Employee responds to outreach SMS.
export async function handleEmployeeCoverageResponse(
  message: InboundMessage,
  contact: VerifiedContact,
  outreach: ActiveOutreach
): Promise<void> {
  const { contact: managerContact, message: managerMessage } = managerReplyTarget(outreach);
  const responseType = parseEmployeeResponse(message.body);

  // Check if coverage was already filled
  if (outreach.coverage_filled) {
    await reply(
      contact,
      message,
      `Thanks for getting back to us! The ${outreach.shift_info.shift_name} shift on ${formatShortDate(outreach.shift_date)} has already been filled — no action needed.`
    );
    await clearOutreach(outreach.company_id, contact.employee_id!);
    await logActivity({
      company_id: outreach.company_id,
      action: 'emergency_coverage_late_response',
      summary: `${contact.name} responded after shift was already filled`,
      metadata: { response: responseType, shift_date: outreach.shift_date },
    });
    return;
  }

  if (responseType === 'unclear') {
    await reply(
      contact,
      message,
      `I need a clear answer — can you cover the ${outreach.shift_info.shift_name} shift on ${formatShortDate(outreach.shift_date)}? Reply YES or NO.`
    );
    return;
  }

  // Load current session
  const session = await getActiveCoverageSession(outreach.company_id, outreach.manager_contact);

  if (responseType === 'yes') {
    // Mark coverage filled
    if (session) {
      const updatedSession: CoverageSession = {
        ...session,
        coverage_filled: true,
        covered_by_employee_id: contact.employee_id,
        outreach_results: session.outreach_results.map(r =>
          r.employee_id === contact.employee_id
            ? { ...r, response: 'yes', responded_at: new Date().toISOString() }
            : r
        ),
      };
      await updateSession(updatedSession);

      // Notify remaining queued employees that the shift is filled
      const remaining = session.outreach_queue.filter(id => id !== contact.employee_id);
      for (const empId of remaining) {
        const empOutreach = await getActiveOutreach(outreach.company_id, empId);
        if (empOutreach) {
          const { data: empData } = await supabase.from('employees').select('*')
            .eq('id', empId).single();
          const emp = empData as Employee | null;
          if (emp) {
            try { await notifyEmployeeShiftFilled(empOutreach, emp); } catch { /* best effort */ }
          }
          // Keep the record but mark it filled (don't delete it). If this person
          // replies late, getActiveOutreach still finds it, so the reply is
          // handled as a coverage response ("already covered") instead of
          // falling through to the swap workflow. The timeout poller cleans
          // these up once the window lapses.
          const { _memory_id: _omit, ...rest } = empOutreach;
          await storeOutreach({ ...rest, coverage_filled: true });
        }
      }
      await clearSession(outreach.company_id);
    }

    await clearOutreach(outreach.company_id, contact.employee_id!);

    // Put the coverer on the schedule in place of the absent employee, so
    // Homebase reflects reality and hours/pay follow. Best-effort — a failure
    // here must not block the confirmation, just changes the manager note.
    const scheduleResult = await applyCoverageToSchedule({
      company_id: outreach.company_id,
      shift_date: outreach.shift_date,
      shift_info: outreach.shift_info,
      absent_employee_id: outreach.callout_employee_id ?? session?.callout_employee_id ?? null,
      coverer_employee_id: contact.employee_id!,
      coverer_name: contact.name,
    }).catch(err => {
      console.error('[coverage] schedule update failed:', err);
      return { updated: false, reason: 'error' } as { updated: boolean; reason?: string };
    });

    // Confirm to employee
    await reply(
      contact,
      message,
      `Great, thank you! You're confirmed for the ${outreach.shift_info.shift_name} shift (${outreach.shift_info.start_time}–${outreach.shift_info.end_time}) on ${formatDisplayDate(outreach.shift_date)}.`
    );

    // Notify manager — tell them whether the schedule auto-updated.
    const scheduleNote = scheduleResult.updated
      ? ` I've updated the schedule to show ${contact.name} on this shift.`
      : ` Heads up: I couldn't update the published schedule automatically — please move them onto the shift in Homebase.`;
    await reply(
      managerContact,
      managerMessage,
      `${contact.name} has accepted coverage for the ${outreach.shift_info.shift_name} shift (${outreach.shift_info.role}) on ${formatShortDate(outreach.shift_date)}. Shift is now covered.${scheduleNote}`
    );

    await logActivity({
      company_id: outreach.company_id,
      action: 'emergency_coverage_accepted',
      summary: `${contact.name} accepted coverage for ${outreach.callout_employee_name}'s shift on ${outreach.shift_date}`,
      metadata: {
        employee_id: contact.employee_id,
        shift_date: outreach.shift_date,
        shift_name: outreach.shift_info.shift_name,
        role: outreach.shift_info.role,
        late_response: new Date() > new Date(outreach.window_expires_at),
        schedule_updated: scheduleResult.updated,
        schedule_update_reason: scheduleResult.reason ?? null,
      },
    });
  } else {
    // Employee said no
    await clearOutreach(outreach.company_id, contact.employee_id!);

    // Confirm to employee
    await reply(contact, message, "No problem — thanks for letting us know!");

    // Update session with this decline. We do NOT auto-advance to the next
    // person — the blast already went to the whole group. If everyone we
    // contacted has now responded (declined/no-response) without an accept,
    // ask the manager whether to send another batch.
    if (session) {
      const updatedResults = session.outreach_results.map(r =>
        r.employee_id === contact.employee_id
          ? { ...r, response: 'no' as const, responded_at: new Date().toISOString() }
          : r
      );

      const anyPending = session.outreach_queue.some(id =>
        updatedResults.some(r => r.employee_id === id && r.response === 'pending')
      );

      if (anyPending) {
        // Still waiting on others in this batch — just record the decline.
        await updateSession({ ...session, outreach_results: updatedResults });
      } else {
        // Whole contacted group is done with no acceptance.
        await promptForNextBatchOrExhaust({
          session,
          managerContact,
          managerMessage,
          updatedResults,
        });
      }
    }

    await logActivity({
      company_id: outreach.company_id,
      action: 'emergency_coverage_declined',
      summary: `${contact.name} declined coverage for ${outreach.callout_employee_name}'s shift on ${outreach.shift_date}`,
      metadata: {
        employee_id: contact.employee_id,
        shift_date: outreach.shift_date,
        shift_name: outreach.shift_info.shift_name,
        late_response: new Date() > new Date(outreach.window_expires_at),
      },
    });
  }
}

// ── Email Accept/Decline buttons (decision_type: 'coverage') ──────────────────
//
// The coverage email's branded buttons hit /webhooks/decision, which calls
// processCoverageButtonDecision below. This path is ISOLATED from the inbound
// reply handler above (it does not use the employee's inbound message — the
// branded landing page is the employee's confirmation) but reuses the same
// in-module helpers, so the schedule swap, "shift filled" fan-out, manager
// notification, and batch-exhaust logic stay identical.

export type CoverageButtonOutcome = 'accepted' | 'declined' | 'already_filled' | 'not_found';

/** Pure: what a button click resolves to, given the live outreach state. */
export function classifyCoverageButton(
  outreach: ActiveOutreach | null,
  action: 'accept' | 'decline',
): 'accept' | 'decline' | 'already_filled' | 'not_found' {
  if (!outreach) return 'not_found';
  if (action === 'accept' && outreach.coverage_filled) return 'already_filled';
  return action;
}

export async function processCoverageButtonDecision(params: {
  companyId: string;
  employeeId: string;
  employeeName: string;
  action: 'accept' | 'decline';
}): Promise<{ outcome: CoverageButtonOutcome; shiftName: string; shiftDate: string; scheduleUpdated?: boolean }> {
  const { companyId, employeeId, employeeName, action } = params;
  const outreach = await getActiveOutreach(companyId, employeeId);
  const decision = classifyCoverageButton(outreach, action);
  if (!outreach || decision === 'not_found') {
    return { outcome: 'not_found', shiftName: '', shiftDate: '' };
  }
  const shiftName = outreach.shift_info.shift_name;
  const shiftDate = outreach.shift_date;

  if (decision === 'already_filled') {
    await clearOutreach(companyId, employeeId);
    await logActivity({
      company_id: companyId,
      action: 'emergency_coverage_late_response',
      summary: `${employeeName} clicked accept after the shift was already filled`,
      metadata: { via: 'email_button', shift_date: shiftDate },
    });
    return { outcome: 'already_filled', shiftName, shiftDate };
  }

  const { contact: managerContact, message: managerMessage } = managerReplyTarget(outreach);
  const session = await getActiveCoverageSession(companyId, outreach.manager_contact);

  if (decision === 'accept') {
    if (session) {
      await updateSession({
        ...session,
        coverage_filled: true,
        covered_by_employee_id: employeeId,
        outreach_results: session.outreach_results.map(r =>
          r.employee_id === employeeId ? { ...r, response: 'yes', responded_at: new Date().toISOString() } : r
        ),
      });
      const remaining = session.outreach_queue.filter(id => id !== employeeId);
      for (const empId of remaining) {
        const empOutreach = await getActiveOutreach(companyId, empId);
        if (empOutreach) {
          const { data: empData } = await supabase.from('employees').select('*').eq('id', empId).single();
          const emp = empData as Employee | null;
          if (emp) { try { await notifyEmployeeShiftFilled(empOutreach, emp); } catch { /* best effort */ } }
          const { _memory_id: _omit, ...rest } = empOutreach;
          await storeOutreach({ ...rest, coverage_filled: true });
        }
      }
      await clearSession(companyId);
    }
    await clearOutreach(companyId, employeeId);

    const scheduleResult = await applyCoverageToSchedule({
      company_id: companyId,
      shift_date: outreach.shift_date,
      shift_info: outreach.shift_info,
      absent_employee_id: outreach.callout_employee_id ?? session?.callout_employee_id ?? null,
      coverer_employee_id: employeeId,
      coverer_name: employeeName,
    }).catch(err => {
      console.error('[coverage] schedule update failed:', err);
      return { updated: false, reason: 'error' } as { updated: boolean; reason?: string };
    });

    const scheduleNote = scheduleResult.updated
      ? ` I've updated the schedule to show ${employeeName} on this shift.`
      : ` Heads up: I couldn't update the published schedule automatically — please move them onto the shift in Homebase.`;
    await reply(
      managerContact,
      managerMessage,
      `${employeeName} has accepted coverage for the ${shiftName} shift (${outreach.shift_info.role}) on ${formatShortDate(shiftDate)}. Shift is now covered.${scheduleNote}`
    );
    await logActivity({
      company_id: companyId,
      action: 'emergency_coverage_accepted',
      summary: `${employeeName} accepted coverage (email button) for ${outreach.callout_employee_name}'s shift on ${shiftDate}`,
      metadata: { via: 'email_button', employee_id: employeeId, shift_date: shiftDate, shift_name: shiftName, role: outreach.shift_info.role, schedule_updated: scheduleResult.updated, schedule_update_reason: scheduleResult.reason ?? null },
    });
    return { outcome: 'accepted', shiftName, shiftDate, scheduleUpdated: scheduleResult.updated };
  }

  // decline
  await clearOutreach(companyId, employeeId);
  if (session) {
    const updatedResults = session.outreach_results.map(r =>
      r.employee_id === employeeId ? { ...r, response: 'no' as const, responded_at: new Date().toISOString() } : r
    );
    const anyPending = session.outreach_queue.some(id =>
      updatedResults.some(r => r.employee_id === id && r.response === 'pending')
    );
    if (anyPending) {
      await updateSession({ ...session, outreach_results: updatedResults });
    } else {
      await promptForNextBatchOrExhaust({ session, managerContact, managerMessage, updatedResults });
    }
  }
  await logActivity({
    company_id: companyId,
    action: 'emergency_coverage_declined',
    summary: `${employeeName} declined coverage (email button) for ${outreach.callout_employee_name}'s shift on ${shiftDate}`,
    metadata: { via: 'email_button', employee_id: employeeId, shift_date: shiftDate, shift_name: shiftName },
  });
  return { outcome: 'declined', shiftName, shiftDate };
}
