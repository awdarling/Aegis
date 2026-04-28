import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { reply } from '../messaging/reply';
import { sendEmail } from '../messaging/email';
import { sendSms } from '../messaging/sms';
import { generateReply } from '../ai/claude';
import { computeWageEstimate } from '../lib/schedule-simulator';
import { getSpecialNotesForRange } from './special-notes';
import type { InboundMessage, VerifiedContact } from '../security/types';
import type {
  Employee,
  Availability,
  TimeOffRequest,
  ShiftType,
  ShiftRequirement,
  EmployeeConflict,
  Policy,
  Event,
} from '../db/types';

// ── Output types ──────────────────────────────────────────────────────────────

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
  required_count: number;
  filled_count: number;
  reason: string;
}

interface ScheduleData {
  assignments: ScheduleAssignment[];
  gaps: ScheduleGap[];
  summary: string;
}

// ── Internal build data ───────────────────────────────────────────────────────

interface BuildData {
  employees: Employee[];
  availByEmp: Map<string, Availability[]>;
  approvedTOSet: Set<string>; // 'employeeId:date'
  shiftTypes: ShiftType[];
  shiftRequirements: ShiftRequirement[];
  conflicts: EmployeeConflict[];
  policies: Policy[];
  events: Event[];
  companyName: string;
  companyTimezone: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shiftHours(start: string, end: string): number {
  const toMins = (t: string) => { const [h, m] = t.slice(0, 5).split(':').map(Number); return h * 60 + m; };
  let mins = toMins(end) - toMins(start);
  if (mins < 0) mins += 24 * 60;
  return Math.round((mins / 60) * 10) / 10;
}

function getDatesInRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const cur = new Date(start + 'T12:00:00Z');
  const last = new Date(end + 'T12:00:00Z');
  while (cur <= last) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function getNextWeekBounds(today: string): { weekStart: string; weekEnd: string } {
  const d = new Date(today + 'T12:00:00Z');
  // Advance to the next Sunday (if today is Sunday, go to the following Sunday)
  const daysUntilSunday = d.getUTCDay() === 0 ? 7 : 7 - d.getUTCDay();
  const sunday = new Date(d);
  sunday.setUTCDate(d.getUTCDate() + daysUntilSunday);
  const saturday = new Date(sunday);
  saturday.setUTCDate(sunday.getUTCDate() + 6);
  return {
    weekStart: sunday.toISOString().slice(0, 10),
    weekEnd: saturday.toISOString().slice(0, 10),
  };
}

function parseTargetWeek(
  extracted: Record<string, unknown>,
  today: string
): { weekStart: string; weekEnd: string } {
  const raw = extracted['week_start'] as string | undefined;
  if (raw) {
    const d = new Date(raw + 'T12:00:00Z');
    const sun = new Date(d);
    sun.setUTCDate(d.getUTCDate() - d.getUTCDay());
    const sat = new Date(sun);
    sat.setUTCDate(sun.getUTCDate() + 6);
    return { weekStart: sun.toISOString().slice(0, 10), weekEnd: sat.toISOString().slice(0, 10) };
  }
  return getNextWeekBounds(today);
}

function isAvailableForShift(
  empId: string,
  dayOfWeek: number,
  shiftStart: string,
  shiftEnd: string,
  availByEmp: Map<string, Availability[]>
): boolean {
  const ns = shiftStart.slice(0, 5);
  const ne = shiftEnd.slice(0, 5);
  return (availByEmp.get(empId) ?? []).some(
    a => a.day_of_week === dayOfWeek && a.start_time.slice(0, 5) <= ns && a.end_time.slice(0, 5) >= ne
  );
}

function formatDisplayDate(d: string): string {
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function formatShortDate(d: string): string {
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatTime(t: string): string {
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadBuildData(
  companyId: string,
  weekStart: string,
  weekEnd: string
): Promise<BuildData> {
  const [
    companyRes, empRes, availRes, toRes,
    stRes, reqRes, conflictRes, polRes,
  ] = await Promise.all([
    supabase.from('companies').select('name, timezone').eq('id', companyId).single(),
    supabase.from('employees').select('*').eq('company_id', companyId).eq('active', true),
    supabase.from('availability').select('*').eq('company_id', companyId),
    supabase.from('time_off_requests').select('employee_id, start_date, end_date')
      .eq('company_id', companyId).eq('status', 'approved')
      .lte('start_date', weekEnd).gte('end_date', weekStart),
    supabase.from('shift_types').select('*').eq('company_id', companyId).eq('active', true),
    supabase.from('shift_requirements').select('*').eq('company_id', companyId),
    supabase.from('employee_conflicts').select('*').eq('company_id', companyId),
    supabase.from('policies').select('*').eq('company_id', companyId).in('policy_type', ['scheduling', 'coverage']),
  ]);

  const employees = (empRes.data ?? []) as Employee[];
  const availability = (availRes.data ?? []) as Availability[];

  const availByEmp = new Map<string, Availability[]>();
  for (const a of availability) {
    if (!availByEmp.has(a.employee_id)) availByEmp.set(a.employee_id, []);
    availByEmp.get(a.employee_id)!.push(a);
  }

  // Build TO set: 'employeeId:date'
  const approvedTOSet = new Set<string>();
  const weekDates = getDatesInRange(weekStart, weekEnd);
  for (const tor of (toRes.data ?? []) as { employee_id: string; start_date: string; end_date: string }[]) {
    for (const date of weekDates) {
      if (date >= tor.start_date && date <= tor.end_date) {
        approvedTOSet.add(`${tor.employee_id}:${date}`);
      }
    }
  }

  const company = (companyRes.data as { name: string; timezone: string } | null);

  return {
    employees,
    availByEmp,
    approvedTOSet,
    shiftTypes: (stRes.data ?? []) as ShiftType[],
    shiftRequirements: (reqRes.data ?? []) as ShiftRequirement[],
    conflicts: (conflictRes.data ?? []) as EmployeeConflict[],
    policies: (polRes.data ?? []) as Policy[],
    events: [],
    companyName: company?.name ?? 'Your Company',
    companyTimezone: company?.timezone ?? 'America/New_York',
  };
}

// ── Shift override from special notes ─────────────────────────────────────────

function applyShiftOverrides(
  requirements: ShiftRequirement[],
  dateNotes: Event[],
  shiftTypeName: string
): ShiftRequirement[] {
  for (const note of dateNotes) {
    if (!note.shift_overrides) continue;
    const overrides = note.shift_overrides as Record<string, Record<string, number>>;
    const forShift = overrides[shiftTypeName];
    if (!forShift) continue;
    return requirements.map(req => {
      const count = forShift[req.role];
      return count !== undefined ? { ...req, required_count: count } : req;
    });
  }
  return requirements;
}

// ── Core assignment logic ─────────────────────────────────────────────────────

function computeGapReason(params: {
  role: string;
  date: string;
  dayOfWeek: number;
  shiftStart: string;
  shiftEnd: string;
  shiftHours: number;
  employees: Employee[];
  availByEmp: Map<string, Availability[]>;
  approvedTOSet: Set<string>;
  weeklyHoursMap: Map<string, number>;
  assignedToShift: string[];
  conflicts: EmployeeConflict[];
}): string {
  const { role, date, dayOfWeek, shiftStart, shiftEnd, shiftHours, employees } = params;

  const qualified = employees.filter(e => e.qualified_roles.includes(role));
  if (qualified.length === 0) return `No active employees are qualified for the ${role} role`;

  const available = qualified.filter(e =>
    isAvailableForShift(e.id, dayOfWeek, shiftStart, shiftEnd, params.availByEmp)
  );
  if (available.length === 0) return `No qualified ${role} employees have availability on ${new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' })}`;

  const notOnTO = available.filter(e => !params.approvedTOSet.has(`${e.id}:${date}`));
  if (notOnTO.length === 0) return `All available ${role} employees have approved time off on ${formatShortDate(date)}`;

  const withinHours = notOnTO.filter(e =>
    (params.weeklyHoursMap.get(e.id) ?? 0) + shiftHours <= e.max_weekly_hours
  );
  if (withinHours.length === 0) return `All available ${role} employees have reached their maximum weekly hours`;

  // Check for never-conflict exclusions
  const neverExcluded = new Set<string>();
  for (const assignedId of params.assignedToShift) {
    for (const c of params.conflicts) {
      if (c.severity !== 'never') continue;
      const otherId = c.employee_id_1 === assignedId ? c.employee_id_2 : c.employee_id_1 === assignedId ? c.employee_id_2 : null;
      if (otherId) neverExcluded.add(otherId);
    }
  }
  const noConflict = withinHours.filter(e => !neverExcluded.has(e.id));
  if (noConflict.length === 0) return `All available ${role} employees have scheduling conflicts with already-assigned staff`;

  return `No available ${role} employee could be assigned`;
}

function findBestEmployee(params: {
  role: string;
  date: string;
  dayOfWeek: number;
  shiftStart: string;
  shiftEnd: string;
  shiftHours: number;
  employees: Employee[];
  availByEmp: Map<string, Availability[]>;
  approvedTOSet: Set<string>;
  weeklyHoursMap: Map<string, number>;
  assignedToShift: string[];
  conflicts: EmployeeConflict[];
}): Employee | null {
  const { role, date, dayOfWeek, shiftStart, shiftEnd, shiftHours } = params;

  // Build conflict sets from already-assigned employees on this shift
  const neverExcluded = new Set<string>();
  const avoidDeprioritized = new Set<string>();
  for (const assignedId of params.assignedToShift) {
    for (const c of params.conflicts) {
      let otherId: string | null = null;
      if (c.employee_id_1 === assignedId) otherId = c.employee_id_2;
      else if (c.employee_id_2 === assignedId) otherId = c.employee_id_1;
      if (!otherId) continue;
      if (c.severity === 'never') neverExcluded.add(otherId);
      else avoidDeprioritized.add(otherId);
    }
  }

  const candidates = params.employees.filter(e => {
    if (!e.qualified_roles.includes(role)) return false;
    if (params.assignedToShift.includes(e.id)) return false;
    if (neverExcluded.has(e.id)) return false;
    if (params.approvedTOSet.has(`${e.id}:${date}`)) return false;
    if (!isAvailableForShift(e.id, dayOfWeek, shiftStart, shiftEnd, params.availByEmp)) return false;
    if ((params.weeklyHoursMap.get(e.id) ?? 0) + shiftHours > e.max_weekly_hours) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  // Sort: avoid-conflict employees last, then fewest hours, then alphabetically
  candidates.sort((a, b) => {
    const aAvoid = avoidDeprioritized.has(a.id) ? 1 : 0;
    const bAvoid = avoidDeprioritized.has(b.id) ? 1 : 0;
    if (aAvoid !== bAvoid) return aAvoid - bAvoid;
    const ha = params.weeklyHoursMap.get(a.id) ?? 0;
    const hb = params.weeklyHoursMap.get(b.id) ?? 0;
    return ha !== hb ? ha - hb : a.name.localeCompare(b.name);
  });

  return candidates[0];
}

// ── Main scheduling algorithm ─────────────────────────────────────────────────

function buildScheduleForWeek(
  data: BuildData,
  weekDates: string[],
  eventsByDate: Map<string, Event[]>
): { assignments: ScheduleAssignment[]; gaps: ScheduleGap[]; totalRequired: number; totalFilled: number } {
  const assignments: ScheduleAssignment[] = [];
  const gaps: ScheduleGap[] = [];
  const weeklyHoursMap = new Map<string, number>();
  let totalRequired = 0;
  let totalFilled = 0;

  for (const date of weekDates) {
    const dayOfWeek = new Date(date + 'T12:00:00Z').getUTCDay();
    const dateNotes = eventsByDate.get(date) ?? [];

    // Sort shift types by start time for consistent ordering
    const activeShiftTypes = data.shiftTypes
      .filter(st => st.days_active.includes(dayOfWeek))
      .sort((a, b) => a.start_time.localeCompare(b.start_time));

    for (const shiftType of activeShiftTypes) {
      const baseReqs = data.shiftRequirements.filter(req =>
        (req.shift_type_id ? req.shift_type_id === shiftType.id : req.shift_name === shiftType.name) &&
        req.days_active.includes(dayOfWeek)
      );

      const reqs = applyShiftOverrides(baseReqs, dateNotes, shiftType.name);
      const hours = shiftHours(shiftType.start_time, shiftType.end_time);

      for (const req of reqs) {
        if (req.required_count === 0) continue;
        const assignedToShift: string[] = [];
        let filledInReq = 0;

        for (let slot = 0; slot < req.required_count; slot++) {
          totalRequired++;
          const emp = findBestEmployee({
            role: req.role,
            date,
            dayOfWeek,
            shiftStart: shiftType.start_time,
            shiftEnd: shiftType.end_time,
            shiftHours: hours,
            employees: data.employees,
            availByEmp: data.availByEmp,
            approvedTOSet: data.approvedTOSet,
            weeklyHoursMap,
            assignedToShift,
            conflicts: data.conflicts,
          });

          if (emp) {
            totalFilled++;
            filledInReq++;
            assignedToShift.push(emp.id);
            weeklyHoursMap.set(emp.id, (weeklyHoursMap.get(emp.id) ?? 0) + hours);
            assignments.push({
              date,
              employee_id: emp.id,
              employee_name: emp.name,
              shift_name: shiftType.name,
              role: req.role,
              start_time: shiftType.start_time,
              end_time: shiftType.end_time,
              hours,
            });
          } else {
            gaps.push({
              date,
              shift_name: shiftType.name,
              role: req.role,
              required_count: req.required_count,
              filled_count: filledInReq,
              reason: computeGapReason({
                role: req.role,
                date,
                dayOfWeek,
                shiftStart: shiftType.start_time,
                shiftEnd: shiftType.end_time,
                shiftHours: hours,
                employees: data.employees,
                availByEmp: data.availByEmp,
                approvedTOSet: data.approvedTOSet,
                weeklyHoursMap,
                assignedToShift,
                conflicts: data.conflicts,
              }),
            });
            // Remaining slots in this req will have the same problem — count them as required but unfilled
            totalRequired += req.required_count - slot - 1;
            break;
          }
        }
      }
    }
  }

  return { assignments, gaps, totalRequired, totalFilled };
}

// ── Staffing report ───────────────────────────────────────────────────────────

function buildStaffingReport(
  assignments: ScheduleAssignment[],
  gaps: ScheduleGap[],
  totalRequired: number,
  totalFilled: number,
  employees: Employee[],
  specialNotes: Event[]
): Record<string, unknown> {
  const coverage_rate = totalRequired > 0 ? Math.round((totalFilled / totalRequired) * 1000) / 10 : 100;

  // Weekly hours per employee
  const hoursMap = new Map<string, number>();
  for (const a of assignments) {
    hoursMap.set(a.employee_id, (hoursMap.get(a.employee_id) ?? 0) + a.hours);
  }

  const top_contributors = Array.from(hoursMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, hours]) => ({
      employee_id: id,
      name: employees.find(e => e.id === id)?.name ?? id,
      hours,
    }));

  const overtime_risk = Array.from(hoursMap.entries())
    .filter(([id, hours]) => {
      const emp = employees.find(e => e.id === id);
      return emp && hours >= emp.max_weekly_hours - 4;
    })
    .map(([id, hours]) => {
      const emp = employees.find(e => e.id === id)!;
      return { employee_id: id, name: emp.name, hours, max_hours: emp.max_weekly_hours };
    });

  const gap_summary = gaps.length === 0
    ? 'All shifts fully covered.'
    : gaps.map(g => `${formatShortDate(g.date)} ${g.shift_name} — ${g.role} (${g.filled_count}/${g.required_count} filled): ${g.reason}`).join('\n');

  const special_notes_applied = specialNotes
    .filter(n => n.staffing_notes || n.shift_overrides)
    .map(n => n.title);

  return {
    coverage_rate,
    top_contributors,
    overtime_risk,
    gap_summary,
    special_notes_applied,
    aegis_notes: overtime_risk.length > 0
      ? `${overtime_risk.length} employee(s) are near or at maximum weekly hours.`
      : '',
  };
}

// ── Manager summary message ───────────────────────────────────────────────────

async function buildManagerSummary(
  weekStart: string,
  weekEnd: string,
  assignments: ScheduleAssignment[],
  gaps: ScheduleGap[],
  totalFilled: number,
  totalRequired: number,
  specialNotes: Event[],
  companyName: string,
  estimatedWages: { total_estimated: number }
): Promise<string> {
  const coverageRate = totalRequired > 0 ? Math.round((totalFilled / totalRequired) * 1000) / 10 : 100;
  const weekLabel = `${formatShortDate(weekStart)}–${formatShortDate(weekEnd)}`;

  // Top 3 contributors
  const hoursMap = new Map<string, { name: string; hours: number }>();
  for (const a of assignments) {
    if (!hoursMap.has(a.employee_id)) hoursMap.set(a.employee_id, { name: a.employee_name, hours: 0 });
    hoursMap.get(a.employee_id)!.hours += a.hours;
  }
  const top3 = Array.from(hoursMap.values()).sort((a, b) => b.hours - a.hours).slice(0, 3);

  const lines: string[] = [
    `Schedule built for ${weekLabel}.`,
    '',
    `Coverage: ${coverageRate}% (${totalFilled}/${totalRequired} slots filled)`,
  ];

  if (gaps.length > 0) {
    lines.push(`Gaps: ${gaps.length} unfilled slot(s)`);
    const uniqueGaps = gaps.slice(0, 4);
    for (const g of uniqueGaps) {
      lines.push(`  • ${new Date(g.date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} — ${g.shift_name} ${g.role}: ${g.reason.split('.')[0]}`);
    }
    if (gaps.length > 4) lines.push(`  • ... and ${gaps.length - 4} more`);
  } else {
    lines.push('All shifts fully covered.');
  }

  if (top3.length > 0) {
    lines.push(`Top contributors: ${top3.map(e => `${e.name} (${e.hours}h)`).join(', ')}`);
  }

  lines.push(`Estimated labor: $${estimatedWages.total_estimated.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`);

  if (specialNotes.length > 0) {
    const applied = specialNotes.filter(n => n.staffing_notes || n.shift_overrides);
    if (applied.length > 0) {
      lines.push(`Notes applied: ${applied.map(n => n.title).join(', ')}`);
    }
  }

  lines.push('');
  lines.push("Review the schedule in Homebase. Once you approve it I'll distribute it to the team.");

  return lines.join('\n');
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleBuildSchedule(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const { weekStart, weekEnd } = parseTargetWeek(extracted, today);
  const weekDates = getDatesInRange(weekStart, weekEnd);

  // Load all required data
  const [data, specialNotes] = await Promise.all([
    loadBuildData(contact.company_id, weekStart, weekEnd),
    getSpecialNotesForRange(contact.company_id, weekStart, weekEnd),
  ]);
  data.events = specialNotes;

  // Validate: need shift types to proceed
  if (data.shiftTypes.length === 0) {
    await reply(contact, message,
      `No active shift types are configured for this company. Before Aegis can build a schedule, set up shift types in Homebase under Scheduling → Shift Types, then define shift requirements (which roles are needed for each shift type and on which days).`
    );
    return;
  }

  // Build event-by-date index
  const eventsByDate = new Map<string, Event[]>();
  for (const date of weekDates) {
    eventsByDate.set(date, specialNotes.filter(e =>
      (e.date ?? '') <= date && (e.end_date ?? e.date ?? '') >= date
    ));
  }

  // Run scheduling algorithm
  const { assignments, gaps, totalRequired, totalFilled } = buildScheduleForWeek(data, weekDates, eventsByDate);

  // Compute wages
  const wages = await computeWageEstimate(contact.company_id, assignments);

  // Build staffing report
  const staffingReport = {
    ...buildStaffingReport(assignments, gaps, totalRequired, totalFilled, data.employees, specialNotes),
    estimated_wages: wages,
  };

  // Generate plain-language summary for schedule.data.summary
  const summaryPrompt =
    `You are Aegis, building a schedule for ${data.companyName}. Write a concise 2-3 sentence summary of this week's schedule (${weekStart} to ${weekEnd}). ` +
    `Coverage: ${totalFilled}/${totalRequired} slots filled. Gaps: ${gaps.length}. ` +
    `Top contributors: ${Array.from(new Map(assignments.map(a => [a.employee_id, { name: a.employee_name, hours: 0 }])).values()).slice(0, 3).map(e => e.name).join(', ')}. ` +
    `Be direct and operational. No preamble.`;
  const summary = await generateReply(summaryPrompt, 'Summarize the schedule.', []);

  // Save schedule record to Homebase
  const { data: schedRow, error: schedError } = await supabase
    .from('schedules')
    .insert({
      company_id: contact.company_id,
      week_start: weekStart,
      week_end: weekEnd,
      generated_at: new Date().toISOString(),
      generated_by: 'aegis',
      status: 'draft',
      data: { assignments, gaps, summary } as unknown as Record<string, unknown>,
      staffing_report: staffingReport as unknown as Record<string, unknown>,
    })
    .select('id')
    .single();

  const scheduleId = (schedRow as { id: string } | null)?.id ?? 'unknown';

  if (schedError) {
    console.error('[schedule-build] save failed:', schedError.message);
  }

  // Log to activity_log
  await logActivity({
    company_id: contact.company_id,
    action: 'schedule_built',
    entity_type: 'schedule',
    entity_id: scheduleId,
    summary: `Schedule built for ${weekStart}–${weekEnd}: ${totalFilled}/${totalRequired} slots filled (${gaps.length} gaps)`,
    metadata: {
      week_start: weekStart,
      week_end: weekEnd,
      total_filled: totalFilled,
      total_required: totalRequired,
      gaps: gaps.length,
      estimated_wages: wages.total_estimated,
      special_notes_count: specialNotes.length,
    },
  });

  // Reply to manager
  const summaryMsg = await buildManagerSummary(
    weekStart, weekEnd, assignments, gaps, totalFilled, totalRequired,
    specialNotes, data.companyName, wages
  );

  await reply(contact, message, summaryMsg);
}

// ── Distribute handler ────────────────────────────────────────────────────────

export async function handleDistributeSchedule(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);

  // Find the most recent schedule (prefer published, fall back to draft)
  type ScheduleRow = { id: string; week_start: string; week_end: string; data: ScheduleData; status: string };
  let scheduleRow: ScheduleRow | null = null;

  const { data: pubData } = await supabase
    .from('schedules').select('id, week_start, week_end, data, status')
    .eq('company_id', contact.company_id).eq('status', 'published')
    .order('generated_at', { ascending: false }).limit(1).maybeSingle();

  if (pubData) {
    scheduleRow = pubData as unknown as ScheduleRow;
  } else {
    const { data: draftData } = await supabase
      .from('schedules').select('id, week_start, week_end, data, status')
      .eq('company_id', contact.company_id).eq('status', 'draft')
      .order('generated_at', { ascending: false }).limit(1).maybeSingle();
    if (draftData) scheduleRow = draftData as unknown as ScheduleRow;
  }

  if (!scheduleRow) {
    await reply(contact, message,
      "No schedule found to distribute. Ask Aegis to build a schedule first."
    );
    return;
  }

  const schedData = scheduleRow.data as unknown as ScheduleData;
  const weekLabel = `${formatShortDate(scheduleRow.week_start)}–${formatShortDate(scheduleRow.week_end)}`;

  // Load company name and Aegis SMS channel
  const [companyRes, channelRes, empRes] = await Promise.all([
    supabase.from('companies').select('name').eq('id', contact.company_id).single(),
    supabase.from('company_channels').select('channel_value').eq('company_id', contact.company_id).eq('channel_type', 'sms').maybeSingle(),
    supabase.from('employees').select('id, name, contact_email, contact_phone').eq('company_id', contact.company_id).eq('active', true),
  ]);

  const companyName = (companyRes.data as { name: string } | null)?.name ?? 'Your Company';
  const aegisSmsChannel = (channelRes.data as { channel_value: string } | null)?.channel_value ?? null;
  const employees = (empRes.data ?? []) as Pick<Employee, 'id' | 'name' | 'contact_email' | 'contact_phone'>[];

  let emailed = 0;
  let texted = 0;
  const noContact: string[] = [];

  for (const emp of employees) {
    const myShifts = schedData.assignments.filter(a => a.employee_id === emp.id)
      .sort((a, b) => a.date.localeCompare(b.date));

    const hasShifts = myShifts.length > 0;
    const totalHours = myShifts.reduce((s, a) => s + a.hours, 0);

    // Build email content
    if (emp.contact_email) {
      const shiftRows = hasShifts
        ? myShifts.map(s =>
            `<tr><td style="padding:6px 12px;border:1px solid #e5e7eb;">${formatDisplayDate(s.date)}</td>` +
            `<td style="padding:6px 12px;border:1px solid #e5e7eb;">${s.shift_name}</td>` +
            `<td style="padding:6px 12px;border:1px solid #e5e7eb;">${s.role}</td>` +
            `<td style="padding:6px 12px;border:1px solid #e5e7eb;">${formatTime(s.start_time)}–${formatTime(s.end_time)}</td>` +
            `<td style="padding:6px 12px;border:1px solid #e5e7eb;">${s.hours}h</td></tr>`
          ).join('')
        : `<tr><td colspan="5" style="padding:12px;text-align:center;color:#6b7280;">You are not scheduled this week.</td></tr>`;

      const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
<h2 style="margin:0 0 4px;">Your Schedule — ${weekLabel}</h2>
<p style="color:#6b7280;margin:0 0 20px;">Hi ${emp.name.split(' ')[0]},</p>
<table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
<thead><tr style="background:#f9fafb;">
<th style="padding:8px 12px;border:1px solid #e5e7eb;text-align:left;">Date</th>
<th style="padding:8px 12px;border:1px solid #e5e7eb;text-align:left;">Shift</th>
<th style="padding:8px 12px;border:1px solid #e5e7eb;text-align:left;">Role</th>
<th style="padding:8px 12px;border:1px solid #e5e7eb;text-align:left;">Time</th>
<th style="padding:8px 12px;border:1px solid #e5e7eb;text-align:left;">Hours</th>
</tr></thead>
<tbody>${shiftRows}</tbody>
</table>
${hasShifts ? `<p style="color:#374151;">Total: <strong>${totalHours}h</strong> this week</p>` : ''}
<p style="color:#6b7280;font-size:13px;">Questions? Contact your manager directly.</p>
<p style="color:#9ca3af;font-size:12px;">— ${companyName}</p>
</body></html>`;

      const text = hasShifts
        ? `Hi ${emp.name.split(' ')[0]},\n\nYour schedule for ${weekLabel}:\n\n` +
          myShifts.map(s => `${formatDisplayDate(s.date)}: ${s.shift_name} (${formatTime(s.start_time)}–${formatTime(s.end_time)}, ${s.role})`).join('\n') +
          `\n\nTotal: ${totalHours}h\n\nQuestions? Contact your manager.`
        : `Hi ${emp.name.split(' ')[0]},\n\nYou are not scheduled for the week of ${weekLabel}.\n\n— ${companyName}`;

      await sendEmail({
        to: emp.contact_email,
        subject: `${companyName} — Your Schedule ${weekLabel}`,
        text,
        html,
        company_id: contact.company_id,
      });
      emailed++;
    }

    // SMS notification
    if (emp.contact_phone && aegisSmsChannel) {
      const smsBody = emp.contact_email
        ? `${companyName}: Your schedule for ${weekLabel} has been posted. Check your email for details.`
        : hasShifts
          ? `${companyName} schedule ${weekLabel}: ${myShifts.slice(0, 3).map(s => `${new Date(s.date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short' })} ${s.shift_name}`).join(', ')}${myShifts.length > 3 ? ` +${myShifts.length - 3} more` : ''}`
          : `${companyName}: No shifts scheduled for ${weekLabel}.`;

      await sendSms({ to: emp.contact_phone, from: aegisSmsChannel, body: smsBody, company_id: contact.company_id });
      texted++;
    }

    if (!emp.contact_email && !emp.contact_phone) {
      noContact.push(emp.name);
    }
  }

  // Mark schedule as published and set distributed_at
  await supabase.from('schedules').update({
    status: 'published',
    distributed_at: new Date().toISOString(),
  }).eq('id', scheduleRow.id);

  // Log warnings for employees with no contact info
  if (noContact.length > 0) {
    await logActivity({
      company_id: contact.company_id,
      action: 'schedule_distribute_partial',
      entity_type: 'schedule',
      entity_id: scheduleRow.id,
      summary: `Schedule distributed — ${noContact.length} employee(s) could not be notified (no contact info)`,
      metadata: { employees_missing_contact: noContact },
    });
  }

  await logActivity({
    company_id: contact.company_id,
    action: 'schedule_distributed',
    entity_type: 'schedule',
    entity_id: scheduleRow.id,
    summary: `Schedule for ${weekLabel} distributed — ${emailed} emails, ${texted} texts sent`,
    metadata: { week: weekLabel, emailed, texted, no_contact: noContact },
  });

  const lines = [`Schedule for ${weekLabel} has been sent.`];
  lines.push(`${emailed} employee${emailed !== 1 ? 's' : ''} emailed, ${texted} notified by SMS.`);
  if (noContact.length > 0) {
    lines.push(`⚠ Could not notify ${noContact.length} employee${noContact.length !== 1 ? 's' : ''} (no contact info on file): ${noContact.join(', ')}`);
  }

  await reply(contact, message, lines.join('\n'));
}
