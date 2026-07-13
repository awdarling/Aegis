// Special-event staffing exceptions (item 6).
//
// A manager describes a special event in plain English (to Soteria or Aegis);
// the assistant figures out whether it's a brand-new one-off shift ("add") or a
// change to an existing shift's hours/headcount ("stretch"), and writes a
// structured spec into events.event_shifts. The engine applies that spec ONLY on
// the event's dates — so it never touches the recurring weekly template and
// disappears on its own once the date passes.
//
// Default is ADDITIVE: an "add" shift runs alongside the normal schedule and
// competes for the same roster (gaps are flagged like any other). It removes a
// normal shift only when the manager explicitly says so, via replaces_shift_name.

import type { Event } from '../../db/types';
import type { CanvasSlot } from './types';

export interface EventShiftRole {
  role: string;
  count: number;
}

export interface EventShift {
  // 'add'     — a brand-new one-off shift on the event's date(s).
  // 'stretch' — change an EXISTING shift's hours and/or per-role headcount.
  mode: 'add' | 'stretch';
  // 'add': the new shift's display name. 'stretch': the existing shift to change.
  shift_name: string;
  // 'add': required. 'stretch': new hours (omit to keep the shift's normal hours).
  start_time?: string | null;
  end_time?: string | null;
  // 'add': the roles + counts to staff. 'stretch': optional per-role count override.
  roles?: EventShiftRole[] | null;
  // 'add' only: name of a normal shift to suppress on the date (an explicit
  // replacement). Omit/null = additive (the default).
  replaces_shift_name?: string | null;
}

function shiftHours(start: string, end: string): number {
  const toMins = (t: string) => {
    const [h, m] = t.slice(0, 5).split(':').map(Number);
    return h * 60 + m;
  };
  let mins = toMins(end) - toMins(start);
  if (mins < 0) mins += 24 * 60;
  return Math.round((mins / 60) * 10) / 10;
}

function readEventShifts(e: Event): EventShift[] {
  const raw = (e as { event_shifts?: unknown }).event_shifts;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is EventShift =>
      !!s && typeof s === 'object' &&
      ((s as EventShift).mode === 'add' || (s as EventShift).mode === 'stretch') &&
      typeof (s as EventShift).shift_name === 'string'
  );
}

interface Entry {
  date: string;
  eventId: string;
  shift: EventShift;
}

// Apply every event's staffing exceptions to the canvas slot list, for the dates
// the events cover within the build week. Pure: returns a NEW slot array and is
// a no-op (returns the input untouched) when no event carries event_shifts — so
// normal builds are byte-for-byte unchanged.
export function applyEventShifts(
  slots: CanvasSlot[],
  events: Event[],
  weekDates: string[]
): CanvasSlot[] {
  const entries: Entry[] = [];
  for (const e of events) {
    const evShifts = readEventShifts(e);
    if (evShifts.length === 0) continue;
    const start = e.date ?? '';
    if (!start) continue;
    const end = e.end_date ?? e.date ?? '';
    for (const d of weekDates) {
      if (d >= start && d <= end) {
        for (const shift of evShifts) entries.push({ date: d, eventId: e.id, shift });
      }
    }
  }
  if (entries.length === 0) return slots;

  // 1) Explicit replacements: suppress the named normal shift on that date.
  const replaced = new Set<string>();
  for (const { date, shift } of entries) {
    if (shift.mode === 'add' && shift.replaces_shift_name) {
      replaced.add(`${date}__${shift.replaces_shift_name}`);
    }
  }
  let working = slots.filter(s => !replaced.has(`${s.date}__${s.shift_name}`));

  // 2) Stretches: change an existing shift's hours and/or per-role counts.
  for (const { date, shift } of entries) {
    if (shift.mode !== 'stretch') continue;
    const name = shift.shift_name;

    // Time change applies to every slot of that shift on the date.
    if (shift.start_time || shift.end_time) {
      working = working.map(s => {
        if (s.date === date && s.shift_name === name) {
          const start_time = shift.start_time ?? s.start_time;
          const end_time = shift.end_time ?? s.end_time;
          return { ...s, start_time, end_time, hours: shiftHours(start_time, end_time) };
        }
        return s;
      });
    }

    // Per-role count override: rebuild that role's group to the new count.
    for (const ro of shift.roles ?? []) {
      const group = working.filter(s => s.date === date && s.shift_name === name && s.role === ro.role);
      working = working.filter(s => !(s.date === date && s.shift_name === name && s.role === ro.role));
      const tmpl = group[0];
      const start_time = shift.start_time ?? tmpl?.start_time ?? '00:00';
      const end_time = shift.end_time ?? tmpl?.end_time ?? '00:00';
      const shiftTypeId = tmpl?.shift_type_id ?? `event-stretch:${date}:${name}`;
      const reqId = tmpl?.shift_requirement_id ?? `event-stretch:${date}:${name}:${ro.role}`;
      for (let i = 0; i < ro.count; i++) {
        working.push({
          date, shift_type_id: shiftTypeId, shift_name: name, shift_requirement_id: reqId,
          role: ro.role,
          // D10 — an event's staffing spec names ONE role per entry ("4 Lifeguards
          // on the Afternoon shift"), so the accepted set is exactly that role.
          // Inheriting the template slot's wider accepted_roles would quietly let
          // someone else fill a slot the manager explicitly asked a Lifeguard for.
          accepted_roles: [ro.role],
          start_time, end_time, hours: shiftHours(start_time, end_time),
          required_count: ro.count, slot_index: i, is_priority: true,
        });
      }
    }
  }

  // 3) Adds: brand-new one-off shifts for the date.
  for (const { date, eventId, shift } of entries) {
    if (shift.mode !== 'add') continue;
    const start_time = shift.start_time ?? '00:00';
    const end_time = shift.end_time ?? '00:00';
    const hours = shiftHours(start_time, end_time);
    for (const ro of shift.roles ?? []) {
      for (let i = 0; i < ro.count; i++) {
        working.push({
          date,
          shift_type_id: `event:${eventId}:${shift.shift_name}`,
          shift_name: shift.shift_name,
          shift_requirement_id: `event:${eventId}:${shift.shift_name}:${ro.role}`,
          role: ro.role,
          // D10 — see above: a one-off event shift names its role explicitly.
          accepted_roles: [ro.role],
          start_time, end_time, hours,
          required_count: ro.count,
          slot_index: i,
          is_priority: true,
        });
      }
    }
  }

  return working;
}
