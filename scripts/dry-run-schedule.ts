/**
 * One-off engine dry-run.
 *
 * Loads live Watermark data, runs the schedule engine in-memory, and writes
 * the result to a local JSON file. No database writes, no SMS sends.
 *
 * Run: npx ts-node --skip-project scripts/dry-run-schedule.ts
 */

import * as fs from 'fs';
import { supabase } from '../src/db/client';
import { parseConstraints } from '../src/lib/constraints/parser';
import type { EngineSettings, AttributeMixConstraint } from '../src/lib/constraints/types';
import { getWeekBounds } from '../src/lib/engine/week-bounds';
import { buildCanvas } from '../src/lib/engine/canvas';
import {
  buildEligibility,
  isAvailableForShift as engineIsAvailable,
  isBlockedByTOForSlot,
  isVeteranOnlyDate as engineIsVeteranOnlyDate,
  type VeteranOnlyRange,
} from '../src/lib/engine/eligibility';
import { rankCandidates } from '../src/lib/engine/ranker';
import { resolveBannedPairConflict } from '../src/lib/engine/cascade';
import { enforceAttributeMixForShift } from '../src/lib/engine/attribute-mix';
import type { CanvasSlot, WeekState } from '../src/lib/engine/types';
import { resolveAvailabilityForWeek } from '../src/lib/custom-availability';
import { buildTOMap, type TOWindow } from '../src/lib/to-window';
import { getSpecialNotesForRange } from '../src/workflows/special-notes';
import { computeWageEstimate } from '../src/lib/schedule-simulator';
import {
  ENGINE_VERSION,
  type ScheduleAssignment,
  type ScheduleGap,
  type FlaggedIssue,
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
  Event,
} from '../src/db/types';

// ── Hardcoded inputs ─────────────────────────────────────────────────────────

const COMPANY_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const TARGET_WEEK: 'this' | 'next' = 'next';
const OUTPUT_FILE = './dry-run-output.json';

// ── Build-data types (mirrored from src/workflows/schedule-build.ts) ─────────

interface BuildData {
  employees: Employee[];
  availByEmp: Map<string, Availability[]>;
  toMap: Map<string, TOWindow>;
  shiftTypes: ShiftType[];
  shiftRequirements: ShiftRequirement[];
  conflicts: EmployeeConflict[];
  policies: Policy[];
  events: Event[];
  companyName: string;
  companyTimezone: string;
}

// ── Local helpers (mirrored from src/workflows/schedule-build.ts) ────────────

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
  const offset = target === 'this' ? 0 : 1;
  return getWeekBounds(offset, settings.weekStartDay);
}

function formatWeekday(d: string): string {
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' });
}

function parseVeteranPreference(pref: string | null): VeteranMode {
  if (!pref) return null;
  const lower = pref.toLowerCase();
  if (lower.includes('at least one') || lower.includes('at least 1')) return 'at_least_one';
  if (lower.includes('only')) return 'only';
  if (lower.includes('prioritize') || lower.includes('prefer')) return 'prioritize';
  return null;
}

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

// ── Data load (mirrored from src/workflows/schedule-build.ts) ────────────────

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

// ── DUPLICATED ENGINE CORE ───────────────────────────────────────────────────
// The functions below (computeGapReason, hasHardBannedPair, buildScheduleForWeek)
// are deliberate copies of the production engine in src/workflows/schedule-build.ts.
// They must stay byte-identical in behavior. Any future change to those
// production functions MUST be mirrored here, or the dry-run will drift from
// what production produces.

interface GapReasonInput {
  slot: CanvasSlot;
  employees: Employee[];
  availByEmp: Map<string, Availability[]>;
  toMap: Map<string, TOWindow>;
  veteranOnlyDates: VeteranOnlyRange[];
  weekState: WeekState;
  shiftAssignmentIds: string[];
  conflicts: EmployeeConflict[];
}

function computeGapReason(input: GapReasonInput): string {
  const { slot, employees, availByEmp, toMap, veteranOnlyDates, weekState, shiftAssignmentIds, conflicts } = input;

  const vetOnly = engineIsVeteranOnlyDate(slot.date, veteranOnlyDates);
  const pool = vetOnly ? employees.filter(e => e.is_veteran) : employees;

  const qualified = pool.filter(e => e.qualified_roles.includes(slot.role));
  if (qualified.length === 0) {
    return vetOnly
      ? `No veteran employees are qualified for the ${slot.role} role on this veteran-only date`
      : `No active employees are qualified for the ${slot.role} role`;
  }

  const available = qualified.filter(e => engineIsAvailable(e, slot, availByEmp));
  if (available.length === 0) {
    return `All qualified employees are unavailable on ${formatWeekday(slot.date)}`;
  }

  const notOnTO = available.filter(e => !isBlockedByTOForSlot(e, slot, toMap));
  if (notOnTO.length === 0) {
    return `All qualified employees have approved time off on ${slot.date}`;
  }

  const withinHours = notOnTO.filter(
    e => (weekState.weeklyHoursMap.get(e.id) ?? 0) + slot.hours <= e.max_weekly_hours
  );
  if (withinHours.length === 0) {
    return 'All qualified employees are at their maximum weekly hours';
  }

  const banned = new Set<string>();
  for (const assignedId of shiftAssignmentIds) {
    for (const c of conflicts) {
      if (c.severity !== 'never') continue;
      if (c.employee_id_1 === assignedId) banned.add(c.employee_id_2);
      else if (c.employee_id_2 === assignedId) banned.add(c.employee_id_1);
    }
  }
  const noConflict = withinHours.filter(e => !banned.has(e.id) && !shiftAssignmentIds.includes(e.id));
  if (noConflict.length === 0) {
    return 'All qualified employees have hard conflicts with already-assigned staff';
  }

  return 'No qualified employee could be assigned';
}

function hasHardBannedPair(
  empId: string,
  cohabIds: string[],
  conflicts: EmployeeConflict[]
): boolean {
  for (const other of cohabIds) {
    for (const c of conflicts) {
      if (c.severity !== 'never') continue;
      if (
        (c.employee_id_1 === empId && c.employee_id_2 === other) ||
        (c.employee_id_2 === empId && c.employee_id_1 === other)
      ) return true;
    }
  }
  return false;
}

interface BuildContext {
  data: BuildData;
  weekDates: string[];
  eventsByDate: Map<string, Event[]>;
  veteranMode: VeteranMode;
  veteranOnlyDates: VeteranOnlyRange[];
  settings: EngineSettings;
  attributeMix: AttributeMixConstraint[];
}

interface BuildResult {
  assignments: ScheduleAssignment[];
  gaps: ScheduleGap[];
  flagged_issues: FlaggedIssue[];
  totalRequired: number;
  totalFilled: number;
}

function buildScheduleForWeek(ctx: BuildContext): BuildResult {
  const { data, weekDates, eventsByDate, veteranMode, veteranOnlyDates, settings, attributeMix } = ctx;
  const employeeById = new Map(data.employees.map(e => [e.id, e]));

  const overriddenReqs: ShiftRequirement[] = [];
  for (const date of weekDates) {
    const dayOfWeek = new Date(date + 'T12:00:00Z').getUTCDay();
    const dateNotes = eventsByDate.get(date) ?? [];
    for (const st of data.shiftTypes) {
      if (!st.days_active.includes(dayOfWeek)) continue;
      const baseReqs = data.shiftRequirements.filter(req =>
        (req.shift_type_id ? req.shift_type_id === st.id : req.shift_name === st.name) &&
        req.days_active.includes(dayOfWeek)
      );
      const adjusted = applyShiftOverrides(baseReqs, dateNotes, st.name);
      for (const r of adjusted) {
        overriddenReqs.push({ ...r, days_active: [dayOfWeek] });
      }
    }
  }

  const allEvents: Event[] = [];
  for (const list of eventsByDate.values()) allEvents.push(...list);
  const canvas = buildCanvas(weekDates, data.shiftTypes, overriddenReqs, allEvents);

  const weekState: WeekState = {
    weeklyHoursMap: new Map(),
    assignmentsByDate: new Map(),
    assignments: [],
    gaps: [],
    flagged_issues: [],
  };

  const totalRequired = canvas.length;
  let totalFilled = 0;

  const gapByReqId = new Map<string, ScheduleGap>();

  for (const slot of canvas) {
    const dayPool = buildEligibility(slot, data.employees, data.availByEmp, data.toMap, veteranOnlyDates);

    const shiftAssignmentIds = weekState.assignments
      .filter(a => a.date === slot.date && a.shift_name === slot.shift_name)
      .map(a => a.employee_id);
    const todayIds = weekState.assignmentsByDate.get(slot.date) ?? [];

    const slotEligible = dayPool.employees.filter(e => {
      if (shiftAssignmentIds.includes(e.id)) return false;
      if (settings.doublesPolicy === 'never' && todayIds.includes(e.id)) return false;
      if ((weekState.weeklyHoursMap.get(e.id) ?? 0) + slot.hours > e.max_weekly_hours) return false;
      if (hasHardBannedPair(e.id, shiftAssignmentIds, data.conflicts)) return false;
      return true;
    });

    let chosen: Employee | null = null;

    if (slotEligible.length > 0) {
      const ranked = rankCandidates(slotEligible, slot, weekState, data.conflicts, settings, veteranMode);
      chosen = ranked[0] ?? null;
    } else {
      const blockedByConflictOnly = dayPool.employees.filter(e => {
        if (shiftAssignmentIds.includes(e.id)) return false;
        if (settings.doublesPolicy === 'never' && todayIds.includes(e.id)) return false;
        if ((weekState.weeklyHoursMap.get(e.id) ?? 0) + slot.hours > e.max_weekly_hours) return false;
        return hasHardBannedPair(e.id, shiftAssignmentIds, data.conflicts);
      });

      for (const candidate of blockedByConflictOnly) {
        const partnerIdx = weekState.assignments.findIndex(a => {
          if (!(a.date === slot.date && a.shift_name === slot.shift_name)) return false;
          for (const c of data.conflicts) {
            if (c.severity !== 'never') continue;
            if (
              (c.employee_id_1 === candidate.id && c.employee_id_2 === a.employee_id) ||
              (c.employee_id_2 === candidate.id && c.employee_id_1 === a.employee_id)
            ) return true;
          }
          return false;
        });
        if (partnerIdx < 0) continue;

        const op = resolveBannedPairConflict(
          slot,
          candidate,
          partnerIdx,
          weekState,
          {
            employees: data.employees,
            employeeById,
            availByEmp: data.availByEmp,
            toMap: data.toMap,
            conflicts: data.conflicts,
            veteranOnlyDates,
            canvasSlots: canvas,
          }
        );
        if (op) {
          for (const m of op.moves) {
            const prev = weekState.assignments[m.assignment_index];
            const prevSlot = canvas.find(
              s => s.date === prev.date && s.shift_name === prev.shift_name && s.role === prev.role
            );
            if (!prevSlot) continue;
            const movedInEmp = employeeById.get(m.new_employee_id);
            if (!movedInEmp) continue;
            weekState.weeklyHoursMap.set(
              prev.employee_id,
              (weekState.weeklyHoursMap.get(prev.employee_id) ?? 0) - prevSlot.hours
            );
            weekState.weeklyHoursMap.set(
              movedInEmp.id,
              (weekState.weeklyHoursMap.get(movedInEmp.id) ?? 0) + prevSlot.hours
            );
            const dayIds = weekState.assignmentsByDate.get(prev.date) ?? [];
            weekState.assignmentsByDate.set(
              prev.date,
              dayIds.filter(id => id !== prev.employee_id).concat(movedInEmp.id)
            );
            weekState.assignments[m.assignment_index] = {
              ...prev,
              employee_id: movedInEmp.id,
              employee_name: movedInEmp.name,
            };
          }
          chosen = candidate;
          break;
        }
      }
    }

    if (chosen) {
      totalFilled++;
      weekState.weeklyHoursMap.set(chosen.id, (weekState.weeklyHoursMap.get(chosen.id) ?? 0) + slot.hours);
      const dayIds = weekState.assignmentsByDate.get(slot.date) ?? [];
      dayIds.push(chosen.id);
      weekState.assignmentsByDate.set(slot.date, dayIds);
      weekState.assignments.push({
        date: slot.date,
        employee_id: chosen.id,
        employee_name: chosen.name,
        shift_name: slot.shift_name,
        role: slot.role,
        start_time: slot.start_time,
        end_time: slot.end_time,
        hours: slot.hours,
      });
    } else {
      const reason = computeGapReason({
        slot,
        employees: data.employees,
        availByEmp: data.availByEmp,
        toMap: data.toMap,
        veteranOnlyDates,
        weekState,
        shiftAssignmentIds,
        conflicts: data.conflicts,
      });
      const key = `${slot.date}|${slot.shift_requirement_id}`;
      const existing = gapByReqId.get(key);
      if (existing) {
        existing.required_count++;
      } else {
        const gap: ScheduleGap = {
          date: slot.date,
          shift_name: slot.shift_name,
          role: slot.role,
          required_count: 1,
          filled_count: 0,
          reason,
          start_time: slot.start_time,
          end_time: slot.end_time,
        };
        gapByReqId.set(key, gap);
        weekState.gaps.push(gap);
      }
    }
  }

  const shiftGroups = new Map<string, { date: string; shift_name: string; shift_type_id: string; indices: number[] }>();
  for (let i = 0; i < weekState.assignments.length; i++) {
    const a = weekState.assignments[i];
    const key = `${a.date}|${a.shift_name}`;
    const slotForA = canvas.find(s => s.date === a.date && s.shift_name === a.shift_name);
    if (!shiftGroups.has(key)) {
      shiftGroups.set(key, {
        date: a.date,
        shift_name: a.shift_name,
        shift_type_id: slotForA?.shift_type_id ?? '',
        indices: [],
      });
    }
    shiftGroups.get(key)!.indices.push(i);
  }

  const attrDeps = {
    employees: data.employees,
    employeeById,
    availByEmp: data.availByEmp,
    toMap: data.toMap,
    conflicts: data.conflicts,
    veteranOnlyDates,
    canvasSlots: canvas,
    settings,
  };

  for (const group of shiftGroups.values()) {
    const shiftAssigns = group.indices.map(i => weekState.assignments[i]);
    const result = enforceAttributeMixForShift(
      shiftAssigns,
      group.indices,
      attributeMix,
      { date: group.date, shift_type_id: group.shift_type_id, shift_name: group.shift_name },
      undefined,
      weekState,
      attrDeps
    );
    if (result.flagged) {
      weekState.flagged_issues.push(result.flagged);
    }
  }

  if (veteranMode === 'at_least_one' || veteranMode === 'only') {
    for (const group of shiftGroups.values()) {
      const indices = group.indices;
      if (indices.length === 0) continue;
      const hasVet = indices.some(i => employeeById.get(weekState.assignments[i].employee_id)?.is_veteran);
      const need = veteranMode === 'only' ? indices.length : 1;
      const currentVets = indices.filter(i => employeeById.get(weekState.assignments[i].employee_id)?.is_veteran).length;
      if (currentVets >= need) continue;
      if (veteranMode === 'at_least_one' && hasVet) continue;

      const placedVets: Set<string> = new Set(
        indices.map(i => weekState.assignments[i].employee_id).filter(id => employeeById.get(id)?.is_veteran)
      );
      let stillNeed = need - currentVets;

      const sortedNonVet = [...indices]
        .filter(i => !employeeById.get(weekState.assignments[i].employee_id)?.is_veteran)
        .sort((a, b) => {
          const ha = weekState.weeklyHoursMap.get(weekState.assignments[a].employee_id) ?? 0;
          const hb = weekState.weeklyHoursMap.get(weekState.assignments[b].employee_id) ?? 0;
          return ha - hb;
        });

      for (const idx of sortedNonVet) {
        if (stillNeed <= 0) break;
        const cur = weekState.assignments[idx];
        const slot = canvas.find(s => s.date === cur.date && s.shift_name === cur.shift_name && s.role === cur.role);
        if (!slot) continue;
        const elig = buildEligibility(slot, data.employees, data.availByEmp, data.toMap, veteranOnlyDates);
        const cohabIds = indices.filter(i => i !== idx).map(i => weekState.assignments[i].employee_id);
        const candidate = elig.employees.find(e => {
          if (!e.is_veteran) return false;
          if (placedVets.has(e.id)) return false;
          if (cohabIds.includes(e.id)) return false;
          if (hasHardBannedPair(e.id, cohabIds, data.conflicts)) return false;
          if ((weekState.weeklyHoursMap.get(e.id) ?? 0) + slot.hours > e.max_weekly_hours) return false;
          return true;
        });
        if (!candidate) continue;

        const prevId = cur.employee_id;
        weekState.weeklyHoursMap.set(prevId, (weekState.weeklyHoursMap.get(prevId) ?? 0) - slot.hours);
        weekState.weeklyHoursMap.set(candidate.id, (weekState.weeklyHoursMap.get(candidate.id) ?? 0) + slot.hours);
        const dayIds = weekState.assignmentsByDate.get(cur.date) ?? [];
        weekState.assignmentsByDate.set(cur.date, dayIds.filter(id => id !== prevId).concat(candidate.id));
        weekState.assignments[idx] = { ...cur, employee_id: candidate.id, employee_name: candidate.name };
        placedVets.add(candidate.id);
        stillNeed--;
      }

      if (stillNeed > 0 && veteranMode === 'at_least_one') {
        weekState.flagged_issues.push({
          type: 'unsatisfied_attribute_mix',
          date: group.date,
          shift_name: group.shift_name,
          description: `No veteran could be assigned to ${group.shift_name} on ${group.date}`,
          metadata: { attribute: 'is_veteran', value: 'true', required: 1, actual: 0 },
        });
      }
    }
  }

  for (const gap of weekState.gaps) {
    gap.filled_count = weekState.assignments.filter(
      a => a.date === gap.date && a.shift_name === gap.shift_name && a.role === gap.role
    ).length;
  }

  return {
    assignments: weekState.assignments,
    gaps: weekState.gaps,
    flagged_issues: weekState.flagged_issues,
    totalRequired,
    totalFilled,
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

  const eventsByDate = new Map<string, Event[]>();
  for (const date of weekDates) {
    eventsByDate.set(date, specialNotes.filter(e =>
      (e.date ?? '') <= date && (e.end_date ?? e.date ?? '') >= date
    ));
  }

  const veteranMode: VeteranMode = parsed.settings.veteranPreferenceDefault === 'none'
    ? null
    : (parsed.settings.veteranPreferenceDefault as VeteranMode);
  const veteranOnlyDates: VeteranOnlyRange[] = [];

  console.log('[dry-run] Building canvas...');
  const { assignments, gaps, flagged_issues, totalRequired, totalFilled } = buildScheduleForWeek({
    data,
    weekDates,
    eventsByDate,
    veteranMode,
    veteranOnlyDates,
    settings: parsed.settings,
    attributeMix: parsed.hard.attributeMix,
  });
  console.log(`[dry-run] Canvas has ${totalRequired} slots`);
  console.log('[dry-run] Running engine...');
  console.log(`[dry-run] Assignments: ${totalFilled} / ${totalRequired} filled, ${gaps.length} gaps, ${flagged_issues.length} flagged issues`);

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
    assignments_by_day: assignmentsByDay,
    gaps_detail: gaps,
    flagged_issues_detail: flagged_issues,
    weekly_hours_by_employee: weeklyHoursByEmployee,
    wage_estimate: {
      total_estimated: wages.total_estimated,
      top_5_by_pay: top5ByPay,
    },
  };

  // Silence the unused-import warning for parseVeteranPreference — it mirrors
  // the production handler's signature but the dry-run does not consume a
  // user-supplied veteran_preference string. Reference it so the import isn't
  // dead.
  void parseVeteranPreference;

  console.log(`[dry-run] Writing output to ${OUTPUT_FILE}`);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log('[dry-run] Done. Read the file to review the proposed schedule.');
}

dryRun().catch(err => {
  console.error('[dry-run] Failed:', err);
  process.exit(1);
});
