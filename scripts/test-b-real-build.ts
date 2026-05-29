/**
 * Test B — production schedule build for Watermark Country Club.
 *
 * Runs the production engine code path against live data, persists the
 * result to the schedules table as a draft, and prints a comprehensive
 * markdown summary to stdout for manual review before the manager sees it.
 *
 * Does NOT distribute (no SMS, no email, no distributed_at). Schedule
 * status is forced to 'draft'.
 *
 * Run: npx tsx scripts/test-b-real-build.ts
 */

import { supabase } from '../src/db/client';
import { parseConstraints } from '../src/lib/constraints/parser';
import { resolveAvailabilityForWeek } from '../src/lib/custom-availability';
import { buildTOMap } from '../src/lib/to-window';
import { getSpecialNotesForRange } from '../src/workflows/special-notes';
import { computeWageEstimate } from '../src/lib/schedule-simulator';
import {
  ENGINE_VERSION,
  runScheduleBuild,
  type BuildData,
  type VeteranMode,
} from '../src/workflows/schedule-build';
import { logActivity } from '../src/logger/activity-log';
import type {
  Employee,
  Availability,
  CustomAvailability,
  EmployeeConflict,
  PartialDayDetail,
  Policy,
  ShiftRequirement,
  ShiftType,
} from '../src/db/types';

const COMPANY_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const WEEK_START = '2026-06-01';
const WEEK_END = '2026-06-07';

// ── Helpers ─────────────────────────────────────────────────────────────────

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

function fmtTime(t: string): string {
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

function fmtDayLine(date: string): string {
  const d = new Date(date + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// ── Data loading (mirrors handleBuildSchedule, NOT exported) ────────────────

async function loadBuildDataMirror(companyId: string, weekStart: string, weekEnd: string): Promise<BuildData> {
  const [companyRes, empRes, availRes, toRes, stRes, reqRes, conflictRes, polRes] = await Promise.all([
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
  const toMap = buildTOMap(weekDates, toRows);

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

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Pre-check: bail if a schedule already exists for this week.
  const { data: existingRows } = await supabase
    .from('schedules')
    .select('id, status, generated_at')
    .eq('company_id', COMPANY_ID)
    .eq('week_start', WEEK_START);
  if ((existingRows ?? []).length > 0) {
    console.error('A schedule already exists for this week. Aborting to avoid destructive overwrite.');
    console.error(JSON.stringify(existingRows, null, 2));
    process.exit(1);
  }

  // 1) Load build data.
  const data = await loadBuildDataMirror(COMPANY_ID, WEEK_START, WEEK_END);
  const specialNotes = await getSpecialNotesForRange(COMPANY_ID, WEEK_START, WEEK_END);
  data.events = specialNotes;

  // 2) Parse engine settings from policies.
  const parsed = parseConstraints(data.policies);

  // 3) Fold custom_availability (newest active row per employee).
  const { data: customAvailData } = await supabase
    .from('custom_availability')
    .select('*')
    .eq('company_id', COMPANY_ID)
    .eq('active', true)
    .order('created_at', { ascending: false });
  const customAvailByEmp: Record<string, CustomAvailability> = {};
  for (const row of (customAvailData ?? []) as CustomAvailability[]) {
    if (!customAvailByEmp[row.employee_id]) customAvailByEmp[row.employee_id] = row;
  }
  for (const emp of data.employees) {
    const custom = customAvailByEmp[emp.id] ?? null;
    if (!custom) continue;
    const normal = data.availByEmp.get(emp.id) ?? [];
    const resolved = resolveAvailabilityForWeek(emp, WEEK_START, WEEK_END, normal, custom);
    if (resolved !== normal) data.availByEmp.set(emp.id, resolved);
  }

  // 4) Run the engine.
  const veteranMode: VeteranMode = null;
  const veteranOnlyDates: { start_date: string; end_date: string }[] = [];
  const result = runScheduleBuild(data, parsed.settings, veteranMode, veteranOnlyDates, WEEK_START, WEEK_END);

  // 5) Wage estimate.
  const wages = await computeWageEstimate(COMPANY_ID, result.assignments);

  // 6) Staffing report — assembled inline so we keep parity with production
  // without exporting more private helpers.
  const coverageRate = result.totalRequired > 0
    ? Math.round((result.totalFilled / result.totalRequired) * 1000) / 10
    : 100;
  const hoursMapForReport = new Map<string, number>();
  for (const a of result.assignments) {
    hoursMapForReport.set(a.employee_id, (hoursMapForReport.get(a.employee_id) ?? 0) + a.hours);
  }
  const topContributors = Array.from(hoursMapForReport.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, hours]) => ({
      employee_id: id,
      name: data.employees.find(e => e.id === id)?.name ?? id,
      hours,
    }));
  const overtimeRisk = Array.from(hoursMapForReport.entries())
    .filter(([id, h]) => {
      const emp = data.employees.find(e => e.id === id);
      return emp && h >= emp.max_weekly_hours - 4;
    })
    .map(([id, h]) => {
      const emp = data.employees.find(e => e.id === id)!;
      return { employee_id: id, name: emp.name, hours: h, max_hours: emp.max_weekly_hours };
    });
  const staffingReport = {
    coverage_rate: coverageRate,
    top_contributors: topContributors,
    overtime_risk: overtimeRisk,
    gap_summary: result.gaps.length === 0
      ? 'All shifts fully covered.'
      : result.gaps.map(g => `${g.date} ${g.shift_name} ${g.role} (${g.filled_count}/${g.required_count}): ${g.reason}`).join('\n'),
    special_notes_applied: specialNotes.filter(n => n.staffing_notes || n.shift_overrides).map(n => n.title),
    closed_dates: result.closed_dates,
    shift_override_mismatches: result.shift_override_mismatches,
    aegis_notes: overtimeRisk.length > 0 ? `${overtimeRisk.length} employee(s) are near or at maximum weekly hours.` : '',
    estimated_wages: wages,
    engine_version: ENGINE_VERSION,
    unrecognized_policies: parsed.unrecognized,
  };

  // 7) Persist to DB as draft.
  const dataPayload = {
    assignments: result.assignments,
    gaps: result.gaps,
    flagged_issues: result.flagged_issues,
    closed_dates: result.closed_dates,
    shift_override_mismatches: result.shift_override_mismatches,
  } as unknown as Record<string, unknown>;
  const { data: inserted, error: insertErr } = await supabase
    .from('schedules')
    .insert({
      company_id: COMPANY_ID,
      week_start: WEEK_START,
      week_end: WEEK_END,
      generated_at: new Date().toISOString(),
      generated_by: 'aegis',
      status: 'draft',
      data: dataPayload,
      staffing_report: staffingReport as unknown as Record<string, unknown>,
    })
    .select('id, status, distributed_at, approved_at')
    .single();

  if (insertErr || !inserted) {
    console.error('Insert failed:', insertErr?.message);
    process.exit(1);
  }
  const scheduleId = (inserted as { id: string }).id;

  // 8) Activity log (no 'schedule_distributed' — only the build entry).
  await logActivity({
    company_id: COMPANY_ID,
    action: 'schedule_built',
    entity_type: 'schedule',
    entity_id: scheduleId,
    summary: `Schedule built for ${WEEK_START}–${WEEK_END}: ${result.totalFilled}/${result.totalRequired} slots filled (${result.gaps.length} gaps, ${result.flagged_issues.length} flagged) [test-b run]`,
    metadata: {
      week_start: WEEK_START,
      week_end: WEEK_END,
      total_filled: result.totalFilled,
      total_required: result.totalRequired,
      gaps: result.gaps.length,
      flagged_issues: result.flagged_issues.length,
      estimated_wages: wages.total_estimated,
      special_notes_count: specialNotes.length,
      engine_version: ENGINE_VERSION,
      test_run: true,
    },
  });

  // ── PART 3 — Manager-readable summary ────────────────────────────────────
  const lines: string[] = [];
  lines.push(`# Watermark Schedule — Week of June 1–7, 2026`);
  lines.push('');
  lines.push(`Schedule ID: ${scheduleId}`);
  lines.push(`Status: ${(inserted as { status: string }).status}`);
  lines.push(`Coverage: ${result.totalFilled}/${result.totalRequired} (${coverageRate}%)`);
  lines.push(`Total estimated labor: $${wages.total_estimated.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  lines.push(`Engine version: ${ENGINE_VERSION}`);
  lines.push('');
  lines.push(`## Day-by-day assignments`);

  const weekDates = getDatesInRange(WEEK_START, WEEK_END);
  for (const date of weekDates) {
    lines.push('');
    lines.push(`### ${fmtDayLine(date)}`);
    const dayAssigns = result.assignments
      .filter(a => a.date === date)
      .sort((a, b) => {
        if (a.start_time !== b.start_time) return a.start_time < b.start_time ? -1 : 1;
        if (a.shift_name !== b.shift_name) return a.shift_name < b.shift_name ? -1 : 1;
        return a.role < b.role ? -1 : 1;
      });
    if (dayAssigns.length === 0) {
      lines.push('_no assignments_');
      continue;
    }
    // Group by shift_name (using the first occurrence to preserve sort).
    const byShift = new Map<string, typeof dayAssigns>();
    for (const a of dayAssigns) {
      if (!byShift.has(a.shift_name)) byShift.set(a.shift_name, []);
      byShift.get(a.shift_name)!.push(a);
    }
    for (const [shiftName, list] of byShift) {
      const first = list[0];
      lines.push(`${shiftName} (${fmtTime(first.start_time)}–${fmtTime(first.end_time)}):`);
      for (const a of list) lines.push(`  - ${a.role}: ${a.employee_name}`);
    }
  }

  lines.push('');
  lines.push(`## Coverage gaps`);
  if (result.gaps.length === 0) {
    lines.push('No coverage gaps. Every shift is filled.');
  } else {
    for (const g of result.gaps) {
      lines.push('');
      lines.push(`- **${g.date} ${g.shift_name} — ${g.role}** (${g.filled_count}/${g.required_count} filled)`);
      lines.push(`  - Short reason: ${g.reason}`);
      lines.push(`  - ${g.description}`);
      if (g.per_employee_dispositions.length > 0) {
        lines.push(`  - Dispositions:`);
        for (const d of g.per_employee_dispositions) {
          lines.push(`    - ${d.name} → ${d.reason}`);
        }
      }
    }
  }

  lines.push('');
  lines.push(`## Flagged issues`);
  if (result.flagged_issues.length === 0) {
    lines.push('_none_');
  } else {
    for (const f of result.flagged_issues) {
      lines.push('');
      lines.push(`- **${f.date} ${f.shift_name} — ${f.type}**`);
      lines.push(`  - ${f.description}`);
      const meta = f.metadata as { per_employee_dispositions?: Array<{ name: string; reason: string }> };
      if (meta.per_employee_dispositions && meta.per_employee_dispositions.length > 0) {
        lines.push(`  - Per-employee dispositions:`);
        for (const d of meta.per_employee_dispositions) {
          lines.push(`    - ${d.name} → ${d.reason}`);
        }
      }
    }
  }

  lines.push('');
  lines.push(`## Closed dates`);
  if (result.closed_dates.length === 0) lines.push('_none_');
  else for (const c of result.closed_dates) lines.push(`- ${c.date}: ${c.event_title}`);

  lines.push('');
  lines.push(`## Shift override mismatches`);
  if (result.shift_override_mismatches.length === 0) lines.push('_none_');
  else for (const m of result.shift_override_mismatches) {
    lines.push(`- ${m.date} ${m.shift_name}: override key '${m.override_key}' not in available roles [${m.available_roles.join(', ')}]`);
  }

  lines.push('');
  lines.push(`## Unrecognized policies`);
  if (parsed.unrecognized.length === 0) lines.push('_none_');
  else {
    lines.push('(surfaced informationally; not consumed by the engine)');
    for (const u of parsed.unrecognized) lines.push(`- ${u.policy_key} (id=${u.policy_id}): reason=${u.reason}`);
  }

  lines.push('');
  lines.push(`## Missing wages`);
  if (wages.missing_wages.length === 0) lines.push('_none — every employee with scheduled hours has a wage rate configured_');
  else for (const m of wages.missing_wages) lines.push(`- ${m.name} (${m.role})`);

  // ── PART 4 — Distinctive findings ────────────────────────────────────────
  lines.push('');
  lines.push(`## Hours distribution`);
  const hoursPerEmp = new Map<string, number>();
  for (const e of data.employees) hoursPerEmp.set(e.id, 0);
  for (const a of result.assignments) hoursPerEmp.set(a.employee_id, (hoursPerEmp.get(a.employee_id) ?? 0) + a.hours);
  const empById = new Map(data.employees.map(e => [e.id, e]));

  const sortedByHours = Array.from(hoursPerEmp.entries())
    .map(([id, h]) => ({ id, name: empById.get(id)?.name ?? id, hours: Math.round(h * 10) / 10, max: empById.get(id)?.max_weekly_hours ?? 0 }))
    .sort((a, b) => b.hours - a.hours);
  lines.push('');
  lines.push(`Top 5 by scheduled hours:`);
  for (const r of sortedByHours.slice(0, 5)) lines.push(`  - ${r.name}: ${r.hours}h (max ${r.max})`);
  const nonZero = sortedByHours.filter(r => r.hours > 0);
  lines.push('');
  lines.push(`Bottom 5 by scheduled hours (excluding 0):`);
  for (const r of nonZero.slice(-5).reverse()) lines.push(`  - ${r.name}: ${r.hours}h (max ${r.max})`);
  const atMax = sortedByHours.filter(r => r.max > 0 && r.hours === r.max);
  lines.push('');
  lines.push(`Employees at exactly max_weekly_hours: ${atMax.length}`);
  for (const r of atMax) lines.push(`  - ${r.name} (${r.hours}/${r.max})`);
  const zeroHours = sortedByHours.filter(r => r.hours === 0);
  lines.push('');
  lines.push(`Employees with 0 hours scheduled: ${zeroHours.length}`);
  for (const r of zeroHours) lines.push(`  - ${r.name} (max ${r.max})`);
  const totalEmps = sortedByHours.length;
  const avgHours = totalEmps > 0 ? sortedByHours.reduce((s, r) => s + r.hours, 0) / totalEmps : 0;
  const variance = totalEmps > 0 ? sortedByHours.reduce((s, r) => s + (r.hours - avgHours) ** 2, 0) / totalEmps : 0;
  const stdev = Math.sqrt(variance);
  lines.push('');
  lines.push(`Average hours per employee: ${Math.round(avgHours * 10) / 10}h`);
  lines.push(`Standard deviation: ${Math.round(stdev * 10) / 10}h`);

  lines.push('');
  lines.push(`## Thursday June 4 deep-dive`);
  const thuAssigns = result.assignments.filter(a => a.date === '2026-06-04');
  const empSex = (id: string): string => {
    const e = empById.get(id) as unknown as Record<string, unknown> | undefined;
    return (e?.['sex'] as string) ?? 'unknown';
  };
  for (const shiftName of ['AM Weekday', 'Afternoon']) {
    lines.push('');
    lines.push(`${shiftName} assignments:`);
    const list = thuAssigns.filter(a => a.shift_name === shiftName);
    for (const a of list) {
      const h = hoursPerEmp.get(a.employee_id) ?? 0;
      lines.push(`  - ${a.role}: ${a.employee_name} (sex: ${empSex(a.employee_id)}, hours-this-week: ${Math.round(h * 10) / 10})`);
    }
  }

  // Eligible-but-unchosen audit
  lines.push('');
  lines.push(`### Eligible-but-unchosen from the Thursday flags`);
  for (const f of result.flagged_issues.filter(f => f.date === '2026-06-04')) {
    const meta = f.metadata as { per_employee_dispositions?: Array<{ employee_id: string; name: string; reason: string }>; value?: string };
    const ebus = (meta.per_employee_dispositions ?? []).filter(d => d.reason === 'eligible_but_unchosen');
    lines.push('');
    lines.push(`${f.shift_name} (missing sex=${meta.value}): ${ebus.length} eligible_but_unchosen`);
    for (const e of ebus) {
      const otherShifts = result.assignments.filter(a => a.employee_id === e.employee_id);
      const otherHours = otherShifts.reduce((s, a) => s + a.hours, 0);
      const list = otherShifts.map(a => `${a.date} ${a.shift_name}/${a.role}`).join('; ');
      lines.push(`  - ${e.name} (${Math.round(otherHours * 10) / 10}h this week): ${list || 'no other shifts'}`);
    }
  }

  lines.push('');
  lines.push(`## Time off impact`);
  const toKeys = Array.from(data.toMap.keys());
  const empWithTO = new Set(toKeys.map(k => k.split(':')[0]));
  const datesAffected = new Map<string, Set<string>>();
  for (const key of toKeys) {
    const [empId, date] = key.split(':');
    if (!datesAffected.has(date)) datesAffected.set(date, new Set());
    datesAffected.get(date)!.add(empId);
  }
  lines.push(`Total date-employee TO entries next week: ${toKeys.length}`);
  lines.push(`Employees with at least 1 TO day: ${empWithTO.size} / ${data.employees.length}`);
  const dayImpact = Array.from(datesAffected.entries())
    .map(([d, set]) => ({ d, n: set.size }))
    .sort((a, b) => b.n - a.n);
  lines.push(`Days with most TO impact:`);
  for (const e of dayImpact) {
    const wd = new Date(e.d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' });
    lines.push(`  - ${wd} ${e.d}: ${e.n} employee(s) affected`);
  }

  // Verify post-conditions for PART 5.
  lines.push('');
  lines.push(`## Persistence verification`);
  const { data: verify } = await supabase
    .from('schedules')
    .select('id, status, distributed_at, approved_at, generated_by')
    .eq('id', scheduleId)
    .single();
  lines.push(`Re-read row: ${JSON.stringify(verify)}`);

  console.log(lines.join('\n'));
}

main().catch(err => {
  console.error('Test B run failed:', err);
  process.exit(1);
});
