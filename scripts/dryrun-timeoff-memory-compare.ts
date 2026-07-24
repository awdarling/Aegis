/**
 * FAIRNESS-3 memory before/after dry-run (READ-ONLY — no writes).
 *
 * Shows each employee's decayed cross-week "prior hours" memory computed the OLD
 * way (raw actual hours — a vacation reads as under-worked) vs the NEW way
 * (approved full-day time-off weeks imputed to a normal week). Anyone who was on
 * leave should see their memory rise, so they stop being front-loaded next week.
 *
 * Run from a NETWORKED shell:  npx ts-node --transpile-only scripts/dryrun-timeoff-memory-compare.ts
 */
import 'dotenv/config';
import { supabase } from '../src/db/client';
import { parseConstraints } from '../src/lib/constraints/parser';
import { getWeekBounds } from '../src/lib/engine/week-bounds';
import { foldPriorHours, type PriorWeekHours } from '../src/workflows/schedule-build';
import type { Policy, Employee } from '../src/db/types';

const COMPANY_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
function addDaysISO(d: string, n: number): string {
  const dt = new Date(d + 'T12:00:00Z'); dt.setUTCDate(dt.getUTCDate() + n); return dt.toISOString().slice(0, 10);
}

async function main() {
  const { data: policyRows } = await supabase.from('policies').select('*').eq('company_id', COMPANY_ID);
  const settings = parseConstraints((policyRows ?? []) as Policy[]).settings;
  const { weekStart } = getWeekBounds(1, settings.weekStartDay);
  const lookback = settings.fairnessLookbackWeeks, decay = settings.fairnessDecay;
  console.log(`\n=== FAIRNESS-3 memory dry-run (READ-ONLY) — Watermark, next week ${weekStart} ===`);
  console.log(`lookback=${lookback} decay=${decay} excludeTimeOff(default)=${settings.fairnessExcludeTimeOff}\n`);

  const { data: rows } = await supabase.from('schedules').select('week_start, data')
    .eq('company_id', COMPANY_ID).lt('week_start', weekStart)
    .is('deleted_at', null).is('superseded_by', null).not('published_at', 'is', null)
    .order('week_start', { ascending: false }).order('published_at', { ascending: false }).limit(lookback * 4);
  const seen = new Set<string>(); const weekStarts: string[] = []; const weeks: PriorWeekHours[] = [];
  for (const row of (rows ?? []) as Array<{ week_start: string; data: { assignments?: Array<{ employee_id?: string; hours?: number }> } | null }>) {
    if (seen.has(row.week_start)) continue; seen.add(row.week_start);
    const h = new Map<string, number>();
    for (const a of row.data?.assignments ?? []) if (a.employee_id && typeof a.hours === 'number') h.set(a.employee_id, (h.get(a.employee_id) ?? 0) + a.hours);
    weeks.push({ hoursByEmp: h, toEmps: new Set() }); weekStarts.push(row.week_start);
    if (weeks.length >= lookback) break;
  }
  const oldest = weekStarts[weekStarts.length - 1] ?? weekStart;
  const { data: toRows } = await supabase.from('time_off_requests').select('employee_id, start_date, end_date')
    .eq('company_id', COMPANY_ID).eq('status', 'approved').eq('time_off_type', 'full_day')
    .lte('start_date', weekStart).gte('end_date', oldest);
  for (let i = 0; i < weeks.length; i++) {
    const ws = weekStarts[i], we = addDaysISO(ws, 6);
    for (const t of (toRows ?? []) as Array<{ employee_id: string; start_date: string; end_date: string }>)
      if (t.start_date <= we && t.end_date >= ws) weeks[i].toEmps.add(t.employee_id);
  }

  const OFF = foldPriorHours(weeks, decay, false);
  const ON = foldPriorHours(weeks, decay, true);
  const { data: emps } = await supabase.from('employees').select('id, name, primary_role').eq('company_id', COMPANY_ID).eq('active', true);
  const nameOf = new Map((emps ?? []).map((e: Pick<Employee, 'id' | 'name'>) => [e.id, e.name]));
  const ids = new Set<string>([...OFF.keys(), ...ON.keys()]);
  const rowsOut = [...ids].map(id => ({ name: nameOf.get(id) ?? id, off: +(OFF.get(id) ?? 0).toFixed(1), on: +(ON.get(id) ?? 0).toFixed(1) }))
    .sort((a, b) => (b.on - b.off) - (a.on - a.off));
  console.log('name                      memory OFF ->  ON     delta (rise = was on leave)');
  for (const r of rowsOut) {
    const d = +(r.on - r.off).toFixed(1);
    console.log(`  ${r.name.padEnd(22)} ${String(r.off).padStart(7)} -> ${String(r.on).padStart(6)}  ${String(d).padStart(6)}${d >= 0.1 ? '  <-- imputed (time off)' : ''}`);
  }
}
main().then(() => process.exit(0)).catch(e => { console.error('dry-run failed:', e); process.exit(1); });
