/**
 * FAIRNESS-1 before/after dry-run (READ-ONLY — no DB writes, no sends).
 *
 * Loads live Watermark data for an upcoming week and runs the REAL engine three
 * ways on the SAME inputs:
 *   OLD  — no opts (today's production behavior: no cross-week memory, alpha tiebreak)
 *   NEW-A — { priorHoursMap (trailing 3wk decayed), tieBreakSeed:'seed-A' }
 *   NEW-B — same memory, tieBreakSeed:'seed-B'   (to show rebuilds now differ)
 *
 * Prints the lifeguard hours spread for OLD vs NEW and whether the two NEW
 * builds differ. Run: npx ts-node scripts/dryrun-fairness-compare.ts
 */
import 'dotenv/config';
import { supabase } from '../src/db/client';
import { parseConstraints } from '../src/lib/constraints/parser';
import type { EngineSettings } from '../src/lib/constraints/types';
import { getWeekBounds } from '../src/lib/engine/week-bounds';
import type { VeteranOnlyRange } from '../src/lib/engine/eligibility';
import { resolveAvailabilityForWeek } from '../src/lib/custom-availability';
import { buildTOMap, type TOWindow } from '../src/lib/to-window';
import { getSpecialNotesForRange } from '../src/workflows/special-notes';
import { runScheduleBuild, type BuildData, type ScheduleAssignment, type VeteranMode } from '../src/workflows/schedule-build';
import type {
  Employee, Availability, CustomAvailability, PartialDayDetail,
  ShiftType, ShiftRequirement, EmployeeConflict, Policy, ShiftExperienceRule,
} from '../src/db/types';

const COMPANY_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function datesInRange(start: string, end: string): string[] {
  const out: string[] = []; const cur = new Date(start + 'T12:00:00Z'); const last = new Date(end + 'T12:00:00Z');
  while (cur <= last) { out.push(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() + 1); }
  return out;
}

async function loadBuildData(companyId: string, weekStart: string, weekEnd: string): Promise<BuildData> {
  const [companyRes, empRes, availRes, toRes, stRes, reqRes, conflictRes, polRes, expRes] = await Promise.all([
    supabase.from('companies').select('name, timezone').eq('id', companyId).single(),
    supabase.from('employees').select('*').eq('company_id', companyId).eq('active', true),
    supabase.from('availability').select('*').eq('company_id', companyId),
    supabase.from('time_off_requests').select('employee_id, start_date, end_date, time_off_type, partial_days')
      .eq('company_id', companyId).eq('status', 'approved').lte('start_date', weekEnd).gte('end_date', weekStart),
    supabase.from('shift_types').select('*').eq('company_id', companyId).eq('active', true),
    supabase.from('shift_requirements').select('*').eq('company_id', companyId),
    supabase.from('employee_conflicts').select('*').eq('company_id', companyId),
    supabase.from('policies').select('*').eq('company_id', companyId),
    supabase.from('shift_experience_rules').select('*').eq('company_id', companyId).eq('active', true),
  ]);
  const employees = (empRes.data ?? []) as Employee[];
  const availByEmp = new Map<string, Availability[]>();
  for (const a of (availRes.data ?? []) as Availability[]) {
    if (!availByEmp.has(a.employee_id)) availByEmp.set(a.employee_id, []);
    availByEmp.get(a.employee_id)!.push(a);
  }
  const toRows = (toRes.data ?? []) as Array<{ employee_id: string; start_date: string; end_date: string; time_off_type: 'full_day' | 'partial' | null; partial_days: PartialDayDetail[] | null }>;
  const toMap: Map<string, TOWindow> = buildTOMap(datesInRange(weekStart, weekEnd), toRows);
  const company = companyRes.data as { name: string; timezone: string } | null;
  return {
    employees, availByEmp, toMap,
    shiftTypes: (stRes.data ?? []) as ShiftType[],
    shiftRequirements: (reqRes.data ?? []) as ShiftRequirement[],
    conflicts: (conflictRes.data ?? []) as EmployeeConflict[],
    policies: (polRes.data ?? []) as Policy[],
    events: [],
    experienceRules: ((expRes.data ?? []) as ShiftExperienceRule[]).map(r => ({
      shift_type_id: r.shift_type_id, days_of_week: r.days_of_week, role: r.role,
      mode: r.mode === 'all_veterans' ? 'all_veterans' as const : 'min_veterans' as const,
      min_count: r.min_count, season_start: r.season_start, season_end: r.season_end, active: r.active,
    })),
    companyName: company?.name ?? 'Watermark', companyTimezone: company?.timezone ?? 'America/Detroit',
  } as BuildData;
}

async function loadRecentHours(companyId: string, weekStart: string, lookbackWeeks: number, decay: number): Promise<Map<string, number>> {
  const priorHours = new Map<string, number>();
  if (lookbackWeeks <= 0) return priorHours;
  const { data: rows } = await supabase.from('schedules').select('week_start, data')
    .eq('company_id', companyId).lt('week_start', weekStart)
    .is('deleted_at', null).is('superseded_by', null).not('published_at', 'is', null)
    .order('week_start', { ascending: false }).order('published_at', { ascending: false }).limit(lookbackWeeks * 4);
  const seen = new Set<string>(); let rank = 0;
  for (const row of (rows ?? []) as Array<{ week_start: string; data: { assignments?: Array<{ employee_id?: string; hours?: number }> } | null }>) {
    if (seen.has(row.week_start)) continue; seen.add(row.week_start);
    const w = Math.pow(decay, rank); rank++;
    for (const a of row.data?.assignments ?? []) {
      if (!a.employee_id || typeof a.hours !== 'number') continue;
      priorHours.set(a.employee_id, (priorHours.get(a.employee_id) ?? 0) + a.hours * w);
    }
    if (rank >= lookbackWeeks) break;
  }
  return priorHours;
}

function fp(a: ScheduleAssignment[]): string {
  return a.map(x => `${x.date}|${x.employee_id}|${x.shift_name}`).sort().join('||');
}

function lgHours(assignments: ScheduleAssignment[], employees: Employee[]): Map<string, number> {
  const lg = new Set(employees.filter(e => e.primary_role === 'Lifeguard' && e.active).map(e => e.id));
  const h = new Map<string, number>(); for (const id of lg) h.set(id, 0);
  for (const a of assignments) if (lg.has(a.employee_id)) h.set(a.employee_id, (h.get(a.employee_id) ?? 0) + a.hours);
  return h;
}
function stats(h: Map<string, number>) {
  const arr = [...h.values()];
  const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length);
  return { n: arr.length, min: Math.min(...arr), max: Math.max(...arr), mean: +mean.toFixed(1), sd: +sd.toFixed(1), starved: arr.filter(x => x > 0 && x <= 6.5).length, heavy: arr.filter(x => x >= 24).length, idle: arr.filter(x => x === 0).length };
}

async function main() {
  const { data: policyRows } = await supabase.from('policies').select('*').eq('company_id', COMPANY_ID);
  const settings: EngineSettings = parseConstraints((policyRows ?? []) as Policy[]).settings;
  const { weekStart, weekEnd } = getWeekBounds(1, settings.weekStartDay); // next week
  console.log(`\n=== FAIRNESS-1 dry-run (READ-ONLY) — Watermark, week ${weekStart}..${weekEnd} ===`);
  console.log(`settings: fairnessWeight=${settings.hoursFairnessWeight} lookback=${settings.fairnessLookbackWeeks} decay=${settings.fairnessDecay}`);

  const [data, specialNotes] = await Promise.all([loadBuildData(COMPANY_ID, weekStart, weekEnd), getSpecialNotesForRange(COMPANY_ID, weekStart, weekEnd)]);
  data.events = specialNotes;
  const parsed = parseConstraints(data.policies);

  const { data: customAvailData } = await supabase.from('custom_availability').select('*').eq('company_id', COMPANY_ID).eq('active', true).order('created_at', { ascending: false });
  const byEmp: Record<string, CustomAvailability> = {};
  for (const row of (customAvailData ?? []) as CustomAvailability[]) if (!byEmp[row.employee_id]) byEmp[row.employee_id] = row;
  for (const emp of data.employees) {
    const custom = byEmp[emp.id]; if (!custom) continue;
    const normal = data.availByEmp.get(emp.id) ?? [];
    const resolved = resolveAvailabilityForWeek(emp, weekStart, weekEnd, normal, custom);
    if (resolved !== normal) data.availByEmp.set(emp.id, resolved);
  }

  const veteranMode: VeteranMode = parsed.settings.veteranPreferenceDefault === 'none' ? null : (parsed.settings.veteranPreferenceDefault as VeteranMode);
  const vetOnly: VeteranOnlyRange[] = [];
  console.log(`inputs: ${data.employees.length} employees, ${(data.experienceRules ?? []).length} veteran experience rules\n`);

  const priorHoursMap = await loadRecentHours(COMPANY_ID, weekStart, parsed.settings.fairnessLookbackWeeks, parsed.settings.fairnessDecay);

  const OLD = runScheduleBuild(data, parsed.settings, veteranMode, vetOnly, weekStart, weekEnd);
  const OLD2 = runScheduleBuild(data, parsed.settings, veteranMode, vetOnly, weekStart, weekEnd);
  const NEWA = runScheduleBuild(data, parsed.settings, veteranMode, vetOnly, weekStart, weekEnd, { priorHoursMap, tieBreakSeed: 'seed-A' });
  const NEWB = runScheduleBuild(data, parsed.settings, veteranMode, vetOnly, weekStart, weekEnd, { priorHoursMap, tieBreakSeed: 'seed-B' });

  const empById = new Map(data.employees.map(e => [e.id, e]));
  console.log('OLD (today):   lifeguard hours', stats(lgHours(OLD.assignments, data.employees)));
  console.log('NEW seed-A:    lifeguard hours', stats(lgHours(NEWA.assignments, data.employees)));
  console.log('NEW seed-B:    lifeguard hours', stats(lgHours(NEWB.assignments, data.employees)));
  console.log(`\ncoverage: OLD ${OLD.totalFilled}/${OLD.totalRequired}, NEW-A ${NEWA.totalFilled}/${NEWA.totalRequired}, NEW-B ${NEWB.totalFilled}/${NEWB.totalRequired}`);
  console.log(`rebuild determinism:  OLD==OLD2 (same, expected): ${fp(OLD.assignments) === fp(OLD2.assignments)}`);
  console.log(`rebuild rotation:     NEW-A != NEW-B (different, the fix): ${fp(NEWA.assignments) !== fp(NEWB.assignments)}`);

  const oldH = lgHours(OLD.assignments, data.employees);
  const newH = lgHours(NEWA.assignments, data.employees);
  const rows = [...oldH.keys()].map(id => ({ name: empById.get(id)?.name ?? id, vet: empById.get(id)?.is_veteran ? 'V' : ' ', prior: +(priorHoursMap.get(id) ?? 0).toFixed(1), old: oldH.get(id) ?? 0, neu: newH.get(id) ?? 0 }))
    .sort((a, b) => b.old - a.old);
  console.log('\nper-lifeguard (sorted by OLD hours):  name [vet]  prior3wk  OLD -> NEW(seedA)');
  for (const r of rows) console.log(`  ${r.name.padEnd(22)} ${r.vet}   prior=${String(r.prior).padStart(6)}   ${String(r.old).padStart(5)} -> ${String(r.neu).padStart(5)}`);
}

main().then(() => process.exit(0)).catch(e => { console.error('dry-run failed:', e); process.exit(1); });
