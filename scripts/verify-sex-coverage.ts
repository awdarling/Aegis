/**
 * Verification harness for the sex-coverage retire. NOT a permanent fixture.
 *
 * The live DB policy is still scope=all_shifts; the COMPANION migration
 * (Alexander) is what flips it. To verify engine behavior in advance, this
 * script:
 *   1. Loads everything dry-run loads.
 *   2. Replaces any sex attribute_mix policy row in-memory with the new
 *      concurrent_coverage shape, simulating the migration.
 *   3. Runs the engine and reports: sex_coverage flags, per-Headguard hours.
 *   4. Synthetic check: drops all female guards from one date in the loaded
 *      data, re-runs, asserts that the affected day flags female-missing.
 *
 * No DB writes, no policy mutations.
 */
import { supabase } from '../src/db/client';
import { parseConstraints } from '../src/lib/constraints/parser';
import { getWeekBounds } from '../src/lib/engine/week-bounds';
import type { VeteranOnlyRange } from '../src/lib/engine/eligibility';
import { buildTOMap, type TOWindow } from '../src/lib/to-window';
import { getSpecialNotesForRange } from '../src/workflows/special-notes';
import {
  runScheduleBuild,
  type BuildData,
  type VeteranMode,
} from '../src/workflows/schedule-build';
import type {
  Employee,
  Availability,
  PartialDayDetail,
  ShiftType,
  ShiftRequirement,
  EmployeeConflict,
  Policy,
} from '../src/db/types';

const COMPANY_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const POPULATION_ROLES = ['Headguard', 'Lifeguard', 'AManager'];

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

async function loadBuildData(weekStart: string, weekEnd: string): Promise<BuildData> {
  const [
    companyRes, empRes, availRes, toRes,
    stRes, reqRes, conflictRes, polRes,
  ] = await Promise.all([
    supabase.from('companies').select('name, timezone').eq('id', COMPANY_ID).single(),
    supabase.from('employees').select('*').eq('company_id', COMPANY_ID).eq('active', true),
    supabase.from('availability').select('*').eq('company_id', COMPANY_ID),
    supabase.from('time_off_requests')
      .select('employee_id, start_date, end_date, time_off_type, partial_days')
      .eq('company_id', COMPANY_ID).eq('status', 'approved')
      .lte('start_date', weekEnd).gte('end_date', weekStart),
    supabase.from('shift_types').select('*').eq('company_id', COMPANY_ID).eq('active', true),
    supabase.from('shift_requirements').select('*').eq('company_id', COMPANY_ID),
    supabase.from('employee_conflicts').select('*').eq('company_id', COMPANY_ID),
    supabase.from('policies').select('*').eq('company_id', COMPANY_ID),
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

function migrateSexPolicyInMemory(policies: Policy[]): { migrated: number; total: number } {
  let migrated = 0;
  for (const p of policies) {
    const raw = (p as Policy & { policy_value_json?: unknown }).policy_value_json;
    if (!raw || typeof raw !== 'object') continue;
    const obj = raw as Record<string, unknown>;
    if (obj.attribute !== 'sex') continue;
    const replacement = {
      attribute: 'sex',
      minimums: { male: 1, female: 1 },
      scope: 'concurrent_coverage',
      population_roles: POPULATION_ROLES,
      on_infeasible: 'flag',
    };
    (p as Policy & { policy_value_json?: unknown }).policy_value_json = replacement;
    migrated++;
  }
  return { migrated, total: policies.length };
}

function readSex(emp: Employee): string {
  const v = (emp as unknown as Record<string, unknown>).sex;
  return v === null || v === undefined ? 'unknown' : String(v);
}

function summarizeHeadguardHours(
  employees: Employee[],
  assignments: { employee_id: string; hours: number; role: string }[],
): Array<{ name: string; sex: string; total: number; hg_only: number }> {
  const hgIds = new Set(
    employees.filter(e => e.qualified_roles.includes('Headguard')).map(e => e.id)
  );
  const totals = new Map<string, { total: number; hg: number }>();
  for (const a of assignments) {
    if (!hgIds.has(a.employee_id)) continue;
    if (!totals.has(a.employee_id)) totals.set(a.employee_id, { total: 0, hg: 0 });
    const row = totals.get(a.employee_id)!;
    row.total += a.hours;
    if (a.role === 'Headguard') row.hg += a.hours;
  }
  return Array.from(totals.entries())
    .map(([id, v]) => {
      const emp = employees.find(e => e.id === id)!;
      return {
        name: emp.name,
        sex: readSex(emp),
        total: Math.round(v.total * 10) / 10,
        hg_only: Math.round(v.hg * 10) / 10,
      };
    })
    .sort((a, b) => b.total - a.total);
}

async function main(): Promise<void> {
  const { weekStart, weekEnd } = getWeekBounds(1, 'sunday');
  console.log(`[verify] week ${weekStart} → ${weekEnd}`);

  const data = await loadBuildData(weekStart, weekEnd);
  data.events = await getSpecialNotesForRange(COMPANY_ID, weekStart, weekEnd);

  const mig = migrateSexPolicyInMemory(data.policies);
  console.log(`[verify] migrated ${mig.migrated} / ${mig.total} policy row(s) sex → concurrent_coverage`);

  const parsed = parseConstraints(data.policies);
  console.log(
    `[verify] parsed — attribute_mix: ${parsed.hard.attributeMix.length}, concurrent_coverage: ${parsed.hard.concurrentCoverage.length}, unrecognized: ${parsed.unrecognized.length}`
  );
  for (const c of parsed.hard.concurrentCoverage) {
    console.log(`[verify]   coverage rule: attribute=${c.attribute} minimums=${JSON.stringify(c.minimums)} pop=${c.population_roles.join(',')}`);
  }

  const veteranMode: VeteranMode = parsed.settings.veteranPreferenceDefault === 'none'
    ? null
    : (parsed.settings.veteranPreferenceDefault as VeteranMode);
  const veteranOnlyDates: VeteranOnlyRange[] = [];

  // (1) Real-roster run.
  const baseline = runScheduleBuild(data, parsed.settings, veteranMode, veteranOnlyDates, weekStart, weekEnd);
  const sexFlags = baseline.flagged_issues.filter(f => f.type === 'unsatisfied_sex_coverage');
  console.log(`\n=== Real roster ===`);
  console.log(`coverage ${baseline.totalFilled}/${baseline.totalRequired}, gaps=${baseline.gaps.length}, sex_coverage flags=${sexFlags.length}`);
  if (sexFlags.length > 0) {
    for (const f of sexFlags) console.log(`  FLAG ${f.date}: ${f.description}`);
  }
  console.log(`\nHeadguard-qualified employees, weekly hours:`);
  const hgTable = summarizeHeadguardHours(data.employees, baseline.assignments);
  for (const r of hgTable) {
    console.log(`  ${r.name.padEnd(28)} sex=${r.sex.padEnd(7)} total=${r.total.toString().padStart(5)}h  HG-only=${r.hg_only}h`);
  }

  // (2) Synthetic check: drop all female guards from one date in-memory.
  // Use the date with the most population-role assignments so the segment
  // boundaries are non-trivial.
  const dateCounts = new Map<string, number>();
  for (const a of baseline.assignments) {
    if (!POPULATION_ROLES.includes(a.role)) continue;
    dateCounts.set(a.date, (dateCounts.get(a.date) ?? 0) + 1);
  }
  const targetDate = Array.from(dateCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!targetDate) {
    console.log('\n[verify] synthetic check skipped — no population-role assignments found');
    process.exit(0);
  }

  console.log(`\n=== Synthetic: drop all female guards on ${targetDate} ===`);
  // Clone data with female guards filtered out for the target date by punching
  // their availability for that date. Cheapest reversible mutation that keeps
  // them in the roster (and thus in employeeById) but unschedulable that day.
  const femaleGuardIds = new Set(
    data.employees
      .filter(e => readSex(e) === 'female' && e.qualified_roles.some(r => POPULATION_ROLES.includes(r)))
      .map(e => e.id)
  );
  console.log(`[verify]   ${femaleGuardIds.size} female-guards in roster`);

  const originalAvail = new Map<string, Availability[]>();
  for (const id of femaleGuardIds) {
    const cur = data.availByEmp.get(id) ?? [];
    originalAvail.set(id, cur);
    // Filter out availability rows for that date's day-of-week so they can't
    // be placed that day. day_of_week is 0..6 Sun..Sat.
    const dow = new Date(targetDate + 'T12:00:00Z').getUTCDay();
    data.availByEmp.set(id, cur.filter(a => a.day_of_week !== dow));
  }

  const synthetic = runScheduleBuild(data, parsed.settings, veteranMode, veteranOnlyDates, weekStart, weekEnd);
  const synthFlags = synthetic.flagged_issues.filter(f => f.type === 'unsatisfied_sex_coverage');
  const onTarget = synthFlags.filter(f => f.date === targetDate);
  console.log(`coverage ${synthetic.totalFilled}/${synthetic.totalRequired}, gaps=${synthetic.gaps.length}, sex_coverage flags total=${synthFlags.length}, on ${targetDate}=${onTarget.length}`);
  for (const f of onTarget.slice(0, 10)) console.log(`  FLAG ${f.date}: ${f.description}`);
  if (onTarget.length === 0) {
    console.log(`  [WARN] expected female-missing flags on ${targetDate}, got none — investigate`);
  }

  // Revert in-memory mutations (defensive — the process is about to exit).
  for (const [id, rows] of originalAvail) data.availByEmp.set(id, rows);
}

main().catch(err => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
