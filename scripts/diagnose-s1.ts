/**
 * One-off diagnostic for ENGINE-1 (S1). READ-ONLY.
 * - PART 1: print every shift_requirements + shift_types row; flag time disagreements.
 * - PART 2: trace availability failures for the 5 availability_mismatch employees;
 *           print exact failing boundary per slot; tally the 21:15 vs other boundary.
 */
import { supabase } from '../src/db/client';
import { parseConstraints } from '../src/lib/constraints/parser';
import { getWeekBounds } from '../src/lib/engine/week-bounds';
import { resolveAvailabilityForWeek } from '../src/lib/custom-availability';
import { buildTOMap } from '../src/lib/to-window';
import { buildCanvas } from '../src/lib/engine/canvas';
import {
  isAvailableForShift,
} from '../src/lib/engine/eligibility';
import type {
  Employee,
  Availability,
  CustomAvailability,
  PartialDayDetail,
  ShiftType,
  ShiftRequirement,
  Policy,
} from '../src/db/types';

const COMPANY_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

const FOCUS_NAMES = [
  'Kori Baumann',
  'Ally Becker',
  'Erin Berigan',
  'Michael McCorkle',
  'Letizia Cumbo-Nacheli',
];

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

const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function hhmm(t: string): string {
  return t.slice(0, 5);
}

async function main() {
  // ── PART 1: shift_requirements + shift_types + disagreement flags ────────
  console.log('================================================================');
  console.log('PART 1 — Shift time sources');
  console.log('================================================================\n');

  const [stRes, reqRes] = await Promise.all([
    supabase.from('shift_types').select('*').eq('company_id', COMPANY_ID).order('start_time'),
    supabase.from('shift_requirements').select('*').eq('company_id', COMPANY_ID).order('shift_name'),
  ]);
  const shiftTypes = (stRes.data ?? []) as ShiftType[];
  const shiftRequirements = (reqRes.data ?? []) as ShiftRequirement[];

  console.log('--- shift_types ---');
  console.log('id'.padEnd(38), 'name'.padEnd(22), 'start    end      active  days_active');
  for (const st of shiftTypes) {
    const days = st.days_active.map((d: number) => DOW_LABEL[d]).join(',');
    console.log(
      st.id.padEnd(38),
      st.name.padEnd(22),
      hhmm(st.start_time), ' ', hhmm(st.end_time), ' ',
      String((st as { active?: boolean }).active ?? true).padEnd(5),
      days,
    );
  }

  console.log('\n--- shift_requirements ---');
  console.log('id'.padEnd(38), 'shift_name'.padEnd(22), 'role'.padEnd(12), 'req start    end      shift_type_id');
  for (const r of shiftRequirements) {
    console.log(
      r.id.padEnd(38),
      r.shift_name.padEnd(22),
      r.role.padEnd(12),
      String(r.required_count).padStart(3), ' ',
      hhmm(r.start_time), ' ', hhmm(r.end_time), ' ',
      r.shift_type_id ?? '<null>',
    );
  }

  console.log('\n--- time disagreement check: shift_requirements vs its shift_type ---');
  const stById = new Map(shiftTypes.map(st => [st.id, st]));
  const stByName = new Map(shiftTypes.map(st => [st.name, st]));
  let disagree = 0;
  for (const r of shiftRequirements) {
    const st = r.shift_type_id ? stById.get(r.shift_type_id) : stByName.get(r.shift_name);
    if (!st) {
      console.log(`  ORPHAN req ${r.id} (${r.shift_name}/${r.role}): no matching shift_type`);
      disagree++;
      continue;
    }
    const stStart = hhmm(st.start_time);
    const stEnd = hhmm(st.end_time);
    const rStart = hhmm(r.start_time);
    const rEnd = hhmm(r.end_time);
    if (stStart !== rStart || stEnd !== rEnd) {
      console.log(
        `  DISAGREE: ${r.shift_name}/${r.role} (req ${r.id})`,
        `\n    shift_type   ${st.name}: ${stStart}-${stEnd}`,
        `\n    requirement       :       ${rStart}-${rEnd}`,
      );
      disagree++;
    }
  }
  if (disagree === 0) console.log('  No disagreements — every requirement matches its shift_type on times.');

  // ── PART 2: 5 availability_mismatch employees — per-slot boundary trace ──
  console.log('\n================================================================');
  console.log('PART 2 — The 5 availability_mismatch employees');
  console.log('================================================================\n');

  // Load full build inputs so we can construct the same canvas the engine sees.
  const { data: policyRows } = await supabase
    .from('policies').select('*').eq('company_id', COMPANY_ID);
  const parsed = parseConstraints((policyRows ?? []) as Policy[]);
  const { weekStart, weekEnd } = getWeekBounds(1, parsed.settings.weekStartDay);
  const weekDates = getDatesInRange(weekStart, weekEnd);
  console.log(`Build week: ${weekStart} .. ${weekEnd}\n`);

  const [empRes, availRes, toRes, cavailRes] = await Promise.all([
    supabase.from('employees').select('*').eq('company_id', COMPANY_ID).eq('active', true),
    supabase.from('availability').select('*').eq('company_id', COMPANY_ID),
    supabase.from('time_off_requests')
      .select('employee_id, start_date, end_date, time_off_type, partial_days')
      .eq('company_id', COMPANY_ID).eq('status', 'approved')
      .lte('start_date', weekEnd).gte('end_date', weekStart),
    supabase.from('custom_availability').select('*').eq('company_id', COMPANY_ID).eq('active', true),
  ]);

  const employees = (empRes.data ?? []) as Employee[];
  const availability = (availRes.data ?? []) as Availability[];
  const availByEmp = new Map<string, Availability[]>();
  for (const a of availability) {
    if (!availByEmp.has(a.employee_id)) availByEmp.set(a.employee_id, []);
    availByEmp.get(a.employee_id)!.push(a);
  }
  const customByEmp: Record<string, CustomAvailability> = {};
  for (const c of (cavailRes.data ?? []) as CustomAvailability[]) {
    if (!customByEmp[c.employee_id]) customByEmp[c.employee_id] = c;
  }
  for (const emp of employees) {
    const custom = customByEmp[emp.id] ?? null;
    if (!custom) continue;
    const normal = availByEmp.get(emp.id) ?? [];
    const resolved = resolveAvailabilityForWeek(emp, weekStart, weekEnd, normal, custom);
    if (resolved !== normal) availByEmp.set(emp.id, resolved);
  }
  void buildTOMap(weekDates, (toRes.data ?? []) as Array<{
    employee_id: string; start_date: string; end_date: string;
    time_off_type: 'full_day' | 'partial' | null;
    partial_days: PartialDayDetail[] | null;
  }>);

  const { slots: canvas } = buildCanvas(weekDates, shiftTypes, shiftRequirements, []);
  console.log(`canvas slots: ${canvas.length}\n`);

  // Tally which boundary causes failure across all 5 × all slots they're
  // qualified for. Bucketed: start-fail (avail starts after slot starts) vs
  // end-fail (avail ends before slot ends), with the specific failing
  // boundary recorded.
  type FailRow = {
    employee: string;
    date: string;
    dow: string;
    shift_name: string;
    role: string;
    slot_start: string;
    slot_end: string;
    avail_rows: string;
    boundary: 'no_dow_row' | 'start_late' | 'end_early' | 'both' | 'ok';
  };
  const fails: FailRow[] = [];

  for (const targetName of FOCUS_NAMES) {
    const emp = employees.find(e => e.name === targetName);
    if (!emp) {
      console.log(`### ${targetName} — NOT FOUND in active employees`);
      continue;
    }
    console.log(`### ${emp.name}`);
    console.log(`    id=${emp.id}`);
    console.log(`    primary_role=${emp.primary_role}`);
    console.log(`    qualified_roles=${JSON.stringify(emp.qualified_roles)}`);
    console.log(`    max_weekly_hours=${emp.max_weekly_hours}`);
    const avail = availByEmp.get(emp.id) ?? [];
    if (avail.length === 0) {
      console.log('    availability: NONE');
    } else {
      console.log('    availability:');
      for (const a of [...avail].sort((x, y) => x.day_of_week - y.day_of_week || x.start_time.localeCompare(y.start_time))) {
        console.log(`       dow=${a.day_of_week} (${DOW_LABEL[a.day_of_week]}) ${hhmm(a.start_time)}-${hhmm(a.end_time)}`);
      }
    }
    console.log('');

    // Per-qualified-slot failure trace.
    const qualifiedSlots = canvas.filter(s => emp.qualified_roles.includes(s.role));
    console.log(`    qualified slots in this canvas: ${qualifiedSlots.length}`);

    for (const slot of qualifiedSlots) {
      const dow = new Date(`${slot.date}T12:00:00Z`).getUTCDay();
      const dayRows = avail.filter(a => a.day_of_week === dow);
      const slotStart = hhmm(slot.start_time);
      const slotEnd = hhmm(slot.end_time);
      const availSummary = dayRows.length === 0
        ? 'no-row-for-dow'
        : dayRows.map(a => `${hhmm(a.start_time)}-${hhmm(a.end_time)}`).join(',');

      if (isAvailableForShift(emp, slot, availByEmp)) continue;

      let boundary: FailRow['boundary'];
      if (dayRows.length === 0) {
        boundary = 'no_dow_row';
      } else {
        // Determine which boundary fails for the best-fitting row.
        let startLate = true;
        let endEarly = true;
        for (const a of dayRows) {
          const as = hhmm(a.start_time);
          const ae = hhmm(a.end_time);
          if (as <= slotStart) startLate = false;
          if (ae >= slotEnd) endEarly = false;
        }
        boundary = startLate && endEarly ? 'both' : startLate ? 'start_late' : endEarly ? 'end_early' : 'ok';
      }

      fails.push({
        employee: emp.name,
        date: slot.date,
        dow: DOW_LABEL[dow],
        shift_name: slot.shift_name,
        role: slot.role,
        slot_start: slotStart,
        slot_end: slotEnd,
        avail_rows: availSummary,
        boundary,
      });
    }
    console.log('');
  }

  // Print per-employee failure detail.
  console.log('--- per-slot availability failures (qualified slot, isAvailableForShift=false) ---');
  for (const targetName of FOCUS_NAMES) {
    const rows = fails.filter(f => f.employee === targetName);
    console.log(`\n${targetName}: ${rows.length} failing slots`);
    for (const f of rows) {
      let msg = '';
      if (f.boundary === 'no_dow_row') {
        msg = `no availability row for ${f.dow}`;
      } else if (f.boundary === 'start_late') {
        msg = `availStart > slotStart (${f.avail_rows} vs slot ${f.slot_start}-${f.slot_end})`;
      } else if (f.boundary === 'end_early') {
        msg = `availEnd < slotEnd (${f.avail_rows} vs slot ${f.slot_start}-${f.slot_end})`;
      } else if (f.boundary === 'both') {
        msg = `both boundaries fail (${f.avail_rows} vs slot ${f.slot_start}-${f.slot_end})`;
      } else {
        msg = `ok (this row should not be here — inspect)`;
      }
      console.log(`  ${f.date} ${f.dow} ${f.shift_name.padEnd(18)} ${f.role.padEnd(10)} -> ${msg}`);
    }
  }

  // Tally: same-boundary classification.
  console.log('\n--- failure-boundary tally across the 5 employees ---');
  const buckets = {
    'end_early @ 21:15 specifically': 0,
    'end_early other end-time': 0,
    'start_late': 0,
    'both boundaries': 0,
    'no_dow_row': 0,
  };
  const empFailedOn2115 = new Set<string>();
  const empFailedOnOtherEnd = new Set<string>();
  const empFailedOnStartLate = new Set<string>();
  const empFailedOnNoDow = new Set<string>();
  for (const f of fails) {
    if (f.boundary === 'end_early' && f.slot_end === '21:15') {
      buckets['end_early @ 21:15 specifically']++;
      empFailedOn2115.add(f.employee);
    } else if (f.boundary === 'end_early') {
      buckets['end_early other end-time']++;
      empFailedOnOtherEnd.add(f.employee);
    } else if (f.boundary === 'start_late') {
      buckets['start_late']++;
      empFailedOnStartLate.add(f.employee);
    } else if (f.boundary === 'both') {
      buckets['both boundaries']++;
    } else if (f.boundary === 'no_dow_row') {
      buckets['no_dow_row']++;
      empFailedOnNoDow.add(f.employee);
    }
  }
  for (const [k, v] of Object.entries(buckets)) {
    console.log(`  ${k.padEnd(36)} : ${v} slot-failures`);
  }
  console.log(`\n  distinct employees affected by 21:15-end mismatch:        ${empFailedOn2115.size} (${Array.from(empFailedOn2115).join(', ')})`);
  console.log(`  distinct employees affected by other end-time mismatch:    ${empFailedOnOtherEnd.size} (${Array.from(empFailedOnOtherEnd).join(', ')})`);
  console.log(`  distinct employees affected by start-late mismatch:        ${empFailedOnStartLate.size} (${Array.from(empFailedOnStartLate).join(', ')})`);
  console.log(`  distinct employees affected by no-dow-row mismatch:        ${empFailedOnNoDow.size} (${Array.from(empFailedOnNoDow).join(', ')})`);
}

main().catch(err => { console.error(err); process.exit(1); });
