import type { Event, ShiftRequirement, ShiftType } from '../../db/types';
import type { CanvasSlot } from './types';

const BUSY_DAY_EVENT_TYPES = new Set<Event['event_type']>([
  'holiday',
  'special_event',
  'party',
  'fundraiser',
]);

function shiftHours(start: string, end: string): number {
  const toMins = (t: string) => {
    const [h, m] = t.slice(0, 5).split(':').map(Number);
    return h * 60 + m;
  };
  let mins = toMins(end) - toMins(start);
  if (mins < 0) mins += 24 * 60;
  return Math.round((mins / 60) * 10) / 10;
}

function dayOfWeekUTC(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function eventsForDate(date: string, events: Event[]): Event[] {
  return events.filter(e => {
    const start = e.date ?? '';
    const end = e.end_date ?? e.date ?? '';
    return start && date >= start && date <= end;
  });
}

// Produces one CanvasSlot per required head per requirement per active date.
// Dates with a closure event drop out entirely. Priority is determined by the
// presence of staffing_notes or any busy-day event_type on the date.
//
// Final order: priority slots first, then date ASC, then start_time ASC. This
// is the visit order used by the fill loop.
export function buildCanvas(
  weekDates: string[],
  shiftTypes: ShiftType[],
  shiftRequirements: ShiftRequirement[],
  events: Event[]
): CanvasSlot[] {
  const slots: CanvasSlot[] = [];

  for (const date of weekDates) {
    const dateEvents = eventsForDate(date, events);
    if (dateEvents.some(e => e.event_type === 'closure')) continue;

    const isPriority = dateEvents.some(
      e => e.staffing_notes != null || BUSY_DAY_EVENT_TYPES.has(e.event_type)
    );

    const dow = dayOfWeekUTC(date);
    const activeShiftTypes = shiftTypes.filter(st => st.days_active.includes(dow));

    for (const st of activeShiftTypes) {
      // days_active here is a per-date STAMP set by schedule-build.ts (line ~365)
      // to scope per-date shift_overrides to a single day. It is NOT a read of
      // the shift_requirements DB column — schedule-build.ts ignores that
      // column. Callers passing un-stamped requirements must set
      // days_active = the shift_type's days_active (or just call
      // runScheduleBuild from workflows/schedule-build.ts instead).
      const reqs = shiftRequirements.filter(req =>
        (req.shift_type_id ? req.shift_type_id === st.id : req.shift_name === st.name) &&
        req.days_active.includes(dow)
      );

      const hours = shiftHours(st.start_time, st.end_time);

      for (const req of reqs) {
        if (req.required_count <= 0) continue;
        for (let i = 0; i < req.required_count; i++) {
          slots.push({
            date,
            shift_type_id: st.id,
            shift_name: st.name,
            shift_requirement_id: req.id,
            role: req.role,
            start_time: st.start_time,
            end_time: st.end_time,
            hours,
            required_count: req.required_count,
            slot_index: i,
            is_priority: isPriority,
          });
        }
      }
    }
  }

  slots.sort((a, b) => {
    if (a.is_priority !== b.is_priority) return a.is_priority ? -1 : 1;
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.start_time !== b.start_time) return a.start_time < b.start_time ? -1 : 1;
    if (a.shift_name !== b.shift_name) return a.shift_name < b.shift_name ? -1 : 1;
    if (a.role !== b.role) return a.role < b.role ? -1 : 1;
    return a.slot_index - b.slot_index;
  });

  return slots;
}
