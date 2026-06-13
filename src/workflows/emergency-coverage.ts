import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { reply } from '../messaging/reply';
import { sendSms } from '../messaging/sms';
import { sendEmail } from '../messaging/email';
import { greeting } from '../messaging/greeting';
import { generateReply } from '../ai/claude';
import { getSpecialNotes } from './special-notes';
import type { InboundMessage, VerifiedContact } from '../security/types';
import type { Employee, Availability, Event } from '../db/types';

// ── Internal schedule types ───────────────────────────────────────────────────
// These define the expected shape of schedules.data — schedule-build must match.

interface ScheduleAssignment {
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
  state: 'awaiting_names' | 'outreach_in_progress';
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
  const system =
    `You are a data extractor for a workforce scheduling system. Today is ${today}. ` +
    `Extract emergency coverage details from a manager's message. ` +
    `Respond with ONLY valid JSON: {"employee_name":string|null,"shift_date":"YYYY-MM-DD","shift_name":string|null}`;
  const text = await generateReply(system, body, []);
  try {
    return JSON.parse(text) as { employee_name: string | null; shift_date: string; shift_name: string | null };
  } catch {
    return { employee_name: null, shift_date: today, shift_name: null };
  }
}

async function extractOutreachNames(body: string): Promise<string[]> {
  const system =
    'Extract employee names from this manager reply about coverage outreach. ' +
    'Return ONLY valid JSON: {"names":["Name1","Name2"]} or {"names":[]} if declining/no names.';
  const text = await generateReply(system, body, []);
  try {
    const parsed = JSON.parse(text) as { names: unknown };
    return Array.isArray(parsed.names) ? (parsed.names as string[]) : [];
  } catch {
    return [];
  }
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
    return { text: noOneText, html: `<pre style="font-family:sans-serif">${noOneText}</pre>` };
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
  sections.push("Reply with a name and I'll contact them, or handle it yourself.");

  const text = sections.join('\n');

  // HTML version
  const tierColors: Record<number, string> = { 1: '#16a34a', 2: '#d97706', 3: '#6b7280' };
  const tierBgs: Record<number, string> = { 1: '#f0fdf4', 2: '#fffbeb', 3: '#f9fafb' };
  const tierLabels: Record<number, string> = { 1: 'PREFERRED', 2: 'OVERTIME RISK', 3: 'ALREADY WORKING (extend shift)' };

  let candidatesHtml = '';
  let lastTier = 0;
  let htmlRank = 1;

  for (const c of display) {
    if (c.tier !== lastTier) {
      if (lastTier !== 0) candidatesHtml += '</div>';
      lastTier = c.tier;
      candidatesHtml += `<div style="margin:16px 0;"><p style="font-weight:bold;color:${tierColors[c.tier]};margin:0 0 8px;">${tierLabels[c.tier]}</p>`;
    }
    const overtimeNote = c.would_exceed_max
      ? `<span style="color:#dc2626;font-size:12px;"> ⚠ would be ${(c.current_weekly_hours + c.shift_hours).toFixed(1)}h (max ${c.employee.max_weekly_hours}h)</span>`
      : '';
    candidatesHtml +=
      `<div style="padding:10px 12px;background:${tierBgs[c.tier]};border:1px solid #e5e7eb;border-radius:4px;margin-bottom:6px;">` +
      `<strong>${htmlRank}. ${c.employee.name}</strong> — ${c.employee.primary_role}<br>` +
      `<span style="color:#374151;">${formatPhone(c.employee.contact_phone)}</span> &bull; ` +
      `<span style="color:#6b7280;font-size:13px;">${c.current_weekly_hours.toFixed(1)}h this week${overtimeNote}</span>` +
      `</div>`;
    htmlRank++;
  }
  if (lastTier !== 0) candidatesHtml += '</div>';

  const specialNotesHtml = specialNotes.length > 0
    ? `<div style="background:#fef9c3;border:1px solid #fde047;padding:10px;border-radius:4px;margin:16px 0;">` +
      `<strong>⚠ Special Notes:</strong> ${specialNotes.map(e => e.title + (e.staffing_notes ? ': ' + e.staffing_notes : '')).join('<br>')}` +
      `</div>`
    : '';

  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;">
<h3 style="margin:0 0 4px;">Coverage Needed</h3>
<table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
  <tr><td style="font-weight:bold;padding:6px 10px;background:#f9fafb;border:1px solid #e5e7eb;">Shift</td><td style="padding:6px 10px;border:1px solid #e5e7eb;">${shiftInfo.shift_name} — ${shiftInfo.start_time}–${shiftInfo.end_time} (${shiftInfo.role})</td></tr>
  <tr><td style="font-weight:bold;padding:6px 10px;background:#f9fafb;border:1px solid #e5e7eb;">Date</td><td style="padding:6px 10px;border:1px solid #e5e7eb;">${dateStr}</td></tr>
  <tr><td style="font-weight:bold;padding:6px 10px;background:#f9fafb;border:1px solid #e5e7eb;">Absent</td><td style="padding:6px 10px;border:1px solid #e5e7eb;">${calledOutName}</td></tr>
</table>
${candidatesHtml}
${specialNotesHtml}
<p style="margin-top:16px;color:#374151;">Reply with a name and I'll contact them, or handle it yourself.</p>
</div>`;

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
    await sendEmail({
      to: employee.contact_email,
      subject: `Can you cover the ${si.shift_name} shift on ${formatShortDate(session.shift_date)}?`,
      text: body,
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
  let calledOutEmployee: Employee | null = null;
  if (raw.employee_name) {
    calledOutEmployee = await findEmployeeByName(contact.company_id, raw.employee_name);
  }
  const calledOutName = calledOutEmployee?.name ?? raw.employee_name ?? 'Unknown employee';

  // Find schedule and shift info
  const scheduleData = await findSchedule(contact.company_id, shiftDate);
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
    `Here are more candidates:\n\n${lines.join('\n')}\n\nReply with a name and I'll contact them, or "more" for additional options.`
  );

  await logActivity({
    company_id: contact.company_id,
    action: 'emergency_coverage_additional_batch',
    summary: `Showed an additional batch of coverage candidates for ${session.callout_employee_name}'s shift`,
    metadata: { shift_date: session.shift_date, shift_name: session.shift_info.shift_name, batch_from: shown, batch_size: next.length },
  });
}

// Step 2: Manager replies with employee names. Start sequential outreach.
export async function handleManagerCoverageReply(
  message: InboundMessage,
  contact: VerifiedContact,
  session: CoverageSession
): Promise<void> {
  const names = await extractOutreachNames(message.body);

  // "Show me more / anyone else / additional batch" → serve the next batch from
  // the engine-ranked pool, without recomputing.
  if (names.length === 0 && /\b(more|others?|else|another|additional|other options?|who else|anyone else)\b/i.test(message.body)) {
    await presentAdditionalBatch(message, contact, session);
    return;
  }

  if (names.length === 0) {
    // Manager is declining Aegis outreach or just following up
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

  // Look up each employee by name
  const employees: Employee[] = [];
  const notFound: string[] = [];

  for (const name of names) {
    const emp = await findEmployeeByName(contact.company_id, name);
    if (emp) employees.push(emp);
    else notFound.push(name);
  }

  if (employees.length === 0) {
    await reply(
      contact,
      message,
      `I couldn't find employees named ${notFound.join(', ')} in the system. Please check the names and try again.`
    );
    return;
  }

  // SMS channel is optional now — outreach goes by email when the employee has
  // one, and falls back to SMS otherwise. dispatchOutreach reports per-candidate
  // if someone can't be reached on any channel.
  const aegisSmsNumber = await getAegisSmsChannel(contact.company_id);

  // Update session to outreach_in_progress
  const updatedSession: CoverageSession = {
    ...session,
    state: 'outreach_in_progress',
    outreach_queue: employees.map(e => e.id),
    outreach_results: employees.map(e => ({
      employee_id: e.id,
      employee_name: e.name,
      response: 'pending' as const,
      responded_at: null,
    })),
  };
  await updateSession(updatedSession);

  // Contact first employee immediately
  const firstEmployee = employees[0];
  const dispatchResult = await dispatchOutreach({
    employee: firstEmployee,
    session: updatedSession,
    aegisSmsNumber,
  });

  if (!dispatchResult.sent) {
    await reply(
      contact,
      message,
      `Unable to contact ${firstEmployee.name}: ${dispatchResult.reason}. Please contact them directly.`
    );
  } else {
    const orderSummary = employees.map((e, i) => `${i + 1}. ${e.name}`).join('\n');
    const notFoundNote = notFound.length > 0 ? `\n\nNot found: ${notFound.join(', ')}` : '';
    await reply(
      contact,
      message,
      `Contacting employees in order:\n${orderSummary}\n\n` +
        `Reaching out to ${firstEmployee.name} now. Response window: ${session.urgency_window_minutes} minutes.${notFoundNote}\n\n` +
        "I'll update you after each response."
    );
  }

  await logActivity({
    company_id: contact.company_id,
    action: 'emergency_coverage_outreach_started',
    summary: `Outreach started for ${session.callout_employee_name}'s shift — contacting ${employees.map(e => e.name).join(', ')}`,
    metadata: {
      shift_date: session.shift_date,
      shift_name: session.shift_info.shift_name,
      employees_queued: employees.map(e => ({ id: e.id, name: e.name })),
      first_contact: firstEmployee.name,
      window_minutes: session.urgency_window_minutes,
    },
  });
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
          await clearOutreach(outreach.company_id, empId);
        }
      }
      await clearSession(outreach.company_id);
    }

    await clearOutreach(outreach.company_id, contact.employee_id!);

    // Confirm to employee
    await reply(
      contact,
      message,
      `Great, thank you! You're confirmed for the ${outreach.shift_info.shift_name} shift (${outreach.shift_info.start_time}–${outreach.shift_info.end_time}) on ${formatDisplayDate(outreach.shift_date)}.`
    );

    // Notify manager
    await reply(
      managerContact,
      managerMessage,
      `${contact.name} has accepted coverage for the ${outreach.shift_info.shift_name} shift (${outreach.shift_info.role}) on ${formatShortDate(outreach.shift_date)}. Shift is now covered.`
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
      },
    });
  } else {
    // Employee said no
    await clearOutreach(outreach.company_id, contact.employee_id!);

    // Update session with this decline
    if (session) {
      const updatedResults = session.outreach_results.map(r =>
        r.employee_id === contact.employee_id
          ? { ...r, response: 'no' as const, responded_at: new Date().toISOString() }
          : r
      );
      const remainingQueue = session.outreach_queue.filter(id => id !== contact.employee_id);

      // Confirm to employee
      await reply(contact, message, "No problem — thanks for letting us know!");

      // Find next employee in queue who hasn't been contacted yet
      const nextId = remainingQueue.find(id =>
        updatedResults.find(r => r.employee_id === id && r.response === 'pending')
      );

      if (nextId) {
        const { data: nextEmpData } = await supabase.from('employees').select('*')
          .eq('id', nextId).single();
        const nextEmp = nextEmpData as Employee | null;
        const aegisSmsNumber = await getAegisSmsChannel(outreach.company_id);

        if (nextEmp && aegisSmsNumber) {
          const dispatchResult = await dispatchOutreach({
            employee: nextEmp,
            session: { ...session, outreach_results: updatedResults },
            aegisSmsNumber,
          });

          await updateSession({ ...session, outreach_results: updatedResults });

          if (dispatchResult.sent) {
            await reply(
              managerContact,
              managerMessage,
              `${contact.name} declined. Contacting ${nextEmp.name} now (window: ${session.urgency_window_minutes} min).`
            );
          } else {
            await reply(
              managerContact,
              managerMessage,
              `${contact.name} declined. Unable to contact ${nextEmp.name}: ${dispatchResult.reason}. No more candidates in queue.`
            );
            await clearSession(outreach.company_id);
          }
        } else {
          await updateSession({ ...session, outreach_results: updatedResults });
          await reply(
            managerContact,
            managerMessage,
            `${contact.name} declined. Unable to contact the next employee — please try directly.`
          );
        }
      } else {
        // No more candidates in queue
        await updateSession({ ...session, outreach_results: updatedResults });
        await clearSession(outreach.company_id);
        await reply(
          managerContact,
          managerMessage,
          `${contact.name} declined and the outreach queue is exhausted. ` +
            `No coverage found for the ${session.shift_info.shift_name} shift on ${formatShortDate(session.shift_date)}. ` +
            `You may need to contact additional staff directly.`
        );
      }
    } else {
      // No session found (already cleared or expired)
      await reply(contact, message, "No problem — thanks for letting us know!");
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
