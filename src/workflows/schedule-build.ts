import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { reply, sendInThreadAck } from '../messaging/reply';
import { sendEmail } from '../messaging/email';
import { greeting } from '../messaging/greeting';
import { isAlreadyDistributed } from '../lib/distribute-guard';
import { sendSms } from '../messaging/sms';
import { computeWageEstimate } from '../lib/schedule-simulator';
import { buildScheduleResultEmail } from './schedule-build-email';
import { resolveAvailabilityForWeek } from '../lib/custom-availability';
import { buildTOMap, isBlockedByTO, type TOWindow } from '../lib/to-window';
import { getSpecialNotesForRange } from './special-notes';
import { parseConstraints } from '../lib/constraints/parser';
import type {
  EngineSettings,
  AttributeMixConstraint,
  ConcurrentCoverageConstraint,
} from '../lib/constraints/types';
import { getWeekBounds } from '../lib/engine/week-bounds';
import { buildCanvas } from '../lib/engine/canvas';
import {
  buildEligibility,
  consecutiveDaysRunIncluding,
  isAvailableForShift as engineIsAvailable,
  isBlockedByTOForSlot,
  isVeteranOnlyDate as engineIsVeteranOnlyDate,
  sameDayDoubleReason,
  type VeteranOnlyRange,
} from '../lib/engine/eligibility';
import { rankCandidates } from '../lib/engine/ranker';
import { resolveBannedPairConflict } from '../lib/engine/cascade';
import { buildAttributeShortageReason, enforceAttributeMixForShift } from '../lib/engine/attribute-mix';
import { veteranTargetsForGroup, type EngineExperienceRule } from '../lib/engine/experience-rules';
import { evaluateSexCoverage } from '../lib/engine/sex-coverage';
import {
  classifyEmployeeForSlot,
  formatDispositionList,
  type EmployeeDisposition,
} from '../lib/engine/dispositions';
import type { ClosedDate } from '../lib/engine/canvas';
import type { CanvasSlot, WeekState } from '../lib/engine/types';
import type { InboundMessage, VerifiedContact } from '../security/types';
import type {
  Employee,
  Availability,
  CustomAvailability,
  PartialDayDetail,
  ShiftType,
  ShiftRequirement,
  ShiftExperienceRule,
  EmployeeConflict,
  Policy,
  Event,
} from '../db/types';

// Engine version stamped into staffing_report so we know which build core
// produced any given schedule row.
export const ENGINE_VERSION = '2.0.0';

// Activity-log action emitted when the engine successfully builds a schedule
// but the supabase insert fails. Surfaced separately from 'schedule_built' so
// monitoring / dashboards can alert specifically on save failures (where the
// manager will NOT receive the standard success summary).
export const SCHEDULE_BUILD_SAVE_FAILED = 'schedule_build_save_failed';

// ── Output types ──────────────────────────────────────────────────────────────

export interface ScheduleAssignment {
  date: string;
  employee_id: string;
  employee_name: string;
  shift_name: string;
  role: string;
  start_time: string;
  end_time: string;
  hours: number;
}

export interface ScheduleGap {
  date: string;
  shift_name: string;
  role: string;
  required_count: number;
  filled_count: number;
  // Short bucket string for backwards compatibility — the binding constraint
  // category. Stable across releases for any downstream that parses it.
  reason: string;
  // Manager-facing rich diagnostic naming every qualified candidate and the
  // reason each was not placed. Computed once per (date, shift_name, role)
  // gap-row, not per missed head.
  description: string;
  per_employee_dispositions: EmployeeDisposition[];
  start_time?: string;
  end_time?: string;
}

// FlaggedIssue is a discriminated union. The shift-scoped variant carries a
// `shift_name`; the concurrent-coverage variant carries a time window in its
// metadata instead and has no shift_name (a coverage gap can straddle shifts).
export type FlaggedIssue =
  | {
      type: 'unsatisfied_attribute_mix';
      date: string;
      shift_name: string;
      description: string;
      metadata: Record<string, unknown>;
    }
  | {
      type: 'unsatisfied_sex_coverage';
      date: string;
      description: string;
      metadata: {
        time_window: { start: string; end: string };
        missing_sex: string;
        on_duty: Array<{ name: string; role: string; sex: string }>;
      };
    };

interface ScheduleData {
  assignments: ScheduleAssignment[];
  gaps: ScheduleGap[];
  flagged_issues?: FlaggedIssue[];
}

// ── Build data ────────────────────────────────────────────────────────────────

// Loaded shape shared between the production handler and the dry-run script.
// `events` is populated by the caller from special notes; the engine reads it
// during canvas build to apply shift overrides and route priority shifts.
export interface BuildData {
  employees: Employee[];
  availByEmp: Map<string, Availability[]>;
  toMap: Map<string, TOWindow>;
  shiftTypes: ShiftType[];
  shiftRequirements: ShiftRequirement[];
  conflicts: EmployeeConflict[];
  policies: Policy[];
  events: Event[];
  // Veteran/experience staffing rules. Optional so lightweight engine test
  // fixtures don't have to set it; production loaders always populate it.
  experienceRules?: EngineExperienceRule[];
  companyName: string;
  companyTimezone: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  extracted: Record<string, unknown>,
  settings: EngineSettings
): { weekStart: string; weekEnd: string } {
  const offset = extracted['target_week'] === 'this' ? 0 : 1;
  return getWeekBounds(offset, settings.weekStartDay);
}

function formatDisplayDate(d: string): string {
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function formatShortDate(d: string): string {
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatWeekday(d: string): string {
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' });
}

function formatTime(t: string): string {
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
}

// ── Veteran preference ────────────────────────────────────────────────────────

export type VeteranMode = 'only' | 'prioritize' | 'at_least_one' | null;

function parseVeteranPreference(pref: string | null): VeteranMode {
  if (!pref) return null;
  const lower = pref.toLowerCase();
  if (lower.includes('at least one') || lower.includes('at least 1')) return 'at_least_one';
  if (lower.includes('only')) return 'only';
  if (lower.includes('prioritize') || lower.includes('prefer')) return 'prioritize';
  return null;
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadBuildData(
  companyId: string,
  weekStart: string,
  weekEnd: string
): Promise<BuildData> {
  const [
    companyRes, empRes, availRes, toRes,
    stRes, reqRes, conflictRes, polRes, expRes,
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
    supabase.from('shift_experience_rules').select('*').eq('company_id', companyId).eq('active', true),
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

  const company = (companyRes.data as { name: string; timezone: string } | null);

  return {
    employees,
    availByEmp,
    toMap,
    shiftTypes: (stRes.data ?? []) as ShiftType[],
    shiftRequirements: (reqRes.data ?? []) as ShiftRequirement[],
    conflicts: (conflictRes.data ?? []) as EmployeeConflict[],
    policies: (polRes.data ?? []) as Policy[],
    events: [],
    experienceRules: ((expRes.data ?? []) as ShiftExperienceRule[]).map(r => ({
      shift_type_id: r.shift_type_id,
      days_of_week: r.days_of_week,
      role: r.role,
      mode: r.mode === 'all_veterans' ? 'all_veterans' as const : 'min_veterans' as const,
      min_count: r.min_count,
      season_start: r.season_start,
      season_end: r.season_end,
      active: r.active,
    })),
    companyName: company?.name ?? 'Your Company',
    companyTimezone: company?.timezone ?? 'America/New_York',
  };
}

// ── Shift override from special notes ─────────────────────────────────────────

export interface ShiftOverrideMismatch {
  date: string;
  shift_name: string;
  override_key: string;
  available_roles: string[];
}

function applyShiftOverrides(
  requirements: ShiftRequirement[],
  dateNotes: Event[],
  shiftTypeName: string,
  date: string,
  mismatches: ShiftOverrideMismatch[]
): ShiftRequirement[] {
  for (const note of dateNotes) {
    if (!note.shift_overrides) continue;
    const overrides = note.shift_overrides as Record<string, Record<string, number>>;
    const forShift = overrides[shiftTypeName];
    if (!forShift) continue;
    const availableRoles = requirements.map(r => r.role);
    for (const key of Object.keys(forShift)) {
      if (!availableRoles.includes(key)) {
        console.log(
          `[schedule-build] shift override key '${key}' on ${date} ${shiftTypeName} doesn't match any requirement role (available: ${availableRoles.join(',')})`
        );
        mismatches.push({
          date,
          shift_name: shiftTypeName,
          override_key: key,
          available_roles: [...availableRoles],
        });
      }
    }
    return requirements.map(req => {
      const count = forShift[req.role];
      return count !== undefined ? { ...req, required_count: count } : req;
    });
  }
  return requirements;
}

// ── Gap reason ────────────────────────────────────────────────────────────────

interface GapReasonInput {
  slot: CanvasSlot;
  employees: Employee[];
  availByEmp: Map<string, Availability[]>;
  toMap: Map<string, TOWindow>;
  veteranOnlyDates: VeteranOnlyRange[];
  weekState: WeekState;
  shiftAssignmentIds: string[];
  conflicts: EmployeeConflict[];
  settings: EngineSettings;
}

// Cites the binding constraint — the last hard filter that any candidate
// passed before reaching the empty pool. Walked in declared order so the
// caller can always trust the wording matches the actual binding rule.
function computeGapReason(input: GapReasonInput): string {
  const { slot, employees, availByEmp, toMap, veteranOnlyDates, weekState, shiftAssignmentIds, conflicts, settings } = input;

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

  // Same-day-doubles / hard overlap. Mirrors the slot-level filter order.
  const sameDayReasons = notOnTO.map(e => sameDayDoubleReason(e.id, slot, weekState, settings));
  const notDoubled = notOnTO.filter((_, i) => sameDayReasons[i] === null);
  if (notDoubled.length === 0) {
    const anyOverlap = sameDayReasons.some(r => r === 'already scheduled for an overlapping shift this day');
    return anyOverlap
      ? `All qualified employees are already scheduled for an overlapping shift on ${slot.date}`
      : `All qualified employees already have a shift on ${slot.date} and the company doubles policy doesn't allow another`;
  }

  const withinHours = notDoubled.filter(
    e => (weekState.weeklyHoursMap.get(e.id) ?? 0) + slot.hours <= e.max_weekly_hours
  );
  if (withinHours.length === 0) {
    return 'All qualified employees are at their maximum weekly hours';
  }

  // Hard banned-pair conflict with already-assigned staff on this shift.
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

// Pairs the short binding-reason string with a manager-facing rich
// description that names every qualified employee and the reason each was
// not placed. Reuses the shared classifier so the wording stays consistent
// with attribute-mix dispositions.
function buildGapDiagnostic(input: GapReasonInput): {
  short_reason: string;
  description: string;
  per_employee_dispositions: EmployeeDisposition[];
} {
  const short_reason = computeGapReason(input);
  const { slot, employees, availByEmp, toMap, veteranOnlyDates, weekState, conflicts, settings } = input;

  const vetOnly = engineIsVeteranOnlyDate(slot.date, veteranOnlyDates);
  const pool = (vetOnly ? employees.filter(e => e.is_veteran) : employees).filter(e => e.active);
  const qualified = pool.filter(e => e.qualified_roles.includes(slot.role));

  const head = `${slot.role} slot on ${slot.date} ${slot.shift_name} unfilled.`;

  if (qualified.length === 0) {
    const desc = vetOnly
      ? `${head} No veteran employees are qualified for the ${slot.role} role on this veteran-only date.`
      : `${head} No active employees are qualified for the ${slot.role} role.`;
    return { short_reason, description: desc, per_employee_dispositions: [] };
  }

  const assignedIds = new Set(
    weekState.assignments
      .filter(a => a.date === slot.date && a.shift_name === slot.shift_name)
      .map(a => a.employee_id)
  );

  const candidates = qualified.filter(e => !assignedIds.has(e.id));

  if (candidates.length === 0) {
    return {
      short_reason,
      description: `${head} All qualified employees are already assigned to this shift on this date.`,
      per_employee_dispositions: [],
    };
  }

  const dispositions: EmployeeDisposition[] = candidates.map(emp => ({
    employee_id: emp.id,
    name: emp.name,
    reason: classifyEmployeeForSlot(emp, {
      slot,
      acceptedRoles: new Set([slot.role]),
      assignedIds,
      weekState,
      deps: { employees, availByEmp, toMap, conflicts, settings },
    }),
  }));

  const total = dispositions.length;
  const grouped = formatDispositionList(dispositions);
  const description = `${head} ${total} employee${total === 1 ? '' : 's'} qualified for ${slot.role}: ${grouped}.`;
  return { short_reason, description, per_employee_dispositions: dispositions };
}

// ── Build core ────────────────────────────────────────────────────────────────

interface BuildContext {
  data: BuildData;
  weekDates: string[];
  eventsByDate: Map<string, Event[]>;
  veteranMode: VeteranMode;
  veteranOnlyDates: VeteranOnlyRange[];
  settings: EngineSettings;
  attributeMix: AttributeMixConstraint[];
  concurrentCoverage: ConcurrentCoverageConstraint[];
}

interface BuildResult {
  assignments: ScheduleAssignment[];
  gaps: ScheduleGap[];
  flagged_issues: FlaggedIssue[];
  closed_dates: ClosedDate[];
  shift_override_mismatches: ShiftOverrideMismatch[];
  totalRequired: number;
  totalFilled: number;
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

// New deterministic build core. Orchestrates canvas → eligibility → ranking
// → cascade resolution → post-fill enforcement. The previous engine
// (findBestEmployee, ensureVeteranOnShift, computeGapReason inline) is gone;
// behavior is driven entirely by parsed constraints and module outputs.
function buildScheduleForWeek(ctx: BuildContext): BuildResult {
  const { data, weekDates, eventsByDate, veteranMode, veteranOnlyDates, settings, attributeMix, concurrentCoverage } = ctx;
  const employeeById = new Map(data.employees.map(e => [e.id, e]));

  // 1) Build canvas (priority first, then chronological).
  // Apply shift-overrides from special notes to requirements before canvas build.
  // shift_requirements.days_active is dormant — only shift_types.days_active is
  // consulted. The shift_type gate below is the single source of truth.
  const overriddenReqs: ShiftRequirement[] = [];
  const shiftOverrideMismatches: ShiftOverrideMismatch[] = [];
  for (const date of weekDates) {
    const dayOfWeek = new Date(date + 'T12:00:00Z').getUTCDay();
    const dateNotes = eventsByDate.get(date) ?? [];
    for (const st of data.shiftTypes) {
      if (!st.days_active.includes(dayOfWeek)) continue;
      const baseReqs = data.shiftRequirements.filter(req =>
        (req.shift_type_id ? req.shift_type_id === st.id : req.shift_name === st.name)
      );
      const adjusted = applyShiftOverrides(baseReqs, dateNotes, st.name, date, shiftOverrideMismatches);
      for (const r of adjusted) {
        // Tag this requirement with the date so canvas can scope properly.
        overriddenReqs.push({ ...r, days_active: [dayOfWeek] });
      }
    }
  }

  // The canvas builder dedupes by (date, shift_type, requirement) — pass
  // a single union of overridden requirements scoped to each day-of-week.
  // Because canvas already filters by days_active, we don't double-apply.
  const allEvents: Event[] = [];
  for (const list of eventsByDate.values()) allEvents.push(...list);
  const { slots: canvas, closed_dates } = buildCanvas(weekDates, data.shiftTypes, overriddenReqs, allEvents);

  const weekState: WeekState = {
    weeklyHoursMap: new Map(),
    assignments: [],
    gaps: [],
    flagged_issues: [],
  };

  // Track required vs filled. required = sum of slot counts across canvas.
  // We compute totalRequired from canvas length.
  const totalRequired = canvas.length;
  let totalFilled = 0;

  // Track gaps by requirement so we increment a single ScheduleGap row per
  // (date, shift_name, requirement_id) instead of one per missed slot.
  const gapByReqId = new Map<string, ScheduleGap>();

  // 2-7) Visit each slot in fill order.
  for (const slot of canvas) {
    const dayPool = buildEligibility(slot, data.employees, data.availByEmp, data.toMap, veteranOnlyDates);

    const shiftAssignmentIds = weekState.assignments
      .filter(a => a.date === slot.date && a.shift_name === slot.shift_name)
      .map(a => a.employee_id);

    // Slot-level filters. Same-day-doubles is checked via sameDayDoubleReason,
    // which also rejects time-overlap regardless of policy (a hard physical
    // constraint — no human can be in two places at once).
    const slotEligible = dayPool.employees.filter(e => {
      if (shiftAssignmentIds.includes(e.id)) return false;
      if (sameDayDoubleReason(e.id, slot, weekState, settings) !== null) return false;
      if ((weekState.weeklyHoursMap.get(e.id) ?? 0) + slot.hours > e.max_weekly_hours) return false;
      if (
        settings.maxConsecutiveDaysWorked != null &&
        consecutiveDaysRunIncluding(e.id, slot.date, weekState) > settings.maxConsecutiveDaysWorked
      ) {
        return false;
      }
      if (hasHardBannedPair(e.id, shiftAssignmentIds, data.conflicts)) return false;
      return true;
    });

    let chosen: Employee | null = null;

    if (slotEligible.length > 0) {
      const ranked = rankCandidates(slotEligible, slot, weekState, data.conflicts, settings, veteranMode);
      chosen = ranked[0] ?? null;
    } else {
      // Slot-level pool empty. Check whether the binding constraint is a
      // banned pair — if so, try cascade resolution to bring a viable
      // candidate in by displacing the conflicting partner.
      const blockedByConflictOnly = dayPool.employees.filter(e => {
        if (shiftAssignmentIds.includes(e.id)) return false;
        if (sameDayDoubleReason(e.id, slot, weekState, settings) !== null) return false;
        if ((weekState.weeklyHoursMap.get(e.id) ?? 0) + slot.hours > e.max_weekly_hours) return false;
        if (
          settings.maxConsecutiveDaysWorked != null &&
          consecutiveDaysRunIncluding(e.id, slot.date, weekState) > settings.maxConsecutiveDaysWorked
        ) {
          return false;
        }
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
            settings,
          }
        );
        if (op) {
          // Apply the cascade moves first, then place candidate at this slot.
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
      const diagnostic = buildGapDiagnostic({
        slot,
        employees: data.employees,
        availByEmp: data.availByEmp,
        toMap: data.toMap,
        veteranOnlyDates,
        weekState,
        shiftAssignmentIds,
        conflicts: data.conflicts,
        settings,
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
          reason: diagnostic.short_reason,
          description: diagnostic.description,
          per_employee_dispositions: diagnostic.per_employee_dispositions,
          start_time: slot.start_time,
          end_time: slot.end_time,
        };
        gapByReqId.set(key, gap);
        weekState.gaps.push(gap);
      }
    }
  }

  // After all slots in a (date, shift_type) are filled, run post-fill
  // enforcement: attribute mix and 'at_least_one'/'only' veteran modes.
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

  // Per-shift attribute_mix enforcement. Receives only non-concurrent_coverage
  // rules (parser routes concurrent_coverage to evaluateSexCoverage below).
  // Today this list is empty for Watermark (sex moved to concurrent_coverage);
  // the loop remains for any future shift-scoped attribute_mix rule.
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

  // Veteran 'at_least_one' / 'only' enforcement.
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

      // Try swapping the lowest-hours non-veteran out for an eligible veteran.
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
        // Same-day-doubles check needs to see weekState without the row we're
        // about to overwrite. Without this filter, the displaced employee's
        // assignment at index `idx` would block any candidate from matching
        // and would self-reject candidates whose own id sits at that index.
        const viewState: WeekState = {
          ...weekState,
          assignments: weekState.assignments.filter((_, i) => i !== idx),
        };
        const candidate = elig.employees.find(e => {
          if (!e.is_veteran) return false;
          if (placedVets.has(e.id)) return false;
          if (cohabIds.includes(e.id)) return false;
          if (hasHardBannedPair(e.id, cohabIds, data.conflicts)) return false;
          if ((weekState.weeklyHoursMap.get(e.id) ?? 0) + slot.hours > e.max_weekly_hours) return false;
          if (
            settings.maxConsecutiveDaysWorked != null &&
            consecutiveDaysRunIncluding(e.id, slot.date, viewState) > settings.maxConsecutiveDaysWorked
          ) {
            return false;
          }
          if (sameDayDoubleReason(e.id, slot, viewState, settings) !== null) return false;
          return true;
        });
        if (!candidate) continue;

        const prevId = cur.employee_id;
        weekState.weeklyHoursMap.set(prevId, (weekState.weeklyHoursMap.get(prevId) ?? 0) - slot.hours);
        weekState.weeklyHoursMap.set(candidate.id, (weekState.weeklyHoursMap.get(candidate.id) ?? 0) + slot.hours);
        weekState.assignments[idx] = { ...cur, employee_id: candidate.id, employee_name: candidate.name };
        placedVets.add(candidate.id);
        stillNeed--;
      }

      if (stillNeed > 0 && veteranMode === 'at_least_one') {
        const veteranReason = buildAttributeShortageReason({
          shift: { date: group.date, shift_type_id: group.shift_type_id, shift_name: group.shift_name },
          missingAttribute: 'is_veteran',
          missingValue: 'true',
          needed: 1,
          weekState,
          deps: {
            employees: data.employees,
            employeeById,
            availByEmp: data.availByEmp,
            toMap: data.toMap,
            conflicts: data.conflicts,
            veteranOnlyDates,
            canvasSlots: canvas,
            settings,
          },
        });
        weekState.flagged_issues.push({
          type: 'unsatisfied_attribute_mix',
          date: group.date,
          shift_name: group.shift_name,
          description: veteranReason.description,
          metadata: {
            attribute: 'is_veteran',
            value: 'true',
            required: 1,
            actual: 0,
            per_employee_dispositions: veteranReason.per_employee,
          },
        });
      }
    }
  }

  // Shift experience (veteran) requirements: per-shift, day-of-week + season
  // scoped rules that require ALL veterans or a MINIMUM number on a given shift.
  // Mirrors the veteranMode swap/flag above, but driven by stored rules per
  // group, and ALWAYS flags a shortfall (the manager needs to know the shift
  // couldn't meet its veteran requirement).
  const experienceRules = data.experienceRules ?? [];
  if (experienceRules.length > 0) {
    for (const group of shiftGroups.values()) {
      if (group.indices.length === 0) continue;
      const groupAssignments = group.indices.map(i => ({ index: i, role: weekState.assignments[i].role }));
      const targets = veteranTargetsForGroup(experienceRules, group.date, group.shift_type_id, groupAssignments);

      for (const target of targets) {
        const isVet = (i: number) => !!employeeById.get(weekState.assignments[i].employee_id)?.is_veteran;
        let currentVets = target.indices.filter(isVet).length;
        if (currentVets >= target.need) continue;

        const placedVets = new Set<string>(
          target.indices.map(i => weekState.assignments[i].employee_id).filter(id => employeeById.get(id)?.is_veteran)
        );
        let stillNeed = target.need - currentVets;

        // Swap the lowest-hours non-veterans out for eligible veterans.
        const sortedNonVet = [...target.indices]
          .filter(i => !isVet(i))
          .sort((a, b) =>
            (weekState.weeklyHoursMap.get(weekState.assignments[a].employee_id) ?? 0) -
            (weekState.weeklyHoursMap.get(weekState.assignments[b].employee_id) ?? 0)
          );

        for (const idx of sortedNonVet) {
          if (stillNeed <= 0) break;
          const cur = weekState.assignments[idx];
          const slot = canvas.find(s => s.date === cur.date && s.shift_name === cur.shift_name && s.role === cur.role);
          if (!slot) continue;
          const elig = buildEligibility(slot, data.employees, data.availByEmp, data.toMap, veteranOnlyDates);
          const cohabIds = group.indices.filter(i => i !== idx).map(i => weekState.assignments[i].employee_id);
          const viewState: WeekState = {
            ...weekState,
            assignments: weekState.assignments.filter((_, i) => i !== idx),
          };
          const candidate = elig.employees.find(e => {
            if (!e.is_veteran) return false;
            if (placedVets.has(e.id)) return false;
            if (cohabIds.includes(e.id)) return false;
            if (hasHardBannedPair(e.id, cohabIds, data.conflicts)) return false;
            if ((weekState.weeklyHoursMap.get(e.id) ?? 0) + slot.hours > e.max_weekly_hours) return false;
            if (
              settings.maxConsecutiveDaysWorked != null &&
              consecutiveDaysRunIncluding(e.id, slot.date, viewState) > settings.maxConsecutiveDaysWorked
            ) return false;
            if (sameDayDoubleReason(e.id, slot, viewState, settings) !== null) return false;
            return true;
          });
          if (!candidate) continue;

          const prevId = cur.employee_id;
          weekState.weeklyHoursMap.set(prevId, (weekState.weeklyHoursMap.get(prevId) ?? 0) - slot.hours);
          weekState.weeklyHoursMap.set(candidate.id, (weekState.weeklyHoursMap.get(candidate.id) ?? 0) + slot.hours);
          weekState.assignments[idx] = { ...cur, employee_id: candidate.id, employee_name: candidate.name };
          placedVets.add(candidate.id);
          stillNeed--;
          currentVets++;
        }

        if (stillNeed > 0) {
          const reason = buildAttributeShortageReason({
            shift: { date: group.date, shift_type_id: group.shift_type_id, shift_name: group.shift_name },
            missingAttribute: 'is_veteran',
            missingValue: 'true',
            needed: target.need,
            weekState,
            deps: {
              employees: data.employees,
              employeeById,
              availByEmp: data.availByEmp,
              toMap: data.toMap,
              conflicts: data.conflicts,
              veteranOnlyDates,
              canvasSlots: canvas,
              settings,
            },
          });
          weekState.flagged_issues.push({
            type: 'unsatisfied_attribute_mix',
            date: group.date,
            shift_name: group.shift_name,
            description:
              target.mode === 'all_veterans'
                ? `This shift is set to require all veterans, but only ${currentVets} of ${target.indices.length} position(s) could be filled by veterans. ${reason.description}`
                : `This shift requires at least ${target.need} veteran(s), but only ${currentVets} could be placed. ${reason.description}`,
            metadata: {
              attribute: 'is_veteran',
              value: 'true',
              required: target.need,
              actual: currentVets,
              per_employee_dispositions: reason.per_employee,
            },
          });
        }
      }
    }
  }

  // Concurrent (facility-wide temporal) coverage evaluation. Validate-and-flag
  // only — runs on the final assignment state, never swaps. Replaces the
  // per-shift sex enforcement for the sex_coverage rule.
  for (const cov of concurrentCoverage) {
    const flags = evaluateSexCoverage(weekState, cov, employeeById);
    for (const f of flags) weekState.flagged_issues.push(f);
  }

  // After post-fill swaps, refresh gap filled_counts.
  for (const gap of weekState.gaps) {
    gap.filled_count = weekState.assignments.filter(
      a => a.date === gap.date && a.shift_name === gap.shift_name && a.role === gap.role
    ).length;
  }

  return {
    assignments: weekState.assignments,
    gaps: weekState.gaps,
    flagged_issues: weekState.flagged_issues,
    closed_dates,
    shift_override_mismatches: shiftOverrideMismatches,
    totalRequired,
    totalFilled,
  };
}

// ── Public engine entry point ─────────────────────────────────────────────────

export interface RunScheduleBuildResult {
  assignments: ScheduleAssignment[];
  gaps: ScheduleGap[];
  flagged_issues: FlaggedIssue[];
  closed_dates: ClosedDate[];
  shift_override_mismatches: ShiftOverrideMismatch[];
  totalRequired: number;
  totalFilled: number;
}

// Pure engine orchestration: canvas → fill loop → cascade → attribute-mix
// → veteran swap → gap recount. No DB writes, no messaging, no logging.
// Both handleBuildSchedule (production) and scripts/dry-run-schedule.ts call
// this so there is exactly one engine implementation.
//
// data.events and data.policies must already be populated by the caller.
// attribute_mix constraints are derived here from data.policies so callers
// don't need to parse twice.
export function runScheduleBuild(
  data: BuildData,
  settings: EngineSettings,
  veteranMode: VeteranMode,
  veteranOnlyDates: VeteranOnlyRange[],
  weekStart: string,
  weekEnd: string,
): RunScheduleBuildResult {
  const weekDates = getDatesInRange(weekStart, weekEnd);

  const eventsByDate = new Map<string, Event[]>();
  for (const date of weekDates) {
    eventsByDate.set(date, data.events.filter(e =>
      (e.date ?? '') <= date && (e.end_date ?? e.date ?? '') >= date
    ));
  }

  const parsedHard = parseConstraints(data.policies).hard;

  const result = buildScheduleForWeek({
    data,
    weekDates,
    eventsByDate,
    veteranMode,
    veteranOnlyDates,
    settings,
    attributeMix: parsedHard.attributeMix,
    concurrentCoverage: parsedHard.concurrentCoverage,
  });

  return {
    assignments: result.assignments,
    gaps: result.gaps,
    flagged_issues: result.flagged_issues,
    closed_dates: result.closed_dates,
    shift_override_mismatches: result.shift_override_mismatches,
    totalRequired: result.totalRequired,
    totalFilled: result.totalFilled,
  };
}

// ── Staffing report ───────────────────────────────────────────────────────────

function buildStaffingReport(
  assignments: ScheduleAssignment[],
  gaps: ScheduleGap[],
  totalRequired: number,
  totalFilled: number,
  employees: Employee[],
  specialNotes: Event[],
  closedDates: ClosedDate[],
  shiftOverrideMismatches: ShiftOverrideMismatch[]
): Record<string, unknown> {
  const coverage_rate = totalRequired > 0 ? Math.round((totalFilled / totalRequired) * 1000) / 10 : 100;

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
    closed_dates: closedDates,
    shift_override_mismatches: shiftOverrideMismatches,
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
  _companyName: string,
  estimatedWages: { total_estimated: number; missing_wages?: Array<{ name: string }> },
  closedDates: ClosedDate[]
): Promise<string> {
  const coverageRate = totalRequired > 0 ? Math.round((totalFilled / totalRequired) * 1000) / 10 : 100;
  const weekLabel = `${formatShortDate(weekStart)}–${formatShortDate(weekEnd)}`;

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

  const missing = estimatedWages.missing_wages ?? [];
  if (missing.length > 0) {
    const names = missing.map(m => m.name).join(', ');
    lines.push(`Heads up: ${missing.length} employee${missing.length === 1 ? '' : 's'} have no wage configured — labor estimate excludes them (${names}).`);
  }

  if (specialNotes.length > 0) {
    const applied = specialNotes.filter(n => n.staffing_notes || n.shift_overrides);
    if (applied.length > 0) {
      lines.push(`Notes applied: ${applied.map(n => n.title).join(', ')}`);
    }
  }

  if (closedDates.length > 0) {
    const formatted = closedDates
      .map(c => `${new Date(c.date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} (${c.event_title})`)
      .join(', ');
    lines.push(`Closed dates honored: ${formatted}`);
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
  // Conversational ack on email so the manager sees an immediate in-thread
  // reply while the build runs. The rich HTML result email follows below
  // as a separate, non-threaded send.
  if (message.channel === 'email') {
    const firstName = contact.name?.trim().split(/\s+/)[0] ?? '';
    const bodyText = firstName
      ? `Got it, ${firstName}. Building your schedule now — I'll send the full breakdown over in just a moment.`
      : `Got it. Building your schedule now — I'll send the full breakdown over in just a moment.`;
    await sendInThreadAck({ message, contact, bodyText });
    // Brief delay so the ack arrives before the schedule result email.
    // SendGrid + Outlook deliver within ~1s normally; 5s gives clear separation.
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  const { data: policyRows } = await supabase
    .from('policies')
    .select('*')
    .eq('company_id', contact.company_id);
  const parsedEarly = parseConstraints((policyRows ?? []) as Policy[]);
  console.log('[schedule-build] week start day:', parsedEarly.settings.weekStartDay);

  const { weekStart, weekEnd } = parseTargetWeek(extracted, parsedEarly.settings);
  console.log(
    '[schedule-build] week:', weekStart, '→', weekEnd,
    '(today is', new Date().toLocaleDateString('en-CA'), ')'
  );

  const [data, specialNotes] = await Promise.all([
    loadBuildData(contact.company_id, weekStart, weekEnd),
    getSpecialNotesForRange(contact.company_id, weekStart, weekEnd),
  ]);
  data.events = specialNotes;

  // Parse constraint vocabulary out of policies. Unknown rows are dropped
  // permissively; malformed known rows are logged for Railway visibility.
  const parsed = parseConstraints(data.policies);
  console.log(
    '[schedule-build] engine settings:', parsed.settings,
    '— attribute_mix rules:', parsed.hard.attributeMix.length,
    '— concurrent_coverage rules:', parsed.hard.concurrentCoverage.length,
    '— unrecognized policies:', parsed.unrecognized.length
  );

  const { data: customAvailData } = await supabase
    .from('custom_availability')
    .select('*')
    .eq('company_id', contact.company_id)
    .eq('active', true)
    .order('created_at', { ascending: false });

  const customAvailByEmployee: Record<string, CustomAvailability> = {};
  for (const row of (customAvailData ?? []) as CustomAvailability[]) {
    if (!customAvailByEmployee[row.employee_id]) {
      customAvailByEmployee[row.employee_id] = row;
    }
  }

  for (const emp of data.employees) {
    const custom = customAvailByEmployee[emp.id] ?? null;
    if (!custom) continue;
    const normal = data.availByEmp.get(emp.id) ?? [];
    const resolved = resolveAvailabilityForWeek(emp, weekStart, weekEnd, normal, custom);
    if (resolved !== normal) {
      data.availByEmp.set(emp.id, resolved);
      console.log(`[schedule] using custom availability for ${emp.name}: ${custom.type}`);
    }
  }

  if (data.shiftTypes.length === 0) {
    await reply(contact, message,
      `No active shift types are configured for this company. Before Aegis can build a schedule, set up shift types in Homebase under Scheduling → Shift Types, then define shift requirements (which roles are needed for each shift type and on which days).`
    );
    return;
  }

  const veteranPreferenceRaw = typeof extracted['veteran_preference'] === 'string' && extracted['veteran_preference'].trim() !== ''
    ? extracted['veteran_preference'] as string
    : null;
  const requested = parseVeteranPreference(veteranPreferenceRaw);
  // Fall back to the parsed engine default if no request was supplied.
  const veteranMode: VeteranMode = requested
    ?? (parsed.settings.veteranPreferenceDefault === 'none'
      ? null
      : parsed.settings.veteranPreferenceDefault as VeteranMode);
  if (veteranMode) {
    console.log('[schedule-build] applying veteran preference:', veteranPreferenceRaw ?? `default ${parsed.settings.veteranPreferenceDefault}`);
  }

  const veteranOnlyDates: VeteranOnlyRange[] =
    Array.isArray(extracted['veteran_only_dates'])
      ? (extracted['veteran_only_dates'] as Array<{ start_date: string; end_date: string }>)
          .filter(r => r && typeof r.start_date === 'string' && typeof r.end_date === 'string')
      : [];
  if (veteranOnlyDates.length > 0) {
    console.log('[schedule-build] veteran-only date ranges:', veteranOnlyDates);
  }

  const { assignments, gaps, flagged_issues, closed_dates, shift_override_mismatches, totalRequired, totalFilled } = runScheduleBuild(
    data,
    parsed.settings,
    veteranMode,
    veteranOnlyDates,
    weekStart,
    weekEnd,
  );

  const wages = await computeWageEstimate(contact.company_id, assignments);

  const staffingReport = {
    ...buildStaffingReport(assignments, gaps, totalRequired, totalFilled, data.employees, specialNotes, closed_dates, shift_override_mismatches),
    estimated_wages: wages,
    engine_version: ENGINE_VERSION,
  };

  const schedulePayload = { assignments, gaps, flagged_issues } as unknown as Record<string, unknown>;
  const { data: schedRow, error: schedError } = await supabase
    .from('schedules')
    .insert({
      company_id: contact.company_id,
      week_start: weekStart,
      week_end: weekEnd,
      generated_at: new Date().toISOString(),
      generated_by: 'aegis',
      status: 'draft',
      data: schedulePayload,
      staffing_report: staffingReport as unknown as Record<string, unknown>,
    })
    .select('id')
    .single();

  if (schedError) {
    console.error('[schedule-build] save failed:', schedError.message);
    await logActivity({
      company_id: contact.company_id,
      action: SCHEDULE_BUILD_SAVE_FAILED,
      entity_type: 'schedule',
      entity_id: 'unsaved',
      summary: `Schedule built for ${weekStart}–${weekEnd} but failed to save to Homebase: ${schedError.message}`,
      metadata: {
        week_start: weekStart,
        week_end: weekEnd,
        total_filled: totalFilled,
        total_required: totalRequired,
        error_message: schedError.message,
        payload_assignments: assignments.length,
        payload_gaps: gaps.length,
        payload_flagged_issues: flagged_issues.length,
        engine_version: ENGINE_VERSION,
      },
    });
    const failureText =
      `Built your schedule for ${weekStart}–${weekEnd} but couldn't save it to Homebase. ` +
      `DB error: ${schedError.message}. ` +
      `Please message me again in 5 minutes to retry, or check Homebase to see if it appeared.`;
    if (message.channel === 'email') {
      await sendEmail({
        to: message.sender,
        subject: 'Schedule build failed',
        text: failureText,
        company_id: contact.company_id,
        thread_id: message.thread_id,
      });
    } else {
      await reply(contact, message, failureText);
    }
    return;
  }

  const scheduleId = (schedRow as { id: string } | null)?.id ?? 'unknown';

  await logActivity({
    company_id: contact.company_id,
    action: 'schedule_built',
    entity_type: 'schedule',
    entity_id: scheduleId,
    summary: `Schedule built for ${weekStart}–${weekEnd}: ${totalFilled}/${totalRequired} slots filled (${gaps.length} gaps, ${flagged_issues.length} flagged)`,
    metadata: {
      week_start: weekStart,
      week_end: weekEnd,
      total_filled: totalFilled,
      total_required: totalRequired,
      gaps: gaps.length,
      flagged_issues: flagged_issues.length,
      estimated_wages: wages.total_estimated,
      special_notes_count: specialNotes.length,
      engine_version: ENGINE_VERSION,
    },
  });

  if (message.channel === 'email') {
    const employeeMaxHours = new Map<string, { name: string; max_weekly_hours: number }>();
    for (const emp of data.employees) {
      employeeMaxHours.set(emp.id, { name: emp.name, max_weekly_hours: emp.max_weekly_hours });
    }
    const { subject, html, text } = await buildScheduleResultEmail({
      result: {
        assignments,
        gaps,
        flagged_issues,
        closed_dates,
        shift_override_mismatches,
        totalRequired,
        totalFilled,
      },
      schedule_id: scheduleId,
      company_id: contact.company_id,
      company_name: data.companyName,
      week_start: weekStart,
      week_end: weekEnd,
      manager_email: message.sender,
      manager_user_id: contact.user_id ?? undefined,
      wages,
      employee_max_hours: employeeMaxHours,
    });
    await sendEmail({
      to: message.sender,
      subject,
      text,
      html,
      company_id: contact.company_id,
      thread_id: message.thread_id,
    });
    return;
  }

  const summaryMsg = await buildManagerSummary(
    weekStart, weekEnd, assignments, gaps, totalFilled, totalRequired,
    specialNotes, data.companyName, wages, closed_dates
  );

  await reply(contact, message, summaryMsg);
}

// ── Distribute core ───────────────────────────────────────────────────────────

export interface DistributeScheduleResult {
  sent: number;
  total_employees: number;
  errors: Array<{ employee_id: string; reason: string }>;
  // Internal extras used by handleDistributeSchedule to build the manager
  // reply; the /internal/distribute-schedule endpoint only echoes the three
  // documented fields above.
  emailed: number;
  texted: number;
  no_contact: string[];
  week_label: string;
  // Set when the re-distribution guard refused the fan-out because the schedule
  // was already distributed (and `force` was not passed). When true, ZERO
  // messages were sent and `distributed_at` is the prior send timestamp.
  already_distributed?: boolean;
  distributed_at?: string | null;
}

// Pure callable used by both the SMS/email intent handler and the
// /internal/distribute-schedule endpoint (which is hit by Homebase after a
// manager clicks Distribute in an aegis_action_tokens magic-link email).
//
// Loads the schedule, fans out per-employee summaries, marks the schedule
// published + distributed_at, logs per-send + aggregate activity. Throws on
// schedule-not-found so callers can surface the error.
// ── Full all-staff schedule grid (email-safe inline fragment) ──────────────────
//
// Renders the WHOLE week for EVERY employee as a single self-contained <table>
// FRAGMENT (no <html>/<head>/<body>/<style> wrapper) so it can be embedded
// directly in the distribution email body and render in Gmail/Outlook/Apple Mail.
// Email clients strip <style>/<head>, so every style is an inline style=""
// attribute using only email-safe properties. Aegis builds this purely from data
// it already loaded (schedules.data) — no Homebase call, no exceljs/PDF dep. Rows
// are distinct shifts ordered by start_time; columns are the 7 days of the week.
function buildFullScheduleGridHtml(args: {
  schedData: ScheduleData;
  weekStart: string;
  weekEnd: string;
}): string {
  const { schedData, weekStart, weekEnd } = args;
  const assignments = schedData.assignments ?? [];
  const gaps = (schedData.gaps ?? []).filter(g => g.required_count > g.filled_count);
  // closed_dates may ride along in the persisted data even though the in-repo
  // ScheduleData type doesn't list it — read it defensively.
  const closedDates = (schedData as { closed_dates?: ClosedDate[] }).closed_dates ?? [];
  const closedByDate = new Map(closedDates.map(c => [c.date, c.event_title]));

  const days = getDatesInRange(weekStart, weekEnd);

  // Distinct shifts, with a representative start_time for ordering. Prefer an
  // assignment's start_time; fall back to a gap's. Order rows by start_time.
  const shiftStart = new Map<string, string>();
  for (const a of assignments) {
    if (!shiftStart.has(a.shift_name)) shiftStart.set(a.shift_name, a.start_time);
  }
  for (const g of gaps) {
    if (!shiftStart.has(g.shift_name)) shiftStart.set(g.shift_name, g.start_time ?? '99:99');
  }
  const shiftNames = [...shiftStart.keys()].sort((x, y) =>
    (shiftStart.get(x) ?? '99:99').localeCompare(shiftStart.get(y) ?? '99:99')
  );

  // Fast cell lookups, keyed by `${shift_name}||${date}`.
  const asgByKey = new Map<string, ScheduleAssignment[]>();
  for (const a of assignments) {
    const k = `${a.shift_name}||${a.date}`;
    (asgByKey.get(k) ?? asgByKey.set(k, []).get(k)!).push(a);
  }
  const gapByKey = new Map<string, ScheduleGap[]>();
  for (const g of gaps) {
    const k = `${g.shift_name}||${g.date}`;
    (gapByKey.get(k) ?? gapByKey.set(k, []).get(k)!).push(g);
  }

  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // No shifts at all → a plain inline-styled line, still a fragment (no wrapper).
  if (shiftNames.length === 0) {
    return `<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#6b7280;">No shifts are on the schedule for this week.</p>`;
  }

  const headerCells = days.map(d => {
    const closure = closedByDate.get(d);
    const sub = closure
      ? `<div style="font-size:11px;color:#b91c1c;font-weight:bold;">CLOSED — ${esc(closure)}</div>`
      : '';
    return `<th style="padding:8px 10px;border:1px solid #d1d5db;background-color:#1f2937;color:#f9fafb;text-align:left;font-size:12px;font-weight:bold;">${esc(formatWeekday(d))}<div style="font-weight:normal;color:#cbd5e1;font-size:11px;">${esc(formatShortDate(d))}</div>${sub}</th>`;
  }).join('');

  const bodyRows = shiftNames.map(shiftName => {
    const cells = days.map(d => {
      if (closedByDate.has(d)) {
        return `<td style="padding:8px 10px;border:1px solid #e5e7eb;background-color:#f3f4f6;color:#9ca3af;font-size:12px;text-align:center;vertical-align:top;">—</td>`;
      }
      const key = `${shiftName}||${d}`;
      const asgs = (asgByKey.get(key) ?? []).slice().sort((a, b) =>
        (a.employee_name ?? '').localeCompare(b.employee_name ?? '')
      );
      const cellGaps = gapByKey.get(key) ?? [];
      const lines: string[] = [];
      for (const a of asgs) {
        lines.push(`<div style="color:#111827;"><strong>${esc(a.employee_name ?? '')}</strong> <span style="color:#6b7280;">${esc(a.role)}</span></div>`);
      }
      for (const g of cellGaps) {
        const missing = g.required_count - g.filled_count;
        for (let i = 0; i < missing; i++) {
          lines.push(`<div style="color:#b91c1c;font-weight:bold;">UNFILLED — ${esc(g.role)}</div>`);
        }
      }
      const inner = lines.length > 0 ? lines.join('') : `<span style="color:#d1d5db;">·</span>`;
      return `<td style="padding:8px 10px;border:1px solid #e5e7eb;font-size:12px;text-align:left;vertical-align:top;">${inner}</td>`;
    }).join('');
    const startLabel = shiftStart.get(shiftName);
    const sub = startLabel && startLabel !== '99:99'
      ? `<div style="font-weight:normal;color:#6b7280;font-size:11px;">${esc(formatTime(startLabel))}</div>`
      : '';
    return `<tr><th style="padding:8px 10px;border:1px solid #d1d5db;background-color:#f9fafb;color:#111827;text-align:left;font-size:12px;font-weight:bold;vertical-align:top;">${esc(shiftName)}${sub}</th>${cells}</tr>`;
  }).join('');

  return `<table style="border-collapse:collapse;width:100%;font-family:Arial,Helvetica,sans-serif;">
<thead><tr><th style="padding:8px 10px;border:1px solid #d1d5db;background-color:#1f2937;color:#f9fafb;text-align:left;font-size:12px;font-weight:bold;">Shift</th>${headerCells}</tr></thead>
<tbody>${bodyRows}</tbody>
</table>`;
}

// ── "This week" special-notes / events section (email-safe inline fragment) ────
//
// Surfaces the company's events table rows for the target week (holidays,
// parties, closures, staffing notes) so each employee sees what's going on. Like
// the grid, this is an inline-styled fragment (no <style>/<head> wrapper).
function buildWeekEventsHtml(events: Event[]): string {
  if (events.length === 0) return '';
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = events.map(e => {
    const start = e.date ?? null;
    const label = start
      ? (e.end_date && e.end_date !== start
          ? `${formatShortDate(start)}–${formatShortDate(e.end_date)}`
          : formatShortDate(start))
      : 'This week';
    const closed = e.event_type === 'closure' ? ' <span style="color:#b91c1c;font-weight:bold;">(closed)</span>' : '';
    const note = e.staffing_notes
      ? `<div style="color:#6b7280;font-size:13px;">${esc(e.staffing_notes)}</div>`
      : '';
    return `<li style="margin:0 0 8px;"><strong>${esc(label)}</strong> — ${esc(e.title)}${closed}${note}</li>`;
  }).join('');
  return `<h3 style="margin:24px 0 8px;font-size:16px;color:#111827;">This week:</h3>
<ul style="margin:0 0 4px;padding-left:20px;font-size:14px;line-height:1.5;color:#374151;">${rows}</ul>`;
}

function buildWeekEventsText(events: Event[]): string {
  if (events.length === 0) return '';
  const lines = events.map(e => {
    const start = e.date ?? null;
    const label = start
      ? (e.end_date && e.end_date !== start ? `${formatShortDate(start)}–${formatShortDate(e.end_date)}` : formatShortDate(start))
      : 'This week';
    const closed = e.event_type === 'closure' ? ' (closed)' : '';
    const note = e.staffing_notes ? ` — ${e.staffing_notes}` : '';
    return `• ${label}: ${e.title}${closed}${note}`;
  });
  return `This week:\n${lines.join('\n')}`;
}

export async function distributeScheduleCore(
  scheduleId: string,
  companyId: string,
  force = false
): Promise<DistributeScheduleResult> {
  type ScheduleRow = { id: string; week_start: string; week_end: string; data: ScheduleData; status: string; distributed_at: string | null };

  const { data: schedRowData, error: schedError } = await supabase
    .from('schedules')
    .select('id, week_start, week_end, data, status, distributed_at')
    .eq('id', scheduleId)
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .single();
  if (schedError || !schedRowData) {
    throw new Error(`schedule ${scheduleId} not found for company ${companyId}: ${schedError?.message ?? 'no row'}`);
  }
  const scheduleRow = schedRowData as unknown as ScheduleRow;
  const schedData = scheduleRow.data as unknown as ScheduleData;
  const weekLabel = `${formatShortDate(scheduleRow.week_start)}–${formatShortDate(scheduleRow.week_end)}`;

  // Re-distribution guard: a non-null distributed_at means this schedule's
  // ~30-person fan-out already went out. Refuse to re-send (sending ZERO
  // messages) unless the caller explicitly forces it. This protects all three
  // triggers — the SMS/email intent, the /internal endpoint, and the future
  // Homebase button — since they all route through here.
  if (isAlreadyDistributed(scheduleRow, force)) {
    return {
      sent: 0,
      total_employees: 0,
      errors: [],
      emailed: 0,
      texted: 0,
      no_contact: [],
      week_label: weekLabel,
      already_distributed: true,
      distributed_at: scheduleRow.distributed_at,
    };
  }

  const [companyRes, channelRes, empRes, weekEvents] = await Promise.all([
    supabase.from('companies').select('name').eq('id', companyId).single(),
    supabase.from('company_channels').select('channel_value').eq('company_id', companyId).eq('channel_type', 'sms').maybeSingle(),
    supabase.from('employees').select('id, name, contact_email, contact_phone').eq('company_id', companyId).eq('active', true),
    getSpecialNotesForRange(companyId, scheduleRow.week_start, scheduleRow.week_end),
  ]);

  const companyName = (companyRes.data as { name: string } | null)?.name ?? 'Your Company';
  const aegisSmsChannel = (channelRes.data as { channel_value: string } | null)?.channel_value ?? null;
  const employees = (empRes.data ?? []) as Pick<Employee, 'id' | 'name' | 'contact_email' | 'contact_phone'>[];

  // Full all-staff week grid, rendered once as an email-safe inline <table>
  // fragment and embedded in every employee's email body so each person can see
  // the whole week, not just their own shifts. (Previously sent as an .html
  // attachment, which Gmail renders as raw source instead of showing the grid.)
  const teamGridHtml = buildFullScheduleGridHtml({
    schedData,
    weekStart: scheduleRow.week_start,
    weekEnd: scheduleRow.week_end,
  });
  // "This week:" special-notes / events block (holidays, parties, closures,
  // staffing notes) — empty string when the week has no events.
  const weekEventsHtml = buildWeekEventsHtml(weekEvents);
  const weekEventsText = buildWeekEventsText(weekEvents);

  let emailed = 0;
  let texted = 0;
  let sent = 0;
  const no_contact: string[] = [];
  const errors: Array<{ employee_id: string; reason: string }> = [];

  for (const emp of employees) {
    const myShifts = schedData.assignments
      .filter(a => a.employee_id === emp.id)
      .sort((a, b) => a.date.localeCompare(b.date));

    const hasShifts = myShifts.length > 0;
    const totalHours = myShifts.reduce((s, a) => s + a.hours, 0);

    let empEmailed = false;
    let empTexted = false;

    if (emp.contact_email) {
      try {
        const greetingLine = greeting(emp.name);
        const shiftCount = myShifts.length;

        // Warm, person-like framing. Leads with the day, then the position the
        // employee is working, the time, and the hours — the four things they
        // actually need. The shift name rides along as a quiet secondary label
        // so context (e.g. "PM Lifeguard") is preserved without a noisy column.
        const intro = hasShifts
          ? `You're on for ${shiftCount} shift${shiftCount === 1 ? '' : 's'} this week — ${totalHours}h in total. Here's how your week looks:`
          : `You're not on the schedule this week, so enjoy the time off. If you were expecting shifts, just reply to this email or check with your manager and we'll get it sorted.`;

        const shiftRows = hasShifts
          ? myShifts.map(s =>
              `<tr>` +
              `<td style="padding:10px 12px;border:1px solid #e5e7eb;">${formatDisplayDate(s.date)}</td>` +
              `<td style="padding:10px 12px;border:1px solid #e5e7eb;">${s.role}` +
                `<br><span style="color:#9ca3af;font-size:12px;">${s.shift_name}</span></td>` +
              `<td style="padding:10px 12px;border:1px solid #e5e7eb;white-space:nowrap;">${formatTime(s.start_time)} – ${formatTime(s.end_time)}</td>` +
              `<td style="padding:10px 12px;border:1px solid #e5e7eb;text-align:right;">${s.hours}h</td>` +
              `</tr>`
            ).join('')
          : '';

        const shiftTable = hasShifts
          ? `<table style="width:100%;border-collapse:collapse;margin:4px 0 18px;font-size:14px;">
<thead><tr style="background:#f9fafb;">
<th style="padding:8px 12px;border:1px solid #e5e7eb;text-align:left;">Day</th>
<th style="padding:8px 12px;border:1px solid #e5e7eb;text-align:left;">Position</th>
<th style="padding:8px 12px;border:1px solid #e5e7eb;text-align:left;">Time</th>
<th style="padding:8px 12px;border:1px solid #e5e7eb;text-align:right;">Hours</th>
</tr></thead>
<tbody>${shiftRows}</tbody>
</table>
<p style="margin:0 0 20px;color:#374151;">That's <strong>${totalHours}h</strong> across the week.</p>`
          : '';

        const html = `<!DOCTYPE html><html><body style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111827;">
<h2 style="margin:0 0 12px;font-size:20px;">Your shifts for ${weekLabel}</h2>
<p style="margin:0 0 16px;line-height:1.5;">${greetingLine}</p>
<p style="margin:0 0 18px;line-height:1.5;color:#374151;">${intro}</p>
${shiftTable}
${weekEventsHtml}
<h3 style="margin:26px 0 10px;font-size:16px;color:#111827;">Here's the whole team's week:</h3>
${teamGridHtml}
<p style="margin:8px 0 0;line-height:1.5;color:#9ca3af;font-size:12px;">Positions are in grey next to each name. <span style="color:#b91c1c;font-weight:bold;">UNFILLED</span> marks an open slot.</p>
<p style="margin:20px 0 4px;line-height:1.5;color:#374151;">If anything here doesn't look right, just reply to this email or reach out to your manager — we'll get it fixed.</p>
<p style="margin:18px 0 0;color:#6b7280;">See you this week,<br>${companyName}</p>
</body></html>`;

        const eventsBlock = weekEventsText ? `\n\n${weekEventsText}` : '';
        const text = hasShifts
          ? `${greetingLine}\n\n${intro}\n\n` +
            myShifts.map(s => `• ${formatDisplayDate(s.date)} — ${s.role} (${s.shift_name}), ${formatTime(s.start_time)}–${formatTime(s.end_time)}, ${s.hours}h`).join('\n') +
            `\n\nThat's ${totalHours}h across the week.${eventsBlock}\n\nIf anything here doesn't look right, just reply to this email or reach out to your manager — we'll get it fixed.\n\nSee you this week,\n${companyName}`
          : `${greetingLine}\n\n${intro}${eventsBlock}\n\nSee you soon,\n${companyName}`;

        await sendEmail({
          to: emp.contact_email,
          subject: `${companyName} — Your Schedule ${weekLabel}`,
          text,
          html,
          company_id: companyId,
        });
        emailed++;
        empEmailed = true;
      } catch (err) {
        errors.push({ employee_id: emp.id, reason: `email send failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    if (emp.contact_phone && aegisSmsChannel) {
      try {
        const smsBody = emp.contact_email
          ? `${companyName}: Your schedule for ${weekLabel} has been posted. Check your email for details.`
          : hasShifts
            ? `${companyName} schedule ${weekLabel}: ${myShifts.slice(0, 3).map(s => `${new Date(s.date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short' })} ${s.shift_name}`).join(', ')}${myShifts.length > 3 ? ` +${myShifts.length - 3} more` : ''}`
            : `${companyName}: No shifts scheduled for ${weekLabel}.`;

        const ok = await sendSms({ to: emp.contact_phone, from: aegisSmsChannel, body: smsBody, company_id: companyId });
        if (ok) {
          texted++;
          empTexted = true;
        } else {
          errors.push({ employee_id: emp.id, reason: 'sms send returned false' });
        }
      } catch (err) {
        errors.push({ employee_id: emp.id, reason: `sms send failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    if (!emp.contact_email && !emp.contact_phone) {
      no_contact.push(emp.name);
      errors.push({ employee_id: emp.id, reason: 'no contact_email or contact_phone on file' });
    } else if (empEmailed || empTexted) {
      sent++;
      await logActivity({
        company_id: companyId,
        action: 'schedule_distributed_to_employee',
        entity_type: 'employee',
        entity_id: emp.id,
        summary: `${emp.name} received schedule for ${weekLabel} (${[empEmailed ? 'email' : null, empTexted ? 'sms' : null].filter(Boolean).join('+')})`,
        metadata: {
          schedule_id: scheduleRow.id,
          channels: { email: empEmailed, sms: empTexted },
        },
      });
    }
  }

  await supabase.from('schedules').update({
    status: 'published',
    distributed_at: new Date().toISOString(),
  }).eq('id', scheduleRow.id);

  if (no_contact.length > 0) {
    await logActivity({
      company_id: companyId,
      action: 'schedule_distribute_partial',
      entity_type: 'schedule',
      entity_id: scheduleRow.id,
      summary: `Schedule distributed — ${no_contact.length} employee(s) could not be notified (no contact info)`,
      metadata: { employees_missing_contact: no_contact },
    });
  }

  await logActivity({
    company_id: companyId,
    action: 'schedule_distributed',
    entity_type: 'schedule',
    entity_id: scheduleRow.id,
    summary: `Schedule for ${weekLabel} distributed — ${emailed} emails, ${texted} texts sent`,
    metadata: { week: weekLabel, emailed, texted, no_contact, errors: errors.length },
  });

  return {
    sent,
    total_employees: employees.length,
    errors,
    emailed,
    texted,
    no_contact,
    week_label: weekLabel,
  };
}

// ── Distribute handler ────────────────────────────────────────────────────────

export async function handleDistributeSchedule(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  // Resolve the TARGET week the manager asked for ("this"/"next") the same way
  // build_schedule does, instead of blindly distributing the latest schedule.
  // This was the wrong-week bug: "distribute next week's schedule" sent THIS
  // week's because the handler ignored `extracted` and auto-picked latest.
  const { data: policyRows } = await supabase
    .from('policies').select('*').eq('company_id', contact.company_id);
  const { settings } = parseConstraints((policyRows ?? []) as Policy[]);
  const { weekStart, weekEnd } = parseTargetWeek(extracted, settings);
  const weekLabel = `${formatShortDate(weekStart)}–${formatShortDate(weekEnd)}`;

  // Select the schedule for THAT week_start (not "latest"). Prefer a published
  // one over a draft; newest generated_at within the week breaks any tie.
  type ScheduleRow = { id: string };
  let scheduleRow: ScheduleRow | null = null;
  for (const status of ['published', 'draft'] as const) {
    const { data } = await supabase
      .from('schedules').select('id').is('deleted_at', null)
      .eq('company_id', contact.company_id)
      .eq('status', status)
      .eq('week_start', weekStart)
      .order('generated_at', { ascending: false }).limit(1).maybeSingle();
    if (data) { scheduleRow = data as ScheduleRow; break; }
  }

  if (!scheduleRow) {
    // Do NOT fall back to a different week — say so plainly.
    await reply(contact, message,
      `There's no schedule built for the week of ${weekLabel} yet. Once it's built, I can send it out.`
    );
    return;
  }

  // Acknowledge the ACTUAL week being distributed (email channel gets an
  // in-thread ack; the fan-out + result message follow).
  if (message.channel === 'email') {
    const firstName = contact.name?.trim().split(/\s+/)[0] ?? '';
    const ackBody = firstName
      ? `Got it, ${firstName}. Sending out the schedule for the week of ${weekLabel} now.`
      : `Got it. Sending out the schedule for the week of ${weekLabel} now.`;
    await sendInThreadAck({ message, contact, bodyText: ackBody });
  }

  const result = await distributeScheduleCore(scheduleRow.id, contact.company_id);

  // Guard tripped: schedule already distributed — no messages were sent.
  if (result.already_distributed) {
    const when = result.distributed_at
      ? new Date(result.distributed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : 'earlier';
    await reply(contact, message,
      `The schedule for the week of ${weekLabel} was already sent on ${when}. To re-send, use Distribute in Homebase.`
    );
    return;
  }

  const lines = [`Schedule for ${result.week_label} has been sent.`];
  lines.push(`${result.emailed} employee${result.emailed !== 1 ? 's' : ''} emailed, ${result.texted} notified by SMS.`);
  if (result.no_contact.length > 0) {
    lines.push(`⚠ Could not notify ${result.no_contact.length} employee${result.no_contact.length !== 1 ? 's' : ''} (no contact info on file): ${result.no_contact.join(', ')}`);
  }

  await reply(contact, message, lines.join('\n'));
}
