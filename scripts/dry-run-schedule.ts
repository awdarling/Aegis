/**
 * One-off engine dry-run.
 *
 * Loads live Watermark data, runs the schedule engine in-memory, and writes
 * the result to a local JSON file. No database writes, no SMS sends.
 *
 * The orchestration loop lives in src/workflows/schedule-build.ts as
 * runScheduleBuild — this script does NOT mirror the engine. Data loading
 * still happens here (script responsibility); engine work goes through the
 * same code path production uses.
 *
 * Run: npx ts-node scripts/dry-run-schedule.ts
 */

import * as fs from 'fs';
import { supabase } from '../src/db/client';
import { parseConstraints } from '../src/lib/constraints/parser';
import type { EngineSettings } from '../src/lib/constraints/types';
import { getWeekBounds } from '../src/lib/engine/week-bounds';
import type { VeteranOnlyRange } from '../src/lib/engine/eligibility';
import { resolveAvailabilityForWeek } from '../src/lib/custom-availability';
import { buildTOMap, type TOWindow } from '../src/lib/to-window';
import { getSpecialNotesForRange } from '../src/workflows/special-notes';
import { computeWageEstimate } from '../src/lib/schedule-simulator';
import {
  ENGINE_VERSION,
  runScheduleBuild,
  type BuildData,
  type ScheduleAssignment,
  type VeteranMode,
} from '../src/workflows/schedule-build';
import type {
  Employee,
  Availability,
  CustomAvailability,
  PartialDayDetail,
  ShiftType,
  ShiftRequirement,
  EmployeeConflict,
  Policy,
} from '../src/db/types';

// ── Hardcoded inputs ─────────────────────────────────────────────────────────

const COMPANY_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const TARGET_WEEK: 'this' | 'next' = 'next';
const OUTPUT_FILE = './dry-run-output.json';

// ── Small local helpers (script-only) ────────────────────────────────────────

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

function parseTargetWeek(
  target: 'this' | 'next',
  settings: EngineSettings
): { weekStart: string; weekEnd: string } {
  return getWeekBounds(target === 'this' ? 0 : 1, settings.weekStartDay);
}

function formatWeekday(d: string): string {
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' });
}

// ── Data load (script responsibility — separate from engine) ─────────────────

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
    supabase.from('time_off_requests')
      .select('employee_id, start_date, end_date, time_off_type, partial_days')
      .eq('company_id', companyId).eq('status', 'approved')
      .lte('start_date', weekEnd).gte('end_date', weekStart),
    supabase.from('shift_types').select('*').eq('company_id', companyId).eq('active', true),
    supabase.from('shift_requirements').select('*').eq('company_id', companyId),
    supabase.from('employee_conflicts').select('*').eq('company_id', companyId),
    supabase.from('policies').select('*').eq('company_id', companyId),
  ]);

  const employees = (empRes.data ?? []) as Employee[];
  const availability = (availRes.data ?? []) as Availability[];

  const availByEmp = new Map<string, Availability[]>();
  for (const a of availability) {
    if (!availByEmp.has(a.employee_id)) availByEmp.set(a.employee_id, []);
    availByEmp.get(a.employee_id)!.push(a);
  }

  const weekDates = getDatesInRange(weekStart, weekEnd);
  const toRows = (toRes.data ?? []) as Array<{
    employee_id: string;
    start_date: string;
    end_date: string;
    time_off_type: 'full_day' | 'partial' | null;
    partial_days: PartialDayDetail[] | null;
  }>;
  const toMap: Map<string, TOWindow> = buildTOMap(weekDates, toRows);

  const company = companyRes.data as { name: string; timezone: string } | null;

  return {
    employees,
    availByEmp,
    toMap,
    shiftTypes: (stRes.data ?? []) as ShiftType[],
    shiftRequirements: (reqRes.data ?? []) as ShiftRequirement[],
    conflicts: (conflictRes.data ?? []) as EmployeeConflict[],
    policies: (polRes.data ?? []) as Policy[],
    events: [],
    companyName: company?.name ?? 'Your Company',
    companyTimezone: company?.timezone ?? 'America/New_York',
  };
}

// ── Main dry-run flow ────────────────────────────────────────────────────────

async function dryRun(): Promise<void> {
  console.log('[dry-run] Loading policies...');
  const { data: policyRows } = await supabase
    .from('policies')
    .select('*')
    .eq('company_id', COMPANY_ID);
  const parsedEarly = parseConstraints((policyRows ?? []) as Policy[]);
  console.log('[dry-run] Parsed settings:', parsedEarly.settings);

  const { weekStart, weekEnd } = parseTargetWeek(TARGET_WEEK, parsedEarly.settings);
  console.log(`[dry-run] Target week: ${weekStart} to ${weekEnd}`);
  const weekDates = getDatesInRange(weekStart, weekEnd);

  const [data, specialNotes] = await Promise.all([
    loadBuildData(COMPANY_ID, weekStart, weekEnd),
    getSpecialNotesForRange(COMPANY_ID, weekStart, weekEnd),
  ]);
  data.events = specialNotes;

  const parsed = parseConstraints(data.policies);
  console.log(
    `[dry-run] Loaded ${data.employees.length} employees, ${data.shiftTypes.length} shift types, ${data.shiftRequirements.length} shift requirements`
  );
  console.log(
    `[dry-run] attribute_mix rules: ${parsed.hard.attributeMix.length}, unrecognized policies: ${parsed.unrecognized.length}`
  );

  const { data: customAvailData } = await supabase
    .from('custom_availability')
    .select('*')
    .eq('company_id', COMPANY_ID)
    .eq('active', true)
    .order('created_at', { ascending: false });

  const customAvailByEmployee: Record<string, CustomAvailability> = {};
  for (const row of (customAvailData ?? []) as CustomAvailability[]) {
    if (!customAvailByEmployee[row.employee_id]) {
      customAvailByEmployee[row.employee_id] = row;
    }
  }

  let customApplied = 0;
  for (const emp of data.employees) {
    const custom = customAvailByEmployee[emp.id] ?? null;
    if (!custom) continue;
    const normal = data.availByEmp.get(emp.id) ?? [];
    const resolved = resolveAvailabilityForWeek(emp, weekStart, weekEnd, normal, custom);
    if (resolved !== normal) {
      data.availByEmp.set(emp.id, resolved);
      customApplied++;
    }
  }
  console.log(`[dry-run] Custom availability applied to ${customApplied} employees`);

  if (data.shiftTypes.length === 0) {
    console.error('[dry-run] No active shift types configured for this company. Aborting.');
    process.exit(1);
  }

  const veteranMode: VeteranMode = parsed.settings.veteranPreferenceDefault === 'none'
    ? null
    : (parsed.settings.veteranPreferenceDefault as VeteranMode);
  const veteranOnlyDates: VeteranOnlyRange[] = [];

  console.log('[dry-run] Running engine...');
  const { assignments, gaps, flagged_issues, closed_dates, totalRequired, totalFilled } = runScheduleBuild(
    data,
    parsed.settings,
    veteranMode,
    veteranOnlyDates,
    weekStart,
    weekEnd,
  );
  console.log(`[dry-run] Assignments: ${totalFilled} / ${totalRequired} filled, ${gaps.length} gaps, ${flagged_issues.length} flagged issues, ${closed_dates.length} closed dates`);

  const wages = await computeWageEstimate(COMPANY_ID, assignments);

  // ── Build the structured output ────────────────────────────────────────────
  const coverageRate = totalRequired > 0
    ? Math.round((totalFilled / totalRequired) * 1000) / 10
    : 100;

  // Group assignments by day, sorted by start_time then role
  const assignmentsByDay: Record<string, ScheduleAssignment[]> = {};
  for (const date of weekDates) {
    const dayAssignments = assignments
      .filter(a => a.date === date)
      .sort((a, b) => {
        if (a.start_time !== b.start_time) return a.start_time < b.start_time ? -1 : 1;
        if (a.role !== b.role) return a.role < b.role ? -1 : 1;
        return a.employee_name.localeCompare(b.employee_name);
      });
    const key = `${formatWeekday(date)} ${date}`;
    assignmentsByDay[key] = dayAssignments;
  }

  // Weekly hours by employee
  const hoursMap = new Map<string, number>();
  for (const a of assignments) {
    hoursMap.set(a.employee_id, (hoursMap.get(a.employee_id) ?? 0) + a.hours);
  }
  const weeklyHoursByEmployee = data.employees
    .map(emp => {
      const hours = hoursMap.get(emp.id) ?? 0;
      const percent = emp.max_weekly_hours > 0
        ? Math.round((hours / emp.max_weekly_hours) * 1000) / 10
        : 0;
      return {
        employee_id: emp.id,
        name: emp.name,
        primary_role: emp.primary_role,
        hours_assigned: Math.round(hours * 10) / 10,
        max_hours: emp.max_weekly_hours,
        percent_of_max: percent,
      };
    })
    .sort((a, b) => b.hours_assigned - a.hours_assigned);

  const top5ByPay = [...wages.by_employee]
    .sort((a, b) => b.estimated_pay - a.estimated_pay)
    .slice(0, 5);

  const approvedTOOverlapping = Array.from(data.toMap.keys()).length;

  const output = {
    metadata: {
      engine_version: ENGINE_VERSION,
      company_id: COMPANY_ID,
      company_name: data.companyName,
      target_week: TARGET_WEEK,
      week_start: weekStart,
      week_end: weekEnd,
      week_start_day_setting: parsed.settings.weekStartDay,
      generated_at: new Date().toISOString(),
      ran_against: 'live Watermark data — no writes performed',
    },
    settings_in_effect: {
      hoursFairnessWeight: parsed.settings.hoursFairnessWeight,
      partialShiftsAllowed: parsed.settings.partialShiftsAllowed,
      veteranPreferenceDefault: parsed.settings.veteranPreferenceDefault,
      doublesPolicy: parsed.settings.doublesPolicy,
      conflictResolution: parsed.settings.conflictResolution,
      weekStartDay: parsed.settings.weekStartDay,
    },
    constraints_parsed: {
      attribute_mix_count: parsed.hard.attributeMix.length,
      unrecognized_policy_count: parsed.unrecognized.length,
      unrecognized_details: parsed.unrecognized,
    },
    input_summary: {
      active_employees: data.employees.length,
      shift_types_active: data.shiftTypes.length,
      shift_requirements_total: data.shiftRequirements.length,
      approved_time_off_overlapping_week: approvedTOOverlapping,
      employee_conflicts: data.conflicts.length,
      custom_availability_active: customApplied,
      special_notes_for_week: specialNotes.length,
    },
    coverage: {
      total_required: totalRequired,
      total_filled: totalFilled,
      coverage_rate_percent: coverageRate,
      gaps: gaps.length,
      flagged_issues: flagged_issues.length,
    },
    closed_dates,
    assignments_by_day: assignmentsByDay,
    gaps_detail: gaps,
    flagged_issues_detail: flagged_issues,
    weekly_hours_by_employee: weeklyHoursByEmployee,
    wage_estimate: {
      total_estimated: wages.total_estimated,
      missing_wages: wages.missing_wages,
      top_5_by_pay: top5ByPay,
    },
  };

  console.log(`[dry-run] Writing output to ${OUTPUT_FILE}`);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log('[dry-run] Done. Read the file to review the proposed schedule.');
}

dryRun().catch(err => {
  console.error('[dry-run] Failed:', err);
  process.exit(1);
});
