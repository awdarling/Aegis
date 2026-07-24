/**
 * FAIRNESS-2 floor before/after dry-run (READ-ONLY — no DB writes, no sends).
 *
 * Loads live Watermark data for an upcoming week and runs the REAL engine on the
 * SAME inputs (same cross-week memory + same tiebreak seed) twice, so the ONLY
 * difference is the within-week distribution floor:
 *   OFF — { fairnessFloorEnabled: false }   (today's behavior)
 *   ON  — { fairnessFloorEnabled: true }     (the fix)
 *
 * Prints per-employee hours (all roles), the idle/heavy spread, and calls out
 * anyone lifted off zero. Run from a NETWORKED shell (device_bash has none):
 *   npx ts-node --transpile-only scripts/dryrun-floor-compare.ts
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

function hoursByEmp(assignments: ScheduleAssignment[]): Map<string, number> {
  const h = new Map<string, number>();
  for (const a of assignments) h.set(a.employee_id, (h.get(a.employee_id) ?? 0) + a.hours);
  return h;
}
function spread(h: Map<string, number>, ids: string[]) {
  const arr = ids.map(id => h.get(id) ?? 0);
  return { idle: arr.filter(x => x === 0).length, light: arr.filter(x => x > 0 && x <= 6.5).length, heavy: arr.filter(x => x >= 24).length };
}

async function main() {
  const { data: policyRows } = await supabase.from('policies').select('*').eq('company_id', COMPANY_ID);
  const baseSettings: EngineSettings = parseConstraints((policyRows ?? []) as Policy[]).settings;
  const { weekStart, weekEnd } = getWeekBounds(1, baseSettings.weekStartDay); // next week
  console.log(`\n=== FAIRNESS-2 floor dry-run (READ-ONLY) — Watermark, week ${weekStart}..${weekEnd} ===`);
  console.log(`floor: enabled=${baseSettings.fairnessFloorEnabled} ratio=${baseSettings.fairnessFloorRatio} | memory lookback=${baseSettings.fairnessLookbackWeeks} decay=${baseSettings.fairnessDecay}`);

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
  const priorHoursMap = await loadRecentHours(COMPANY_ID, weekStart, parsed.settings.fairnessLookbackWeeks, parsed.settings.fairnessDecay);

  // Only the floor flag differs between the two runs (same memory, same seed).
  const SEED = 'floor-dryrun';
  const settingsOff: EngineSettings = { ...parsed.settings, fairnessFloorEnabled: false };
  const settingsOn: EngineSettings = { ...parsed.settings, fairnessFloorEnabled: true };
  const OFF = runScheduleBuild(data, settingsOff, veteranMode, vetOnly, weekStart, weekEnd, { priorHoursMap, tieBreakSeed: SEED });
  const ON = runScheduleBuild(data, settingsOn, veteranMode, vetOnly, weekStart, weekEnd, { priorHoursMap, tieBreakSeed: SEED });

  const empById = new Map(data.employees.map(e => [e.id, e]));
  const ids = data.employees.map(e => e.id);
  const offH = hoursByEmp(OFF.assignments), onH = hoursByEmp(ON.assignments);
  console.log(`\ncoverage: OFF ${OFF.totalFilled}/${OFF.totalRequired}, ON ${ON.totalFilled}/${ON.totalRequired}  (floor must not reduce coverage)`);
  console.log('spread OFF:', spread(offH, ids), ' | spread ON:', spread(onH, ids));

  const rows = ids.map(id => ({
    name: empById.get(id)?.name ?? id, role: empById.get(id)?.primary_role ?? '',
    prior: +(priorHoursMap.get(id) ?? 0).toFixed(1), off: +(offH.get(id) ?? 0).toFixed(1), on: +(onH.get(id) ?? 0).toFixed(1),
  })).sort((a, b) => (a.role.localeCompare(b.role)) || (b.off - a.off));
  console.log('\nname                      role         prior3wk    OFF ->   ON     delta');
  for (const r of rows) {
    const d = +(r.on - r.off).toFixed(1);
    const flag = (r.off === 0 && r.on > 0) ? '  <-- lifted off zero' : (Math.abs(d) >= 0.1 ? '  *' : '');
    console.log(`  ${r.name.padEnd(22)} ${r.role.padEnd(11)} ${String(r.prior).padStart(7)}  ${String(r.off).padStart(6)} -> ${String(r.on).padStart(6)}  ${String(d).padStart(6)}${flag}`);
  }
  for (const nm of ['Michael McCorkle', 'Lucas Witham']) {
    const r = rows.find(x => x.name === nm); if (r) console.log(`\n${nm}: ${r.off}h -> ${r.on}h (prior3wk=${r.prior})`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('dry-run failed:', e); process.exit(1); });
