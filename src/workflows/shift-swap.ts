import { randomUUID } from 'crypto';
import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { reply } from '../messaging/reply';
import { sendSms } from '../messaging/sms';
import { sendEmail } from '../messaging/email';
import { generateReply } from '../ai/claude';
import { computeWageEstimate } from '../lib/schedule-simulator';
import { env } from '../config/env';
import type { InboundMessage, VerifiedContact } from '../security/types';
import type { Employee, Policy } from '../db/types';
import type { ScheduleAssignment } from './schedule-build';

// ── Schedule types (shared shape with emergency-coverage and schedule-build) ──

interface ScheduleData {
  assignments: ScheduleAssignment[];
}

// ── Public state types ────────────────────────────────────────────────────────

export interface PendingSwap {
  mode: 'directed' | 'facilitated';
  company_id: string;
  requester_id: string;
  requester_name: string;
  channel: 'sms' | 'email';
  sender: string;
  recipient: string;
  raw_subject?: string;
  thread_id?: string;
  shift_date: string;
  shift_name: string;
  role: string;
  shift_start: string;
  shift_end: string;
  schedule_id: string | null;
  // Mode 1 only:
  target_employee_id?: string;
  target_employee_name?: string;
  expires_at: string;
}

export interface SwapOutreach {
  mode: 'directed' | 'facilitated';
  company_id: string;
  requester_id: string;
  requester_name: string;
  requester_channel: 'sms' | 'email';
  requester_sender: string;
  requester_recipient: string;
  requester_raw_subject?: string;
  requester_thread_id?: string;
  receiver_id: string;
  receiver_phone: string;
  aegis_sms_channel: string;
  shift_date: string;
  shift_name: string;
  role: string;
  shift_start: string;
  shift_end: string;
  schedule_id: string | null;
  // Mode 2: remaining candidates not yet contacted (empty for Mode 1)
  candidate_queue: string[];
  outreach_sent_at: string;
  expires_at: string;
}

interface ValidationResult {
  valid: boolean;
  reason: string | null;
  policy_note?: string;
}

// ── Store helpers ─────────────────────────────────────────────────────────────

export async function getPendingSwap(
  companyId: string,
  employeeId: string
): Promise<(PendingSwap & { _memory_id: string }) | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .eq('source', `swap_pending:${employeeId}`)
    .maybeSingle();

  if (!data) return null;
  try {
    const row = data as { id: string; content: string };
    const pending = JSON.parse(row.content) as PendingSwap;
    if (new Date(pending.expires_at) < new Date()) {
      await supabase.from('aegis_memory').delete().eq('id', row.id);
      return null;
    }
    return { ...pending, _memory_id: row.id };
  } catch {
    return null;
  }
}

export async function getActiveSwapOutreach(
  companyId: string,
  employeeId: string
): Promise<(SwapOutreach & { _memory_id: string }) | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .eq('source', `swap_outreach:${employeeId}`)
    .maybeSingle();

  if (!data) return null;
  try {
    const row = data as { id: string; content: string };
    const outreach = JSON.parse(row.content) as SwapOutreach;
    return { ...outreach, _memory_id: row.id };
  } catch {
    return null;
  }
}

async function storePendingSwap(pending: PendingSwap): Promise<void> {
  await supabase.from('aegis_memory').delete()
    .eq('company_id', pending.company_id)
    .eq('source', `swap_pending:${pending.requester_id}`);
  await supabase.from('aegis_memory').insert({
    company_id: pending.company_id,
    memory_type: 'observation',
    source: `swap_pending:${pending.requester_id}`,
    content: JSON.stringify(pending),
  });
}

async function clearPendingSwap(companyId: string, requesterId: string): Promise<void> {
  await supabase.from('aegis_memory').delete()
    .eq('company_id', companyId)
    .eq('source', `swap_pending:${requesterId}`);
}

async function storeSwapOutreach(outreach: SwapOutreach): Promise<void> {
  await supabase.from('aegis_memory').delete()
    .eq('company_id', outreach.company_id)
    .eq('source', `swap_outreach:${outreach.receiver_id}`);
  await supabase.from('aegis_memory').insert({
    company_id: outreach.company_id,
    memory_type: 'observation',
    source: `swap_outreach:${outreach.receiver_id}`,
    content: JSON.stringify(outreach),
  });
}

async function clearSwapOutreach(companyId: string, receiverId: string): Promise<void> {
  await supabase.from('aegis_memory').delete()
    .eq('company_id', companyId)
    .eq('source', `swap_outreach:${receiverId}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeShiftHours(start: string, end: string): number {
  const toMins = (t: string) => { const [h, m] = t.slice(0, 5).split(':').map(Number); return h * 60 + m; };
  let mins = toMins(end) - toMins(start);
  if (mins < 0) mins += 24 * 60;
  return Math.round((mins / 60) * 10) / 10;
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

function parseYesNo(body: string): 'yes' | 'no' | 'unclear' {
  const lower = body.trim().toLowerCase();
  if (/^(yes|yeah|yep|sure|ok|okay|correct|confirm|that'?s right|right)/.test(lower)) return 'yes';
  if (/^(no|nope|can'?t|wrong|incorrect|cancel|nah|don'?t)/.test(lower)) return 'no';
  return 'unclear';
}

async function getAegisSmsChannel(companyId: string): Promise<string | null> {
  const { data } = await supabase.from('company_channels').select('channel_value')
    .eq('company_id', companyId).eq('channel_type', 'sms').maybeSingle();
  return (data as { channel_value: string } | null)?.channel_value ?? null;
}

async function findEmployeeByName(companyId: string, name: string): Promise<Employee | null> {
  const { data: exact } = await supabase.from('employees').select('*')
    .eq('company_id', companyId).eq('active', true).ilike('name', name.trim()).limit(1).maybeSingle();
  if (exact) return exact as Employee;
  const firstName = name.trim().split(/\s+/)[0];
  const { data: partial } = await supabase.from('employees').select('*')
    .eq('company_id', companyId).eq('active', true).ilike('name', `${firstName}%`).limit(1).maybeSingle();
  return (partial as Employee | null) ?? null;
}

async function getReceiverWeeklyHours(companyId: string, receiverId: string, shiftDate: string): Promise<number> {
  const { data } = await supabase.from('schedules').select('data')
    .eq('company_id', companyId).eq('status', 'published')
    .lte('week_start', shiftDate).gte('week_end', shiftDate)
    .order('generated_at', { ascending: false }).limit(1).maybeSingle();
  if (!data) return 0;
  const sched = (data as { data: ScheduleData }).data;
  return sched.assignments
    .filter(a => a.employee_id === receiverId)
    .reduce((sum, a) => sum + (a.hours ?? computeShiftHours(a.start_time, a.end_time)), 0);
}

// ── Schedule helpers ──────────────────────────────────────────────────────────

async function findSchedule(
  companyId: string,
  date: string
): Promise<{ id: string; data: ScheduleData } | null> {
  const base = supabase.from('schedules').select('id, data')
    .eq('company_id', companyId).lte('week_start', date).gte('week_end', date)
    .order('generated_at', { ascending: false }).limit(1);

  const { data: pub } = await base.eq('status', 'published').maybeSingle();
  if (pub) {
    const row = pub as { id: string; data: ScheduleData };
    return { id: row.id, data: row.data };
  }
  const { data: draft } = await base.eq('status', 'draft').maybeSingle();
  if (draft) {
    const row = draft as { id: string; data: ScheduleData };
    return { id: row.id, data: row.data };
  }
  return null;
}

function findRequesterShift(schedData: ScheduleData, requesterId: string, shiftDate: string): ScheduleAssignment | null {
  return schedData.assignments.find(a => a.employee_id === requesterId && a.date === shiftDate) ?? null;
}

// Executes an approved swap: updates the schedule data and recalculates wages.
// Exported so the decision webhook can call it after manager approval.
export async function executeScheduleSwap(
  companyId: string,
  scheduleId: string,
  shiftDate: string,
  shiftName: string,
  requesterId: string,
  receiverId: string,
  receiverName: string
): Promise<void> {
  const { data: schedRow } = await supabase.from('schedules').select('id, data, staffing_report')
    .eq('id', scheduleId).single();
  if (!schedRow) return;

  const row = schedRow as { id: string; data: ScheduleData; staffing_report: Record<string, unknown> | null };
  const updatedAssignments = row.data.assignments.map(a => {
    if (a.date === shiftDate && a.shift_name === shiftName && a.employee_id === requesterId) {
      return { ...a, employee_id: receiverId, employee_name: receiverName };
    }
    return a;
  });

  const updatedData: ScheduleData = { ...row.data, assignments: updatedAssignments };
  const wages = await computeWageEstimate(companyId, updatedAssignments);

  await supabase.from('schedules').update({
    data: updatedData as unknown as Record<string, unknown>,
    staffing_report: { ...(row.staffing_report ?? {}), estimated_wages: wages },
  }).eq('id', scheduleId);
}

// ── Swap validation ───────────────────────────────────────────────────────────

async function validateSwap(params: {
  company_id: string;
  requester_id: string;
  receiver: Employee;
  shift_date: string;
  role: string;
  shift_hours: number;
  policies: Policy[];
}): Promise<ValidationResult> {
  const { company_id, requester_id, receiver, shift_date, role, shift_hours, policies } = params;

  // 1. Qualification check
  if (!receiver.qualified_roles.includes(role)) {
    return { valid: false, reason: `${receiver.name} is not qualified for the ${role} role.` };
  }

  // 2. Never-conflict check
  const { data: conflictData } = await supabase
    .from('employee_conflicts')
    .select('severity')
    .eq('company_id', company_id)
    .eq('severity', 'never')
    .or(`and(employee_id_1.eq.${requester_id},employee_id_2.eq.${receiver.id}),and(employee_id_1.eq.${receiver.id},employee_id_2.eq.${requester_id})`);

  if (conflictData && (conflictData as { severity: string }[]).length > 0) {
    return { valid: false, reason: `${receiver.name} has a scheduling conflict that prevents this swap.` };
  }

  // 3. Approved TO check
  const { data: toData } = await supabase
    .from('time_off_requests')
    .select('id')
    .eq('company_id', company_id)
    .eq('employee_id', receiver.id)
    .eq('status', 'approved')
    .lte('start_date', shift_date)
    .gte('end_date', shift_date)
    .limit(1);

  if (toData && (toData as { id: string }[]).length > 0) {
    return { valid: false, reason: `${receiver.name} has approved time off on that date.` };
  }

  // 4. Overtime check
  const weeklyHours = await getReceiverWeeklyHours(company_id, receiver.id, shift_date);
  if (weeklyHours + shift_hours > receiver.max_weekly_hours) {
    return {
      valid: false,
      reason: `${receiver.name} would exceed their maximum weekly hours (currently at ${weeklyHours.toFixed(1)}h, max ${receiver.max_weekly_hours}h, shift adds ${shift_hours}h).`,
    };
  }

  // 5. Policy check via Claude (notice requirements, blackout periods, etc.)
  if (policies.length > 0) {
    const policyText = policies.map(p => `${p.policy_key}: ${p.policy_value}${p.description ? ' — ' + p.description : ''}`).join('\n');
    const today = new Date().toISOString().slice(0, 10);
    const system =
      'You are reviewing a shift swap against company swap policies. ' +
      'Respond ONLY with valid JSON: {"valid":true|false,"reason":string|null}. ' +
      'If valid=false, reason must be a specific, human-readable explanation.';
    const context = `Swap date: ${shift_date}. Today: ${today}.\nPolicies:\n${policyText}`;
    const text = await generateReply(system, context, []);
    try {
      const result = JSON.parse(text) as { valid: boolean; reason: string | null };
      if (!result.valid) {
        return { valid: false, reason: result.reason ?? 'This swap does not meet company swap policies.', policy_note: result.reason ?? undefined };
      }
    } catch {
      // If Claude fails, don't block — log and continue
      console.warn('[shift-swap] policy validation Claude parse failed');
    }
  }

  return { valid: true, reason: null };
}

// ── Candidate pool (Mode 2) ───────────────────────────────────────────────────

async function buildSwapCandidates(params: {
  company_id: string;
  requester_id: string;
  shift_date: string;
  role: string;
  shift_start: string;
  shift_end: string;
  shift_hours: number;
}): Promise<Employee[]> {
  const { company_id, requester_id, shift_date, role, shift_start, shift_end, shift_hours } = params;
  const dayOfWeek = new Date(shift_date + 'T12:00:00Z').getUTCDay();

  const [empRes, availRes, toRes, schedRes] = await Promise.all([
    supabase.from('employees').select('*').eq('company_id', company_id).eq('active', true),
    supabase.from('availability').select('*').eq('company_id', company_id),
    supabase.from('time_off_requests').select('employee_id')
      .eq('company_id', company_id).eq('status', 'approved')
      .lte('start_date', shift_date).gte('end_date', shift_date),
    supabase.from('schedules').select('data')
      .eq('company_id', company_id).eq('status', 'published')
      .lte('week_start', shift_date).gte('week_end', shift_date)
      .order('generated_at', { ascending: false }).limit(1).maybeSingle(),
  ]);

  const employees = (empRes.data ?? []) as Employee[];
  const availability = (availRes.data ?? []) as { employee_id: string; day_of_week: number; start_time: string; end_time: string }[];
  const onTO = new Set((toRes.data ?? []).map((r: { employee_id: string }) => r.employee_id));

  const schedData = schedRes.data ? (schedRes.data as { data: ScheduleData }).data : null;
  const weeklyHoursMap = new Map<string, number>();
  if (schedData) {
    for (const a of schedData.assignments) {
      const h = a.hours ?? computeShiftHours(a.start_time, a.end_time);
      weeklyHoursMap.set(a.employee_id, (weeklyHoursMap.get(a.employee_id) ?? 0) + h);
    }
  }

  const availByEmp = new Map<string, typeof availability>();
  for (const a of availability) {
    if (!availByEmp.has(a.employee_id)) availByEmp.set(a.employee_id, []);
    availByEmp.get(a.employee_id)!.push(a);
  }

  // Load never-conflicts for the requester to exclude them as candidates
  const { data: conflictData } = await supabase
    .from('employee_conflicts')
    .select('employee_id_1, employee_id_2')
    .eq('company_id', company_id)
    .eq('severity', 'never')
    .or(`employee_id_1.eq.${requester_id},employee_id_2.eq.${requester_id}`);

  const neverConflictIds = new Set<string>();
  for (const c of (conflictData ?? []) as { employee_id_1: string; employee_id_2: string }[]) {
    neverConflictIds.add(c.employee_id_1 === requester_id ? c.employee_id_2 : c.employee_id_1);
  }

  const ns = shift_start.slice(0, 5);
  const ne = shift_end.slice(0, 5);

  const candidates = employees.filter(emp => {
    if (emp.id === requester_id) return false;
    if (onTO.has(emp.id)) return false;
    if (neverConflictIds.has(emp.id)) return false;
    if (!emp.qualified_roles.includes(role)) return false;
    const weeklyHours = weeklyHoursMap.get(emp.id) ?? 0;
    if (weeklyHours + shift_hours > emp.max_weekly_hours) return false;
    const empAvail = availByEmp.get(emp.id) ?? [];
    return empAvail.some(a =>
      a.day_of_week === dayOfWeek &&
      a.start_time.slice(0, 5) <= ns &&
      a.end_time.slice(0, 5) >= ne
    );
  });

  // Sort: fewest weekly hours first, then alphabetically
  candidates.sort((a, b) => {
    const ha = weeklyHoursMap.get(a.id) ?? 0;
    const hb = weeklyHoursMap.get(b.id) ?? 0;
    return ha !== hb ? ha - hb : a.name.localeCompare(b.name);
  });

  return candidates;
}

// ── AI extraction ─────────────────────────────────────────────────────────────

async function extractSwapDetails(body: string, today: string): Promise<{
  shift_date: string | null;
  shift_name: string | null;
  target_employee_name: string | null;
}> {
  const system =
    `You are a data extractor for a workforce scheduling system. Today is ${today}. ` +
    'Extract shift swap details from an employee message. ' +
    'Respond with ONLY valid JSON: {"shift_date":"YYYY-MM-DD"|null,"shift_name":string|null,"target_employee_name":string|null}';
  const text = await generateReply(system, body, []);
  try {
    return JSON.parse(text) as { shift_date: string | null; shift_name: string | null; target_employee_name: string | null };
  } catch {
    return { shift_date: null, shift_name: null, target_employee_name: null };
  }
}

// ── Manager notification ──────────────────────────────────────────────────────

async function sendManagerSwapApprovalRequest(params: {
  company_id: string;
  swap_request_id: string;
  requester: Employee;
  requester_channel: 'sms' | 'email';
  requester_sender: string;
  receiver: Employee;
  shift_date: string;
  shift_name: string;
  role: string;
  shift_start: string;
  shift_end: string;
  aegis_sms_channel: string | null;
}): Promise<void> {
  const { company_id, swap_request_id, requester, receiver, shift_date, shift_name, role, shift_start, shift_end } = params;

  // Find manager
  const { data: managerData } = await supabase.from('users').select('id, email, name')
    .eq('company_id', company_id).in('role', ['manager', 'owner'])
    .order('role', { ascending: true }).limit(1).maybeSingle();
  if (!managerData) return;
  const manager = managerData as { id: string; email: string; name: string };

  // Manager phone (optional)
  const { data: managerEmpData } = await supabase.from('employees').select('contact_phone')
    .eq('company_id', company_id).eq('contact_email', manager.email).maybeSingle();
  const managerPhone = (managerEmpData as { contact_phone: string | null } | null)?.contact_phone ?? null;

  const approveToken = randomUUID();
  const denyToken = randomUUID();
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const sharedPayload = {
    decision_type: 'swap' as const,
    request_id: swap_request_id,
    company_id,
    requester_id: requester.id,
    requester_name: requester.name,
    requester_channel: params.requester_channel,
    requester_contact: params.requester_sender,
    aegis_sms_channel: params.aegis_sms_channel,
    receiver_id: receiver.id,
    receiver_name: receiver.name,
    shift_date,
    shift_name,
    role,
    expires_at: expires,
  };

  await Promise.all([
    supabase.from('aegis_memory').insert({
      company_id,
      memory_type: 'observation',
      source: `decision_token:${approveToken}`,
      content: JSON.stringify({ ...sharedPayload, action: 'approve' }),
    }),
    supabase.from('aegis_memory').insert({
      company_id,
      memory_type: 'observation',
      source: `decision_token:${denyToken}`,
      content: JSON.stringify({ ...sharedPayload, action: 'deny' }),
    }),
  ]);

  const base = env.BASE_URL;
  const approveUrl = `${base}/webhooks/decision?action=approve&requestId=${swap_request_id}&token=${approveToken}`;
  const denyUrl = `${base}/webhooks/decision?action=deny&requestId=${swap_request_id}&token=${denyToken}`;

  const dateStr = formatDisplayDate(shift_date);
  const subject = `Swap Request — ${requester.name} ↔ ${receiver.name} (${formatShortDate(shift_date)})`;

  const text =
    `Hi ${manager.name},\n\n` +
    `${requester.name} and ${receiver.name} have agreed to swap a shift.\n\n` +
    `Shift:      ${shift_name} (${role}) on ${dateStr}\n` +
    `Time:       ${shift_start}–${shift_end}\n` +
    `Giving up:  ${requester.name}\n` +
    `Taking on:  ${receiver.name}\n\n` +
    `APPROVE: ${approveUrl}\n` +
    `DENY:    ${denyUrl}\n\n` +
    'These links expire in 7 days. — Aegis';

  const html = `<!DOCTYPE html><html lang="en"><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
<h2 style="margin:0 0 4px;">Shift Swap Request</h2>
<p style="color:#6b7280;margin:0 0 20px;">Both employees have agreed — your approval is needed.</p>
<table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
  <tr><td style="padding:8px 12px;background:#f9fafb;font-weight:bold;border:1px solid #e5e7eb;">Shift</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">${shift_name} (${role}) — ${shift_start}–${shift_end}</td></tr>
  <tr><td style="padding:8px 12px;background:#f9fafb;font-weight:bold;border:1px solid #e5e7eb;">Date</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">${dateStr}</td></tr>
  <tr><td style="padding:8px 12px;background:#f9fafb;font-weight:bold;border:1px solid #e5e7eb;">Giving up</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">${requester.name}</td></tr>
  <tr><td style="padding:8px 12px;background:#f9fafb;font-weight:bold;border:1px solid #e5e7eb;">Taking on</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">${receiver.name}</td></tr>
</table>
<div style="text-align:center;margin:32px 0;">
  <a href="${approveUrl}" style="background:#16a34a;color:#fff;padding:12px 32px;text-decoration:none;border-radius:6px;font-weight:bold;font-size:15px;margin:0 8px;display:inline-block;">&#10003; Approve</a>
  <a href="${denyUrl}" style="background:#dc2626;color:#fff;padding:12px 32px;text-decoration:none;border-radius:6px;font-weight:bold;font-size:15px;margin:0 8px;display:inline-block;">&#10007; Deny</a>
</div>
<p style="color:#9ca3af;font-size:12px;text-align:center;">Links expire in 7 days &bull; Generated by Aegis</p>
</body></html>`;

  await sendEmail({ to: manager.email, subject, text, html, company_id });

  if (managerPhone && params.aegis_sms_channel) {
    await sendSms({
      to: managerPhone,
      from: params.aegis_sms_channel,
      body: `${requester.name} and ${receiver.name} want to swap the ${shift_name} shift on ${formatShortDate(shift_date)}. Full details and approval options are in your email from Aegis.`,
      company_id,
    });
  }
}

// ── Execute confirmed swap (no manager approval needed) ───────────────────────

async function executeSwapNow(params: {
  company_id: string;
  requester: Employee;
  requester_channel: 'sms' | 'email';
  requester_sender: string;
  requester_recipient: string;
  requester_raw_subject?: string;
  requester_thread_id?: string;
  receiver: Employee;
  shift_date: string;
  shift_name: string;
  role: string;
  shift_start: string;
  shift_end: string;
  schedule_id: string | null;
  aegis_sms_channel: string | null;
}): Promise<void> {
  const { company_id, requester, receiver, shift_date, shift_name, role, shift_start, shift_end, schedule_id } = params;

  // Create approved swap_request record
  const { data: swapRow } = await supabase.from('swap_requests').insert({
    company_id,
    requesting_employee_id: requester.id,
    receiving_employee_id: receiver.id,
    shift_date,
    shift_name,
    role,
    status: 'approved',
    initiated_by: 'aegis',
    decided_at: new Date().toISOString(),
    decided_by: 'aegis',
    notes: 'Auto-approved — no manager approval required per company policy.',
  }).select('id').single();

  const swapId = (swapRow as { id: string } | null)?.id ?? 'unknown';

  // Update schedule
  if (schedule_id) {
    await executeScheduleSwap(company_id, schedule_id, shift_date, shift_name, requester.id, receiver.id, receiver.name);
  }

  const dateStr = formatDisplayDate(shift_date);
  const shiftDesc = `${shift_name} (${shift_start}–${shift_end}, ${role}) on ${dateStr}`;

  // Notify requester
  const requesterMsg: InboundMessage = {
    sender: params.requester_sender, recipient: params.requester_recipient, body: '',
    channel: params.requester_channel, raw_subject: params.requester_raw_subject, thread_id: params.requester_thread_id,
  };
  const requesterContact: VerifiedContact = {
    role: 'employee', company_id, employee_id: requester.id, user_id: null,
    name: requester.name, matched_identifier: params.requester_sender, channel: params.requester_channel,
  };
  await reply(requesterContact, requesterMsg, `Your swap has been confirmed! ${receiver.name} will cover your ${shiftDesc}.`);

  // Notify receiver via SMS
  if (receiver.contact_phone && params.aegis_sms_channel) {
    await sendSms({
      to: receiver.contact_phone,
      from: params.aegis_sms_channel,
      body: `Hi ${receiver.name.split(' ')[0]}, your swap with ${requester.name} is confirmed. You're covering the ${shiftDesc}.`,
      company_id,
    });
  }

  await logActivity({
    company_id,
    action: 'swap_approved',
    entity_type: 'swap_request',
    entity_id: swapId,
    summary: `Swap approved: ${requester.name} ↔ ${receiver.name} for ${shift_name} on ${shift_date}`,
    metadata: { requester_id: requester.id, receiver_id: receiver.id, shift_date, shift_name, role, schedule_updated: !!schedule_id },
  });
}

// ── Main handlers ─────────────────────────────────────────────────────────────

export async function handleInitiateSwap(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const raw = await extractSwapDetails(message.body, today);

  const shiftDate = raw.shift_date ?? today;
  const shiftNameHint = raw.shift_name ?? null;
  const targetName = raw.target_employee_name ?? null;

  // Find the requester's shift in the schedule
  const schedule = await findSchedule(contact.company_id, shiftDate);
  let shift: ScheduleAssignment | null = null;
  if (schedule) {
    shift = findRequesterShift(schedule.data, contact.employee_id!, shiftDate);
    // If we have a hint but no exact match, try to find by shift_name
    if (!shift && shiftNameHint) {
      shift = schedule.data.assignments.find(a =>
        a.date === shiftDate && a.shift_name.toLowerCase().includes(shiftNameHint.toLowerCase())
      ) ?? null;
    }
  }

  if (!shift) {
    await reply(contact, message,
      `I couldn't find a shift for you on ${formatDisplayDate(shiftDate)}${shiftNameHint ? ` matching "${shiftNameHint}"` : ''}. ` +
      "Double-check the date, or reach out to your manager if you think there's a shift missing."
    );
    return;
  }

  const shiftHours = shift.hours ?? computeShiftHours(shift.start_time, shift.end_time);
  const mode: 'directed' | 'facilitated' = targetName ? 'directed' : 'facilitated';

  // Load swap policies for validation
  const { data: policyData } = await supabase.from('policies').select('*')
    .eq('company_id', contact.company_id).eq('policy_type', 'swaps');
  const policies = (policyData ?? []) as Policy[];

  if (mode === 'directed') {
    const targetEmployee = await findEmployeeByName(contact.company_id, targetName!);
    if (!targetEmployee) {
      await reply(contact, message,
        `I couldn't find an employee named "${targetName}" in the system. Please check the name and try again, or ask Aegis to find someone for you.`
      );
      return;
    }

    const validation = await validateSwap({
      company_id: contact.company_id,
      requester_id: contact.employee_id!,
      receiver: targetEmployee,
      shift_date: shiftDate,
      role: shift.role,
      shift_hours: shiftHours,
      policies,
    });

    if (!validation.valid) {
      await reply(contact, message,
        `This swap can't proceed: ${validation.reason} Please choose a different employee or contact your manager.`
      );
      await logActivity({
        company_id: contact.company_id,
        action: 'swap_validation_failed',
        summary: `${contact.name}'s swap request with ${targetEmployee.name} failed validation: ${validation.reason}`,
        metadata: { requester_id: contact.employee_id, receiver_id: targetEmployee.id, shift_date: shiftDate, reason: validation.reason },
      });
      return;
    }

    // Validation passed — ask requester to confirm
    const pending: PendingSwap = {
      mode: 'directed',
      company_id: contact.company_id,
      requester_id: contact.employee_id!,
      requester_name: contact.name,
      channel: message.channel,
      sender: message.sender,
      recipient: message.recipient,
      raw_subject: message.raw_subject,
      thread_id: message.thread_id,
      shift_date: shiftDate,
      shift_name: shift.shift_name,
      role: shift.role,
      shift_start: shift.start_time,
      shift_end: shift.end_time,
      schedule_id: schedule?.id ?? null,
      target_employee_id: targetEmployee.id,
      target_employee_name: targetEmployee.name,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
    await storePendingSwap(pending);

    await reply(contact, message,
      `You want to swap your ${shift.shift_name} shift on ${formatDisplayDate(shiftDate)} with ${targetEmployee.name}. Is that correct? Reply "yes" to confirm or "no" to cancel.`
    );
  } else {
    // Mode 2: facilitated — quick feasibility check
    const candidates = await buildSwapCandidates({
      company_id: contact.company_id,
      requester_id: contact.employee_id!,
      shift_date: shiftDate,
      role: shift.role,
      shift_start: shift.start_time,
      shift_end: shift.end_time,
      shift_hours: shiftHours,
    });

    const pending: PendingSwap = {
      mode: 'facilitated',
      company_id: contact.company_id,
      requester_id: contact.employee_id!,
      requester_name: contact.name,
      channel: message.channel,
      sender: message.sender,
      recipient: message.recipient,
      raw_subject: message.raw_subject,
      thread_id: message.thread_id,
      shift_date: shiftDate,
      shift_name: shift.shift_name,
      role: shift.role,
      shift_start: shift.start_time,
      shift_end: shift.end_time,
      schedule_id: schedule?.id ?? null,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
    await storePendingSwap(pending);

    const candidateNote = candidates.length > 0
      ? `I found ${candidates.length} potential candidate${candidates.length !== 1 ? 's' : ''}. `
      : 'I didn\'t find any available candidates right now, but ';

    await reply(contact, message,
      `You want someone to take your ${shift.shift_name} shift (${shift.role}, ${shift.start_time}–${shift.end_time}) on ${formatDisplayDate(shiftDate)}. ${candidateNote}Confirm? Reply "yes" to proceed or "no" to cancel.`
    );
  }
}

// Called from router pre-check when swap_pending:{employeeId} exists.
export async function handleSwapConfirmation(
  message: InboundMessage,
  contact: VerifiedContact,
  pending: PendingSwap & { _memory_id?: string }
): Promise<void> {
  const answer = parseYesNo(message.body);

  if (answer === 'unclear') {
    await reply(contact, message,
      'Please reply "yes" to confirm your swap request or "no" to cancel.'
    );
    return;
  }

  await clearPendingSwap(contact.company_id, contact.employee_id!);

  if (answer === 'no') {
    await reply(contact, message, 'Swap request cancelled. Let me know if you need anything else.');
    return;
  }

  // Employee confirmed — proceed
  const aegisSmsNumber = await getAegisSmsChannel(contact.company_id);

  if (pending.mode === 'directed') {
    if (!pending.target_employee_id || !pending.target_employee_name) {
      await reply(contact, message, 'Something went wrong — could not find the target employee. Please try again.');
      return;
    }

    const { data: receiverData } = await supabase.from('employees').select('*')
      .eq('id', pending.target_employee_id).single();
    const receiver = receiverData as Employee | null;

    if (!receiver || !receiver.contact_phone) {
      await reply(contact, message,
        `${pending.target_employee_name} doesn't have a phone number on file. Please contact them directly to arrange the swap.`
      );
      return;
    }

    if (!aegisSmsNumber) {
      await reply(contact, message,
        'No SMS channel is configured. Please contact the employee directly to arrange the swap.'
      );
      return;
    }

    const outreach: SwapOutreach = {
      mode: 'directed',
      company_id: contact.company_id,
      requester_id: contact.employee_id!,
      requester_name: contact.name,
      requester_channel: message.channel,
      requester_sender: message.sender,
      requester_recipient: message.recipient,
      requester_raw_subject: message.raw_subject,
      requester_thread_id: message.thread_id,
      receiver_id: receiver.id,
      receiver_phone: receiver.contact_phone,
      aegis_sms_channel: aegisSmsNumber,
      shift_date: pending.shift_date,
      shift_name: pending.shift_name,
      role: pending.role,
      shift_start: pending.shift_start,
      shift_end: pending.shift_end,
      schedule_id: pending.schedule_id,
      candidate_queue: [],
      outreach_sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    };
    await storeSwapOutreach(outreach);

    await sendSms({
      to: receiver.contact_phone,
      from: aegisSmsNumber,
      body:
        `Hi ${receiver.name.split(' ')[0]}, this is Aegis. ` +
        `${contact.name} would like to swap their ${pending.shift_name} shift (${pending.shift_start}–${pending.shift_end}, ${pending.role}) ` +
        `on ${formatDisplayDate(pending.shift_date)} with you. Can you take this shift? Reply YES or NO.`,
      company_id: contact.company_id,
    });

    await reply(contact, message,
      `I've messaged ${receiver.name} about the swap. I'll let you know when I hear back.`
    );

    await logActivity({
      company_id: contact.company_id,
      action: 'swap_outreach_sent',
      summary: `Outreach sent to ${receiver.name} for swap with ${contact.name} — ${pending.shift_name} on ${pending.shift_date}`,
      metadata: { requester_id: contact.employee_id, receiver_id: receiver.id, shift_date: pending.shift_date, mode: 'directed' },
    });
  } else {
    // Mode 2: facilitated
    const shiftHours = computeShiftHours(pending.shift_start, pending.shift_end);
    const candidates = await buildSwapCandidates({
      company_id: contact.company_id,
      requester_id: contact.employee_id!,
      shift_date: pending.shift_date,
      role: pending.role,
      shift_start: pending.shift_start,
      shift_end: pending.shift_end,
      shift_hours: shiftHours,
    });

    if (candidates.length === 0) {
      await reply(contact, message,
        `Unfortunately no qualified, available employees were found to cover your ${pending.shift_name} shift on ${formatDisplayDate(pending.shift_date)}. ` +
        'Please contact your manager directly.'
      );
      await logActivity({
        company_id: contact.company_id,
        action: 'swap_no_candidates',
        summary: `No swap candidates found for ${contact.name}'s ${pending.shift_name} on ${pending.shift_date}`,
        metadata: { requester_id: contact.employee_id, shift_date: pending.shift_date, role: pending.role },
      });
      return;
    }

    const firstCandidate = candidates[0];
    if (!firstCandidate.contact_phone || !aegisSmsNumber) {
      await reply(contact, message,
        `I found candidates but can't send SMS${!aegisSmsNumber ? ' — no SMS channel configured' : ` — ${firstCandidate.name} has no phone number`}. Please contact your manager for help.`
      );
      return;
    }

    const remaining = candidates.slice(1).map(c => c.id);
    const outreach: SwapOutreach = {
      mode: 'facilitated',
      company_id: contact.company_id,
      requester_id: contact.employee_id!,
      requester_name: contact.name,
      requester_channel: message.channel,
      requester_sender: message.sender,
      requester_recipient: message.recipient,
      requester_raw_subject: message.raw_subject,
      requester_thread_id: message.thread_id,
      receiver_id: firstCandidate.id,
      receiver_phone: firstCandidate.contact_phone,
      aegis_sms_channel: aegisSmsNumber,
      shift_date: pending.shift_date,
      shift_name: pending.shift_name,
      role: pending.role,
      shift_start: pending.shift_start,
      shift_end: pending.shift_end,
      schedule_id: pending.schedule_id,
      candidate_queue: remaining,
      outreach_sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    };
    await storeSwapOutreach(outreach);

    await sendSms({
      to: firstCandidate.contact_phone,
      from: aegisSmsNumber,
      body:
        `Hi ${firstCandidate.name.split(' ')[0]}, this is Aegis. ` +
        `${contact.name} is looking for someone to take their ${pending.shift_name} shift ` +
        `(${pending.shift_start}–${pending.shift_end}, ${pending.role}) on ${formatDisplayDate(pending.shift_date)}. ` +
        'Would you like to take this shift? Reply YES or NO.',
      company_id: contact.company_id,
    });

    await reply(contact, message,
      `I'm reaching out to ${candidates.length} available employee${candidates.length !== 1 ? 's' : ''}. I'll let you know as soon as someone accepts.`
    );

    await logActivity({
      company_id: contact.company_id,
      action: 'swap_outreach_sent',
      summary: `Facilitated swap outreach started for ${contact.name}'s ${pending.shift_name} on ${pending.shift_date} — contacting ${firstCandidate.name}`,
      metadata: { requester_id: contact.employee_id, first_candidate: firstCandidate.id, total_candidates: candidates.length, shift_date: pending.shift_date },
    });
  }
}

// Called from router pre-check when swap_outreach:{employeeId} exists.
export async function handleSwapOutreachResponse(
  message: InboundMessage,
  contact: VerifiedContact,
  outreach: SwapOutreach & { _memory_id?: string }
): Promise<void> {
  const answer = parseYesNo(message.body);

  if (answer === 'unclear') {
    await reply(contact, message,
      `Please reply "yes" to accept the ${outreach.shift_name} shift on ${formatShortDate(outreach.shift_date)} or "no" to decline.`
    );
    return;
  }

  const requesterMsg: InboundMessage = {
    sender: outreach.requester_sender, recipient: outreach.requester_recipient, body: '',
    channel: outreach.requester_channel, raw_subject: outreach.requester_raw_subject, thread_id: outreach.requester_thread_id,
  };
  const requesterContact: VerifiedContact = {
    role: 'employee', company_id: outreach.company_id, employee_id: outreach.requester_id,
    user_id: null, name: outreach.requester_name, matched_identifier: outreach.requester_sender, channel: outreach.requester_channel,
  };

  if (answer === 'no') {
    await clearSwapOutreach(outreach.company_id, outreach.receiver_id);
    await reply(contact, message, 'No problem — thanks for letting us know!');

    await logActivity({
      company_id: outreach.company_id,
      action: 'swap_declined',
      summary: `${contact.name} declined swap for ${outreach.requester_name}'s ${outreach.shift_name} on ${outreach.shift_date}`,
      metadata: { receiver_id: contact.employee_id, requester_id: outreach.requester_id, shift_date: outreach.shift_date },
    });

    if (outreach.mode === 'directed' || outreach.candidate_queue.length === 0) {
      await reply(requesterContact, requesterMsg,
        `${contact.name} wasn't able to take your ${outreach.shift_name} shift on ${formatShortDate(outreach.shift_date)}. ` +
        (outreach.mode === 'facilitated' && outreach.candidate_queue.length === 0
          ? 'All available employees have been contacted. Please speak with your manager.'
          : 'Please contact your manager for help finding coverage.')
      );
      return;
    }

    // Mode 2: try next candidate
    const { data: nextEmpData } = await supabase.from('employees').select('*')
      .eq('id', outreach.candidate_queue[0]).single();
    const nextEmp = nextEmpData as Employee | null;

    if (!nextEmp || !nextEmp.contact_phone) {
      await reply(requesterContact, requesterMsg,
        `${contact.name} wasn't available. The next candidate couldn't be reached. Please speak with your manager.`
      );
      return;
    }

    const nextOutreach: SwapOutreach = {
      ...outreach,
      receiver_id: nextEmp.id,
      receiver_phone: nextEmp.contact_phone,
      candidate_queue: outreach.candidate_queue.slice(1),
      outreach_sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    };
    await storeSwapOutreach(nextOutreach);

    await sendSms({
      to: nextEmp.contact_phone,
      from: outreach.aegis_sms_channel,
      body:
        `Hi ${nextEmp.name.split(' ')[0]}, this is Aegis. ` +
        `${outreach.requester_name} is looking for someone to take their ${outreach.shift_name} shift ` +
        `(${outreach.shift_start}–${outreach.shift_end}, ${outreach.role}) on ${formatDisplayDate(outreach.shift_date)}. ` +
        'Would you like to take this shift? Reply YES or NO.',
      company_id: outreach.company_id,
    });

    await reply(requesterContact, requesterMsg,
      `${contact.name} wasn't available. I'm now contacting ${nextEmp.name}.`
    );
    return;
  }

  // Employee said YES
  await clearSwapOutreach(outreach.company_id, outreach.receiver_id);

  const { data: receiverData } = await supabase.from('employees').select('*')
    .eq('id', outreach.receiver_id).single();
  const receiver = receiverData as Employee | null;

  const { data: requesterData } = await supabase.from('employees').select('*')
    .eq('id', outreach.requester_id).single();
  const requester = requesterData as Employee | null;

  if (!receiver || !requester) {
    await reply(contact, message, 'Something went wrong — please contact your manager directly.');
    return;
  }

  // Load swap policies to determine if manager approval is required
  const { data: policyData } = await supabase.from('policies').select('*')
    .eq('company_id', outreach.company_id).eq('policy_type', 'swaps');
  const policies = (policyData ?? []) as Policy[];

  // Ask Claude if manager approval is required
  let requiresApproval = false;
  if (policies.length > 0) {
    const policyText = policies.map(p => `${p.policy_key}: ${p.policy_value}${p.description ? ' — ' + p.description : ''}`).join('\n');
    const system = 'Based on these swap policies, does manager approval EXPLICITLY appear to be required before a swap is executed? Respond ONLY with valid JSON: {"requires_approval":true|false}';
    const text = await generateReply(system, policyText, []);
    try {
      const parsed = JSON.parse(text) as { requires_approval: boolean };
      requiresApproval = parsed.requires_approval;
    } catch {
      requiresApproval = false;
    }
  }

  await logActivity({
    company_id: outreach.company_id,
    action: 'swap_accepted',
    summary: `${contact.name} accepted swap for ${outreach.requester_name}'s ${outreach.shift_name} on ${outreach.shift_date}`,
    metadata: { receiver_id: contact.employee_id, requester_id: outreach.requester_id, shift_date: outreach.shift_date, requires_approval: requiresApproval },
  });

  if (!requiresApproval) {
    await reply(contact, message,
      `You're confirmed for the ${outreach.shift_name} shift (${outreach.shift_start}–${outreach.shift_end}) on ${formatDisplayDate(outreach.shift_date)}. Swap complete!`
    );
    await executeSwapNow({
      company_id: outreach.company_id,
      requester,
      requester_channel: outreach.requester_channel,
      requester_sender: outreach.requester_sender,
      requester_recipient: outreach.requester_recipient,
      requester_raw_subject: outreach.requester_raw_subject,
      requester_thread_id: outreach.requester_thread_id,
      receiver,
      shift_date: outreach.shift_date,
      shift_name: outreach.shift_name,
      role: outreach.role,
      shift_start: outreach.shift_start,
      shift_end: outreach.shift_end,
      schedule_id: outreach.schedule_id,
      aegis_sms_channel: outreach.aegis_sms_channel,
    });
  } else {
    // Create pending_manager swap_request
    const { data: swapRow } = await supabase.from('swap_requests').insert({
      company_id: outreach.company_id,
      requesting_employee_id: outreach.requester_id,
      receiving_employee_id: receiver.id,
      shift_date: outreach.shift_date,
      shift_name: outreach.shift_name,
      role: outreach.role,
      status: 'pending_manager',
      initiated_by: 'aegis',
      notes: `Both employees agreed via Aegis. ${outreach.mode === 'facilitated' ? 'Facilitated swap.' : 'Directed swap.'}`,
    }).select('id').single();

    const swapId = (swapRow as { id: string } | null)?.id ?? 'unknown';

    await reply(contact, message,
      `Thanks for accepting! The swap is pending manager approval. You'll be notified once a decision is made.`
    );
    await reply(requesterContact, requesterMsg,
      `${receiver.name} agreed to take your ${outreach.shift_name} shift on ${formatShortDate(outreach.shift_date)}. The swap is now pending manager approval — I'll notify you once it's decided.`
    );

    await sendManagerSwapApprovalRequest({
      company_id: outreach.company_id,
      swap_request_id: swapId,
      requester,
      requester_channel: outreach.requester_channel,
      requester_sender: outreach.requester_sender,
      receiver,
      shift_date: outreach.shift_date,
      shift_name: outreach.shift_name,
      role: outreach.role,
      shift_start: outreach.shift_start,
      shift_end: outreach.shift_end,
      aegis_sms_channel: outreach.aegis_sms_channel,
    });

    await logActivity({
      company_id: outreach.company_id,
      action: 'swap_pending_manager',
      entity_type: 'swap_request',
      entity_id: swapId,
      summary: `Swap between ${outreach.requester_name} and ${receiver.name} pending manager approval`,
      metadata: { requester_id: outreach.requester_id, receiver_id: receiver.id, shift_date: outreach.shift_date, shift_name: outreach.shift_name },
    });
  }
}

// Fallback: called from intent router when respond_swap_accept/decline is classified
// but no active outreach record exists for this employee.
export async function handleRespondSwap(
  message: InboundMessage,
  contact: VerifiedContact,
  _extracted: Record<string, unknown>,
  _decision: 'accept' | 'decline'
): Promise<void> {
  await reply(contact, message,
    "I don't have an active swap request pending for you. If you received a swap request from Aegis, please check your recent messages."
  );
}

// Redirect: manager sent SMS/email approval — tell them to use the email button
export async function handleApproveSwap(
  message: InboundMessage,
  contact: VerifiedContact,
  _extracted: Record<string, unknown>
): Promise<void> {
  await reply(contact, message,
    'To approve a swap, please use the Approve button in your Aegis notification email.'
  );
}

export async function handleDenySwap(
  message: InboundMessage,
  contact: VerifiedContact,
  _extracted: Record<string, unknown>
): Promise<void> {
  await reply(contact, message,
    'To deny a swap, please use the Deny button in your Aegis notification email.'
  );
}
