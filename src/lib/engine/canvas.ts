import type { Event, ShiftType } from '../../db/types';
import type { CanvasSlot } from './types';
import { applyEventShifts } from './event-shifts';

// ── CanvasRequirement — what the engine actually needs ────────────────────────
//
// RULE 0 (docs/07_Data_Contract.md): what the manager sees is the truth.
// The manager defines a shift's NAME, HOURS and DAYS once, in the shift box
// (`shift_types`). A role requirement only says "this shift needs N of role X".
//
// `shift_requirements` historically ALSO carried copies of shift_name /
// start_time / end_time / days_active, stamped at insert and invisible to the
// manager. They drifted (D4). The engine must not depend on them, so the canvas
// no longer accepts a raw DB row — it accepts this shape, which deliberately
// contains NO shift attributes at all except the date-scoping stamp.
//
// `days_active` here is NOT the DB column. It is a per-date STAMP set by
// schedule-build.ts, which scopes a requirement to a single day. It never comes
// from `shift_requirements.days_active` — that column is being dropped.
//
// Everything else (name, hours) is read from the ShiftType. One source. The one
// the manager edits.
export interface CanvasRequirement {
  id: string;
  shift_type_id: string;
  /** Preferred role — drives ranking and manager-facing copy. */
  role: string;
  /** D10 — every role the manager said may fill this slot. Read from the DB. */
  accepted_roles: string[];
  required_count: number;
  /** Engine-internal date scope stamp — not a DB column. */
  days_active: number[];
}

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

// Per-date closure record returned alongside the canvas so callers (and the
// manager-facing summary) can surface honored closures instead of letting
// dropped dates disappear silently.
export interface ClosedDate {
  date: string;
  event_title: string;
}

export interface CanvasResult {
  slots: CanvasSlot[];
  closed_dates: ClosedDate[];
}

// Produces one CanvasSlot per required head per requirement per active date.
// Dates with a closure event drop out entirely (recorded in closed_dates).
// Priority is determined by the presence of staffing_notes or any busy-day
// event_type on the date.
//
// Final order: priority slots first, then date ASC, then start_time ASC. This
// is the visit order used by the fill loop.
export function buildCanvas(
  weekDates: string[],
  shiftTypes: ShiftType[],
  shiftRequirements: CanvasRequirement[],
  events: Event[]
): CanvasResult {
  const slots: CanvasSlot[] = [];
  const closed_dates: ClosedDate[] = [];

  for (const date of weekDates) {
    const dateEvents = eventsForDate(date, events);
    const closure = dateEvents.find(e => e.event_type === 'closure');
    if (closure) {
      closed_dates.push({ date, event_title: closure.title ?? 'Closure' });
      continue;
    }

    const isPriority = dateEvents.some(
      e => e.staffing_notes != null || BUSY_DAY_EVENT_TYPES.has(e.event_type)
    );

    const dow = dayOfWeekUTC(date);
    const activeShiftTypes = shiftTypes.filter(st => st.days_active.includes(dow));

    for (const st of activeShiftTypes) {
      // Matched by shift_type_id ONLY. The old code fell back to
      // `req.shift_name === st.name` for rows with no shift_type_id — matching a
      // requirement to a shift by a copied string. That fallback is gone: every
      // requirement is now linked by id (enforced NOT NULL in the DB), so a
      // renamed shift can never silently detach its own staffing.
      //
      // days_active is the per-date stamp from schedule-build.ts, not a DB read.
      const reqs = shiftRequirements.filter(req =>
        req.shift_type_id === st.id && req.days_active.includes(dow)
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
            // D10 — carry the manager's full accepted-role list into the slot.
            // Fall back to the preferred role so a malformed row can't make a
            // slot unfillable by everyone.
            accepted_roles: req.accepted_roles?.length ? req.accepted_roles : [req.role],
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

  // Apply special-event staffing exceptions (item 6) — one-off "add" shifts and
  // "stretch" changes carried on events.event_shifts, scoped to the event's
  // dates. No-op (returns `slots` untouched) when no event carries them.
  const withEvents = applyEventShifts(slots, events, weekDates);

  withEvents.sort((a, b) => {
    if (a.is_priority !== b.is_priority) return a.is_priority ? -1 : 1;
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.start_time !== b.start_time) return a.start_time < b.start_time ? -1 : 1;
    if (a.shift_name !== b.shift_name) return a.shift_name < b.shift_name ? -1 : 1;
    if (a.role !== b.role) return a.role < b.role ? -1 : 1;
    return a.slot_index - b.slot_index;
  });

  return { slots: withEvents, closed_dates };
}
