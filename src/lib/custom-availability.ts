import { randomUUID } from 'crypto';
import type { Availability, CustomAvailability, Employee, Json } from '../db/types';

// A schedule-time availability slot is just a synthesized `availability` row —
// the schedule builder and simulator both consume `Availability[]` keyed by
// employee. Re-export under the spec name for clarity at call sites.
export type AvailabilitySlot = Availability;
export type CustomAvailabilityRow = CustomAvailability;

// JSON shape for `custom_availability.patterns` when type === 'date_limited'.
export interface CustomAvailabilityPattern {
  day_of_week: number;
  start_time: string;
  end_time: string;
}

// JSON shape for `custom_availability.patterns` when type === 'rotating'.
export interface CustomAvailabilityWeek {
  week: number;
  days: CustomAvailabilityPattern[];
}

function isPattern(value: unknown): value is CustomAvailabilityPattern {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.day_of_week === 'number' &&
    typeof p.start_time === 'string' &&
    typeof p.end_time === 'string'
  );
}

function isWeek(value: unknown): value is CustomAvailabilityWeek {
  if (!value || typeof value !== 'object') return false;
  const w = value as Record<string, unknown>;
  return typeof w.week === 'number' && Array.isArray(w.days) && w.days.every(isPattern);
}

function patternsAsList(patterns: Json): CustomAvailabilityPattern[] | null {
  if (!Array.isArray(patterns)) return null;
  const out: CustomAvailabilityPattern[] = [];
  for (const p of patterns) {
    if (!isPattern(p)) return null;
    out.push(p);
  }
  return out;
}

function patternsAsWeeks(patterns: Json): CustomAvailabilityWeek[] | null {
  if (!Array.isArray(patterns)) return null;
  const out: CustomAvailabilityWeek[] = [];
  for (const w of patterns) {
    if (!isWeek(w)) return null;
    out.push(w);
  }
  return out;
}

function toSlots(
  employee: Employee,
  patterns: CustomAvailabilityPattern[]
): AvailabilitySlot[] {
  return patterns.map(p => ({
    id: randomUUID(),
    employee_id: employee.id,
    company_id: employee.company_id,
    day_of_week: p.day_of_week,
    start_time: p.start_time,
    end_time: p.end_time,
  }));
}

function daysBetween(fromDate: string, toDate: string): number {
  const from = new Date(fromDate + 'T12:00:00Z').getTime();
  const to = new Date(toDate + 'T12:00:00Z').getTime();
  return Math.floor((to - from) / (24 * 60 * 60 * 1000));
}

// Resolves the effective availability for an employee for the given schedule
// week, taking any active custom_availability override into account. Returns
// `normalAvailability` unchanged when no override applies, when the override
// has expired, or when the override is malformed.
export function resolveAvailabilityForWeek(
  employee: Employee,
  weekStart: string,
  _weekEnd: string,
  normalAvailability: AvailabilitySlot[],
  customAvailability: CustomAvailabilityRow | null
): AvailabilitySlot[] {
  if (!customAvailability || !customAvailability.active) {
    return normalAvailability;
  }

  if (customAvailability.end_date && customAvailability.end_date < weekStart) {
    return normalAvailability;
  }

  if (customAvailability.type === 'date_limited') {
    const patterns = patternsAsList(customAvailability.patterns);
    if (!patterns) return normalAvailability;
    return toSlots(employee, patterns);
  }

  if (customAvailability.type === 'rotating') {
    if (!customAvailability.cycle_start_date || !customAvailability.cycle_weeks) {
      return normalAvailability;
    }
    const weeks = patternsAsWeeks(customAvailability.patterns);
    if (!weeks) return normalAvailability;

    const daysDiff = daysBetween(customAvailability.cycle_start_date, weekStart);
    if (daysDiff < 0) return normalAvailability;

    const weekNumber = (Math.floor(daysDiff / 7) % customAvailability.cycle_weeks) + 1;
    const matchedWeek = weeks.find(w => w.week === weekNumber);
    if (!matchedWeek) return normalAvailability;

    return toSlots(employee, matchedWeek.days);
  }

  return normalAvailability;
}
