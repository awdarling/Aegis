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

function dayOfWeekUTC(date: string): number {
  return new Date(date + 'T12:00:00Z').getUTCDay();
}

// CUSTOM-AVAIL-ALIGN: shift `date` back to the most recent day whose weekday
// matches `weekAligned`'s weekday (the schedule's week-start). A rotating
// cycle_start_date can be ANY weekday (a manager might pick a Wednesday), but
// the schedule runs in fixed week-start-aligned weeks. Anchoring the rotation to
// the same weekday makes daysBetween(anchor, weekStart) a clean multiple of 7,
// so the whole build week reads ONE rotation-week pattern instead of flipping
// mid-week. Without this, ~5 of every 7 days got the wrong week's availability.
function alignToWeekday(date: string, weekAligned: string): string {
  const target = dayOfWeekUTC(weekAligned);
  const dow = dayOfWeekUTC(date);
  const back = (((dow - target) % 7) + 7) % 7;
  if (back === 0) return date;
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
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

    // Anchor the cycle to the schedule's week-start (see alignToWeekday) so the
    // rotation lines up with build weeks instead of flipping mid-week.
    const alignedCycleStart = alignToWeekday(customAvailability.cycle_start_date, weekStart);
    const daysDiff = daysBetween(alignedCycleStart, weekStart);
    if (daysDiff < 0) return normalAvailability;

    const weekNumber = (Math.floor(daysDiff / 7) % customAvailability.cycle_weeks) + 1;
    const matchedWeek = weeks.find(w => w.week === weekNumber);
    if (!matchedWeek) return normalAvailability;

    return toSlots(employee, matchedWeek.days);
  }

  return normalAvailability;
}
