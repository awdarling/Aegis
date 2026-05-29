import { supabase } from '../db/client';
import { getSpecialNotesForRange } from '../workflows/special-notes';
import { resolveAvailabilityForWeek } from './custom-availability';
import { buildTOMap, isBlockedByTO, type TOWindow } from './to-window';
import type {
  Employee,
  Availability,
  CustomAvailability,
  TimeOffRequest,
  ShiftRequirement,
  ShiftType,
  Policy,
  Event,
} from '../db/types';

// ── Public types ──────────────────────────────────────────────────────────────

export interface SimulationInput {
  company_id: string;
  period_start: string;
  period_end: string;
  new_time_off?: {
    employee_id: string;
    start_date: string;
    end_date: string;
  };
}

export interface AffectedShift {
  date: string;
  shift_name: string;
  role: string;
  required_count: number;
  covered_without: number;
  covered_with: number;
  shift_start: string;
  shift_end: string;
}

export interface CoverageGap {
  date: string;
  shift_name: string;
  role: string;
  shortfall: number;
}

export interface AlternateEmployee {
  employee_id: string;
  name: string;
  qualified_roles: string[];
  available_dates: string[];
}

export interface SimulationResult {
  overall_feasible: boolean;
  affected_shifts: AffectedShift[];
  coverage_gaps: CoverageGap[];
  available_alternates: AlternateEmployee[];
  coverage_rate_before: number;
  coverage_rate_after: number;
  period_start: string;
  period_end: string;
  special_notes_affecting_period: Event[];
}

// ── Internal types ────────────────────────────────────────────────────────────

interface SimData {
  employees: Employee[];
  availabilityByEmployee: Map<string, Availability[]>;
  shiftRequirements: ShiftRequirement[];
  shiftTypesById: Map<string, ShiftType>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getDatesInRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const cur = new Date(start + 'T12:00:00Z');
  const last = new Date(end + 'T12:00:00Z');
  while (cur <= last) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// Returns the Sunday-through-Saturday week(s) that fully contain the given dates.
export function getWeekBounds(
  startDate: string,
  endDate: string
): { weekStart: string; weekEnd: string } {
  const start = new Date(startDate + 'T12:00:00Z');
  const end = new Date(endDate + 'T12:00:00Z');
  const weekStart = new Date(start);
  weekStart.setUTCDate(start.getUTCDate() - start.getUTCDay()); // back to Sunday
  const weekEnd = new Date(end);
  weekEnd.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay())); // forward to Saturday
  return {
    weekStart: weekStart.toISOString().slice(0, 10),
    weekEnd: weekEnd.toISOString().slice(0, 10),
  };
}

// Normalize time strings to HH:MM so "09:00" and "09:00:00" compare correctly.
function normalizeTime(t: string): string {
  return t.slice(0, 5);
}

function isEmployeeAvailableForShift(
  empId: string,
  dayOfWeek: number,
  shiftStart: string,
  shiftEnd: string,
  availabilityByEmployee: Map<string, Availability[]>
): boolean {
  const records = availabilityByEmployee.get(empId) ?? [];
  const ns = normalizeTime(shiftStart);
  const ne = normalizeTime(shiftEnd);
  return records.some(
    a =>
      a.day_of_week === dayOfWeek &&
      normalizeTime(a.start_time) <= ns &&
      normalizeTime(a.end_time) >= ne
  );
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadSimData(
  companyId: string,
  periodStart: string,
  periodEnd: string
): Promise<SimData> {
  const [empRes, availRes, reqRes, stRes, customAvailRes] = await Promise.all([
    supabase.from('employees').select('*').eq('company_id', companyId).eq('active', true),
    supabase.from('availability').select('*').eq('company_id', companyId),
    supabase.from('shift_requirements').select('*').eq('company_id', companyId),
    supabase.from('shift_types').select('*').eq('company_id', companyId).eq('active', true),
    supabase.from('custom_availability').select('*')
      .eq('company_id', companyId).eq('active', true)
      .order('created_at', { ascending: false }),
  ]);

  const employees = (empRes.data ?? []) as Employee[];
  const availability = (availRes.data ?? []) as Availability[];
  const shiftRequirements = (reqRes.data ?? []) as ShiftRequirement[];
  const shiftTypesById = new Map<string, ShiftType>(
    ((stRes.data ?? []) as ShiftType[]).map(s => [s.id, s])
  );

  const availabilityByEmployee = new Map<string, Availability[]>();
  for (const avail of availability) {
    if (!availabilityByEmployee.has(avail.employee_id)) {
      availabilityByEmployee.set(avail.employee_id, []);
    }
    availabilityByEmployee.get(avail.employee_id)!.push(avail);
  }

  // Fold custom_availability into availabilityByEmployee using the same
  // newest-active-row-wins rule the build path uses (schedule-build.ts).
  const customAvailByEmployee: Record<string, CustomAvailability> = {};
  for (const row of (customAvailRes.data ?? []) as CustomAvailability[]) {
    if (!customAvailByEmployee[row.employee_id]) {
      customAvailByEmployee[row.employee_id] = row;
    }
  }
  const dates = getDatesInRange(periodStart, periodEnd);
  const weekStart = dates[0];
  const weekEnd = dates[dates.length - 1];
  for (const emp of employees) {
    const custom = customAvailByEmployee[emp.id] ?? null;
    if (!custom) continue;
    const normal = availabilityByEmployee.get(emp.id) ?? [];
    const resolved = resolveAvailabilityForWeek(emp, weekStart, weekEnd, normal, custom);
    if (resolved !== normal) {
      availabilityByEmployee.set(emp.id, resolved);
    }
  }

  return { employees, availabilityByEmployee, shiftRequirements, shiftTypesById };
}

async function loadApprovedTimeOff(
  companyId: string,
  periodStart: string,
  periodEnd: string
): Promise<TimeOffRequest[]> {
  const { data } = await supabase
    .from('time_off_requests')
    .select('id, employee_id, company_id, start_date, end_date, reason, status, requested_at, decided_at, decided_by, aegis_recommendation, aegis_reasoning, time_off_type, partial_days')
    .eq('company_id', companyId)
    .eq('status', 'approved')
    .lte('start_date', periodEnd)
    .gte('end_date', periodStart);
  return (data ?? []) as TimeOffRequest[];
}

// ── Core simulation ───────────────────────────────────────────────────────────

// Runs both scenarios (with and without the new TO) in a single pass.
// Returns all structural results without touching the database.
function runBothScenarios(
  dates: string[],
  data: SimData,
  baselineMap: Map<string, TOWindow>,
  withNewMap: Map<string, TOWindow>,
  newEmployeeId: string | undefined
): {
  affected_shifts: AffectedShift[];
  coverage_gaps: CoverageGap[];
  available_alternates: AlternateEmployee[];
  coverage_rate_before: number;
  coverage_rate_after: number;
} {
  const alternateMap = new Map<string, AlternateEmployee>();
  const affectedShifts: AffectedShift[] = [];
  const coverageGaps: CoverageGap[] = [];

  let baselineTotalReq = 0;
  let baselineTotalCov = 0;
  let withNewTotalReq = 0;
  let withNewTotalCov = 0;

  for (const date of dates) {
    const dayOfWeek = new Date(date + 'T12:00:00Z').getUTCDay(); // 0 = Sunday

    for (const req of data.shiftRequirements) {
      // Gate by the parent shift_type's days_active — shift_requirements.days_active
      // is dormant and may be stale. Mirrors the canvas builder in
      // src/lib/engine/canvas.ts.
      if (req.shift_type_id) {
        const st = data.shiftTypesById.get(req.shift_type_id);
        if (!st || !st.days_active.includes(dayOfWeek)) continue;
      } else {
        // Legacy rows with no shift_type_id: fall back to the requirement's own field.
        if (!req.days_active.includes(dayOfWeek)) continue;
      }

      let baselineCovered = 0;
      let withNewCovered = 0;
      const shiftId = req.shift_type_id ?? '';

      for (const emp of data.employees) {
        if (!emp.qualified_roles.includes(req.role)) continue;
        if (
          !isEmployeeAvailableForShift(
            emp.id,
            dayOfWeek,
            req.start_time,
            req.end_time,
            data.availabilityByEmployee
          )
        )
          continue;
        if (!isBlockedByTO(emp.id, date, req.start_time, req.end_time, shiftId, baselineMap)) baselineCovered++;
        if (!isBlockedByTO(emp.id, date, req.start_time, req.end_time, shiftId, withNewMap)) withNewCovered++;
      }

      baselineTotalReq += req.required_count;
      baselineTotalCov += Math.min(baselineCovered, req.required_count);
      withNewTotalReq += req.required_count;
      withNewTotalCov += Math.min(withNewCovered, req.required_count);

      // Coverage gap: with the new TO we fall below the requirement
      if (withNewCovered < req.required_count) {
        coverageGaps.push({
          date,
          shift_name: req.shift_name,
          role: req.role,
          shortfall: req.required_count - withNewCovered,
        });
      }

      // Affected shift: coverage changes between baseline and new scenario
      if (withNewCovered < baselineCovered) {
        affectedShifts.push({
          date,
          shift_name: req.shift_name,
          role: req.role,
          required_count: req.required_count,
          covered_without: Math.min(baselineCovered, req.required_count),
          covered_with: Math.min(withNewCovered, req.required_count),
          shift_start: req.start_time,
          shift_end: req.end_time,
        });

        // Find employees who could cover this affected slot
        for (const emp of data.employees) {
          if (emp.id === newEmployeeId) continue;
          if (!emp.qualified_roles.includes(req.role)) continue;
          if (isBlockedByTO(emp.id, date, req.start_time, req.end_time, shiftId, withNewMap)) continue;
          if (
            !isEmployeeAvailableForShift(
              emp.id,
              dayOfWeek,
              req.start_time,
              req.end_time,
              data.availabilityByEmployee
            )
          )
            continue;

          if (!alternateMap.has(emp.id)) {
            alternateMap.set(emp.id, {
              employee_id: emp.id,
              name: emp.name,
              qualified_roles: emp.qualified_roles,
              available_dates: [],
            });
          }
          const alt = alternateMap.get(emp.id)!;
          if (!alt.available_dates.includes(date)) alt.available_dates.push(date);
        }
      }
    }
  }

  return {
    affected_shifts: affectedShifts,
    coverage_gaps: coverageGaps,
    available_alternates: Array.from(alternateMap.values()),
    coverage_rate_before:
      baselineTotalReq > 0 ? (baselineTotalCov / baselineTotalReq) * 100 : 100,
    coverage_rate_after:
      withNewTotalReq > 0 ? (withNewTotalCov / withNewTotalReq) * 100 : 100,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

// Returns a structured simulation result. Never writes to the database.
// Throws 'NO_SHIFT_REQUIREMENTS' if no shift requirements are configured.
export async function runSimulation(input: SimulationInput): Promise<SimulationResult> {
  const [simData, baselineTO, specialNotes] = await Promise.all([
    loadSimData(input.company_id, input.period_start, input.period_end),
    loadApprovedTimeOff(input.company_id, input.period_start, input.period_end),
    getSpecialNotesForRange(input.company_id, input.period_start, input.period_end),
  ]);

  if (simData.shiftRequirements.length === 0) {
    throw new Error('NO_SHIFT_REQUIREMENTS');
  }

  const dates = getDatesInRange(input.period_start, input.period_end);

  // Add the proposed TO as a synthetic "approved" request for simulation only
  const withNewTO: TimeOffRequest[] = input.new_time_off
    ? [
        ...baselineTO,
        {
          id: '__simulated__',
          company_id: input.company_id,
          employee_id: input.new_time_off.employee_id,
          start_date: input.new_time_off.start_date,
          end_date: input.new_time_off.end_date,
          status: 'approved' as const,
          reason: null,
          requested_at: new Date().toISOString(),
          decided_at: null,
          decided_by: null,
          aegis_recommendation: null,
          aegis_reasoning: null,
          time_off_type: 'full_day' as const,
          partial_days: null,
        },
      ]
    : baselineTO;

  const baselineMap = buildTOMap(dates, baselineTO);
  const withNewMap = buildTOMap(dates, withNewTO);

  const scenarios = runBothScenarios(
    dates,
    simData,
    baselineMap,
    withNewMap,
    input.new_time_off?.employee_id
  );

  return {
    ...scenarios,
    overall_feasible: scenarios.coverage_gaps.length === 0,
    period_start: input.period_start,
    period_end: input.period_end,
    special_notes_affecting_period: specialNotes,
  };
}

// Convenience: load time_off and coverage policies for a company.
// Used by the time-off workflow when building the manager email.
export async function loadTimeOffPolicies(companyId: string): Promise<Policy[]> {
  const { data } = await supabase
    .from('policies')
    .select('*')
    .eq('company_id', companyId)
    .in('policy_type', ['time_off', 'coverage']);
  return (data ?? []) as Policy[];
}

// ── Wage estimation ───────────────────────────────────────────────────────────

export interface WageLineItem {
  employee_id: string;
  employee_name: string;
  hours: number;
  hourly_rate: number;
  estimated_pay: number;
}

export interface MissingWage {
  employee_id: string;
  name: string;
  role: string;
}

export interface WageEstimate {
  total_estimated: number;
  by_employee: WageLineItem[];
  // Employees with at least one shift whose wage couldn't be resolved (no
  // individual_wage AND no matching wage_rates row). Surfaced so the manager
  // sees that the labor estimate excludes them. Dedup'd by employee_id.
  missing_wages: MissingWage[];
}

// Computes estimated wages for a set of shifts.
// Uses individual_wage from employees table first, falls back to role wage_rate.
// Never writes to the database.
export async function computeWageEstimate(
  companyId: string,
  shifts: Array<{
    employee_id: string;
    employee_name: string;
    role: string;
    start_time: string;
    end_time: string;
    hours?: number;
  }>
): Promise<WageEstimate> {
  const [empRes, ratesRes] = await Promise.all([
    supabase.from('employees').select('id, individual_wage').eq('company_id', companyId),
    supabase.from('wage_rates').select('role, hourly_rate').eq('company_id', companyId),
  ]);

  const individualWages = new Map<string, number>();
  for (const emp of (empRes.data ?? []) as { id: string; individual_wage: number | null }[]) {
    if (emp.individual_wage != null) individualWages.set(emp.id, emp.individual_wage);
  }

  const roleRates = new Map<string, number>();
  for (const rate of (ratesRes.data ?? []) as { role: string; hourly_rate: number }[]) {
    roleRates.set(rate.role, rate.hourly_rate);
  }

  return computeWageEstimateFromMaps(shifts, individualWages, roleRates);
}

// Pure helper extracted so wage logic is testable without supabase round-trips.
// Called by the supabase-loading `computeWageEstimate` and directly by smoke.
export function computeWageEstimateFromMaps(
  shifts: Array<{
    employee_id: string;
    employee_name: string;
    role: string;
    start_time: string;
    end_time: string;
    hours?: number;
  }>,
  individualWages: Map<string, number>,
  roleRates: Map<string, number>
): WageEstimate {
  const byEmployee = new Map<string, WageLineItem>();
  const missingMap = new Map<string, MissingWage>();

  for (const shift of shifts) {
    const hours = shift.hours ?? wageShiftHours(shift.start_time, shift.end_time);
    const individual = individualWages.get(shift.employee_id);
    const fallback = roleRates.get(shift.role);
    const resolved = individual ?? fallback;
    const rate = resolved ?? 0;
    const pay = Math.round(hours * rate * 100) / 100;

    if (resolved === undefined && !missingMap.has(shift.employee_id)) {
      missingMap.set(shift.employee_id, {
        employee_id: shift.employee_id,
        name: shift.employee_name,
        role: shift.role,
      });
    }

    if (!byEmployee.has(shift.employee_id)) {
      byEmployee.set(shift.employee_id, {
        employee_id: shift.employee_id,
        employee_name: shift.employee_name,
        hours: 0,
        hourly_rate: rate,
        estimated_pay: 0,
      });
    }
    const entry = byEmployee.get(shift.employee_id)!;
    entry.hours = Math.round((entry.hours + hours) * 10) / 10;
    entry.estimated_pay = Math.round((entry.estimated_pay + pay) * 100) / 100;
  }

  const items = Array.from(byEmployee.values());
  return {
    total_estimated: Math.round(items.reduce((s, e) => s + e.estimated_pay, 0) * 100) / 100,
    by_employee: items,
    missing_wages: Array.from(missingMap.values()),
  };
}

function wageShiftHours(startTime: string, endTime: string): number {
  const toMins = (t: string) => {
    const [h, m] = t.slice(0, 5).split(':').map(Number);
    return h * 60 + m;
  };
  let mins = toMins(endTime) - toMins(startTime);
  if (mins < 0) mins += 24 * 60;
  return Math.round((mins / 60) * 10) / 10;
}
