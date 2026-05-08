export interface ClockRecord {
  employee_id: string;
  employee_name: string;
  date: string;              // YYYY-MM-DD
  clock_in: string | null;   // ISO timestamp
  clock_out: string | null;  // ISO timestamp
  actual_hours: number | null; // null if missing clock_out
  raw: Record<string, unknown>;
}

export interface ScheduledShift {
  employee_id: string;
  employee_name: string;
  date: string;
  shift_name: string;
  start_time: string;    // HH:MM
  end_time: string;      // HH:MM
  scheduled_hours: number;
  role: string;
}

export type DiscrepancyType =
  | 'no_show'
  | 'forgot_clock_out'
  | 'early_clock_in'
  | 'late_clock_in'
  | 'early_clock_out'
  | 'late_clock_out'
  | 'unscheduled_shift'
  | 'clean';

export interface DiscrepancyRecord {
  employee_id: string;
  employee_name: string;
  date: string;
  scheduled_hours: number | null;
  actual_hours: number | null;
  difference: number;           // actual - scheduled
  discrepancy_type: DiscrepancyType;
  scheduled_shift: string | null;
  actual_clock_in: string | null;
  actual_clock_out: string | null;
  notes: string;
}

export interface ReconciliationResult {
  period_start: string;
  period_end: string;
  total_employees: number;
  clean_count: number;
  issue_count: number;
  total_scheduled_hours: number;
  total_actual_hours: number;
  total_hour_variance: number;
  estimated_wage_variance: number;
  records: DiscrepancyRecord[];
  clean_records: DiscrepancyRecord[];
  issue_records: DiscrepancyRecord[];
}

// Parse HH:MM time on a given YYYY-MM-DD date into a Date (UTC)
function parseShiftTime(date: string, time: string): Date {
  return new Date(`${date}T${time}:00Z`);
}

function formatTime(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes().toString().padStart(2, '0');
  const period = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m}${period}`;
}

function minuteDiff(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 60_000);
}

export function reconcilePayroll(params: {
  companyId: string;
  periodStart: string;
  periodEnd: string;
  scheduledShifts: ScheduledShift[];
  clockRecords: ClockRecord[];
  varianceWindowMinutes?: number;
  wageRates: Map<string, number>;
}): ReconciliationResult {
  const {
    periodStart,
    periodEnd,
    scheduledShifts,
    clockRecords,
    varianceWindowMinutes = 15,
    wageRates,
  } = params;

  const records: DiscrepancyRecord[] = [];

  // Index clock records by employee_id+date for O(1) lookup
  const clockIndex = new Map<string, ClockRecord>();
  const matchedClockKeys = new Set<string>();
  for (const cr of clockRecords) {
    clockIndex.set(`${cr.employee_id}|${cr.date}`, cr);
  }

  // --- Process each scheduled shift ---
  for (const shift of scheduledShifts) {
    const key = `${shift.employee_id}|${shift.date}`;
    const clock = clockIndex.get(key);

    if (!clock) {
      records.push({
        employee_id: shift.employee_id,
        employee_name: shift.employee_name,
        date: shift.date,
        scheduled_hours: shift.scheduled_hours,
        actual_hours: null,
        difference: -shift.scheduled_hours,
        discrepancy_type: 'no_show',
        scheduled_shift: shift.shift_name,
        actual_clock_in: null,
        actual_clock_out: null,
        notes: `No clock record found. Scheduled for ${shift.shift_name} (${shift.start_time}–${shift.end_time}).`,
      });
      continue;
    }

    matchedClockKeys.add(key);

    if (clock.clock_out === null) {
      records.push({
        employee_id: shift.employee_id,
        employee_name: shift.employee_name,
        date: shift.date,
        scheduled_hours: shift.scheduled_hours,
        actual_hours: clock.actual_hours,
        difference: clock.actual_hours !== null ? clock.actual_hours - shift.scheduled_hours : -shift.scheduled_hours,
        discrepancy_type: 'forgot_clock_out',
        scheduled_shift: shift.shift_name,
        actual_clock_in: clock.clock_in,
        actual_clock_out: null,
        notes: `Missing clock-out. Clocked in at ${clock.clock_in ? formatTime(clock.clock_in) : 'unknown'} but never clocked out.`,
      });
      continue;
    }

    const shiftStart = parseShiftTime(shift.date, shift.start_time);
    const shiftEnd = parseShiftTime(shift.date, shift.end_time);
    const actualIn = new Date(clock.clock_in!);
    const actualOut = new Date(clock.clock_out);

    const inDiffMinutes = minuteDiff(actualIn, shiftStart); // positive = late
    const outDiffMinutes = minuteDiff(actualOut, shiftEnd);  // negative = early

    let discrepancy_type: DiscrepancyType = 'clean';
    let notes = '';

    // Prioritize clock-in issues over clock-out issues
    if (inDiffMinutes > varianceWindowMinutes) {
      discrepancy_type = 'late_clock_in';
      notes = `Clocked in ${inDiffMinutes} minutes late (${formatTime(clock.clock_in!)} vs ${shift.start_time}).`;
    } else if (inDiffMinutes < -varianceWindowMinutes) {
      discrepancy_type = 'early_clock_in';
      notes = `Clocked in ${Math.abs(inDiffMinutes)} minutes early (${formatTime(clock.clock_in!)} vs ${shift.start_time}).`;
    } else if (outDiffMinutes < -varianceWindowMinutes) {
      discrepancy_type = 'early_clock_out';
      notes = `Clocked out ${Math.abs(outDiffMinutes)} minutes early (${formatTime(clock.clock_out)} vs ${shift.end_time}).`;
    } else if (outDiffMinutes > varianceWindowMinutes) {
      discrepancy_type = 'late_clock_out';
      notes = `Clocked out ${outDiffMinutes} minutes late (${formatTime(clock.clock_out)} vs ${shift.end_time}).`;
    } else {
      notes = `Within ${varianceWindowMinutes}-minute variance window. Clocked in ${formatTime(clock.clock_in!)} → out ${formatTime(clock.clock_out)}.`;
    }

    const actualHours = clock.actual_hours ?? 0;
    const difference = actualHours - shift.scheduled_hours;

    records.push({
      employee_id: shift.employee_id,
      employee_name: shift.employee_name,
      date: shift.date,
      scheduled_hours: shift.scheduled_hours,
      actual_hours: clock.actual_hours,
      difference,
      discrepancy_type,
      scheduled_shift: shift.shift_name,
      actual_clock_in: clock.clock_in,
      actual_clock_out: clock.clock_out,
      notes,
    });
  }

  // --- Unscheduled shifts: clock records with no matching scheduled shift ---
  for (const cr of clockRecords) {
    const key = `${cr.employee_id}|${cr.date}`;
    if (!matchedClockKeys.has(key)) {
      records.push({
        employee_id: cr.employee_id,
        employee_name: cr.employee_name,
        date: cr.date,
        scheduled_hours: null,
        actual_hours: cr.actual_hours,
        difference: cr.actual_hours ?? 0,
        discrepancy_type: 'unscheduled_shift',
        scheduled_shift: null,
        actual_clock_in: cr.clock_in,
        actual_clock_out: cr.clock_out,
        notes: `Clocked in with no scheduled shift on this date (${cr.actual_hours?.toFixed(2) ?? '?'} hrs worked).`,
      });
    }
  }

  // --- Sort: issues first, then clean; alphabetically within each group ---
  records.sort((a, b) => {
    const aClean = a.discrepancy_type === 'clean' ? 1 : 0;
    const bClean = b.discrepancy_type === 'clean' ? 1 : 0;
    if (aClean !== bClean) return aClean - bClean;
    return a.employee_name.localeCompare(b.employee_name);
  });

  const issue_records = records.filter(r => r.discrepancy_type !== 'clean');
  const clean_records = records.filter(r => r.discrepancy_type === 'clean');

  const total_scheduled_hours = records.reduce((sum, r) => sum + (r.scheduled_hours ?? 0), 0);
  const total_actual_hours = records.reduce((sum, r) => sum + (r.actual_hours ?? 0), 0);
  const total_hour_variance = total_actual_hours - total_scheduled_hours;

  // Wage variance: sum (difference * hourlyRate) for each record where we have a rate
  let estimated_wage_variance = 0;
  for (const r of records) {
    const rate = wageRates.get(r.employee_id) ?? 0;
    estimated_wage_variance += r.difference * rate;
  }

  const employeeIds = new Set(records.map(r => r.employee_id));

  return {
    period_start: periodStart,
    period_end: periodEnd,
    total_employees: employeeIds.size,
    clean_count: clean_records.length,
    issue_count: issue_records.length,
    total_scheduled_hours,
    total_actual_hours,
    total_hour_variance,
    estimated_wage_variance,
    records,
    clean_records,
    issue_records,
  };
}
