import { describe, it, expect } from 'vitest';
import { applyEventShifts, type EventShift } from '../event-shifts';
import type { CanvasSlot } from '../types';
import type { Event } from '../../../db/types';

const SAT = '2026-06-20';
const SUN = '2026-06-21';
const WEEK = [SAT, SUN];

function slot(p: Partial<CanvasSlot> & { date: string; shift_name: string; role: string }): CanvasSlot {
  return {
    shift_type_id: `st-${p.shift_name}`,
    shift_requirement_id: `req-${p.shift_name}-${p.role}`,
    start_time: '15:00',
    end_time: '21:00',
    hours: 6,
    required_count: 1,
    slot_index: 0,
    is_priority: false,
    ...p,
  };
}

function ev(id: string, date: string, shifts: EventShift[], endDate?: string): Event {
  return {
    id,
    company_id: 'c',
    title: 'Event',
    date,
    end_date: endDate ?? date,
    description: null,
    event_type: 'special_event',
    staffing_notes: null,
    shift_overrides: null,
    event_shifts: shifts as unknown as Event['event_shifts'],
    created_by: 'soteria',
    created_at: '',
    updated_at: '',
  } as Event;
}

// A simple base schedule: Afternoon Lifeguard (2) + Morning Lifeguard (1) on Sat.
const BASE: CanvasSlot[] = [
  slot({ date: SAT, shift_name: 'Afternoon', role: 'Lifeguard', slot_index: 0, required_count: 2 }),
  slot({ date: SAT, shift_name: 'Afternoon', role: 'Lifeguard', slot_index: 1, required_count: 2 }),
  slot({ date: SAT, shift_name: 'Morning', role: 'Lifeguard', start_time: '09:00', end_time: '15:00', hours: 6, required_count: 1 }),
  slot({ date: SUN, shift_name: 'Afternoon', role: 'Lifeguard', slot_index: 0, required_count: 1 }),
];

describe('applyEventShifts', () => {
  it('is a no-op when no event carries event_shifts', () => {
    const events = [ev('e0', SAT, [])];
    expect(applyEventShifts(BASE, events, WEEK)).toBe(BASE);
  });

  it('ADD: appends a one-off shift with custom hours, roles, and priority', () => {
    const events = [ev('e1', SAT, [
      { mode: 'add', shift_name: 'Swim Meet', start_time: '07:00', end_time: '14:00', roles: [{ role: 'Lifeguard', count: 3 }] },
    ])];
    const out = applyEventShifts(BASE, events, WEEK);
    const meet = out.filter(s => s.shift_name === 'Swim Meet');
    expect(meet).toHaveLength(3);
    expect(meet.every(s => s.date === SAT && s.role === 'Lifeguard' && s.start_time === '07:00' && s.end_time === '14:00')).toBe(true);
    expect(meet[0].hours).toBe(7);
    expect(meet.every(s => s.is_priority)).toBe(true);
    // Normal shifts are untouched (additive by default).
    expect(out.filter(s => s.shift_name === 'Afternoon' && s.date === SAT)).toHaveLength(2);
  });

  it('ADD + replaces: suppresses the named normal shift on that date only', () => {
    const events = [ev('e2', SAT, [
      { mode: 'add', shift_name: 'Swim Meet', start_time: '07:00', end_time: '14:00', roles: [{ role: 'Lifeguard', count: 2 }], replaces_shift_name: 'Afternoon' },
    ])];
    const out = applyEventShifts(BASE, events, WEEK);
    // Saturday Afternoon is gone...
    expect(out.filter(s => s.shift_name === 'Afternoon' && s.date === SAT)).toHaveLength(0);
    // ...but Sunday Afternoon survives, and the Swim Meet was added.
    expect(out.filter(s => s.shift_name === 'Afternoon' && s.date === SUN)).toHaveLength(1);
    expect(out.filter(s => s.shift_name === 'Swim Meet')).toHaveLength(2);
  });

  it('STRETCH: changes an existing shift’s hours and recomputes duration', () => {
    const events = [ev('e3', SAT, [
      { mode: 'stretch', shift_name: 'Morning', start_time: '06:00' },
    ])];
    const out = applyEventShifts(BASE, events, WEEK);
    const morning = out.find(s => s.shift_name === 'Morning' && s.date === SAT)!;
    expect(morning.start_time).toBe('06:00');
    expect(morning.end_time).toBe('15:00'); // unchanged
    expect(morning.hours).toBe(9);
  });

  it('STRETCH: per-role count override rebuilds the group', () => {
    const events = [ev('e4', SAT, [
      { mode: 'stretch', shift_name: 'Afternoon', roles: [{ role: 'Lifeguard', count: 4 }] },
    ])];
    const out = applyEventShifts(BASE, events, WEEK);
    const aft = out.filter(s => s.shift_name === 'Afternoon' && s.date === SAT && s.role === 'Lifeguard');
    expect(aft).toHaveLength(4);
    expect(aft.every(s => s.required_count === 4)).toBe(true);
  });

  it('only affects the event’s own dates', () => {
    const events = [ev('e5', SUN, [
      { mode: 'add', shift_name: 'Swim Meet', start_time: '07:00', end_time: '14:00', roles: [{ role: 'Lifeguard', count: 1 }] },
    ])];
    const out = applyEventShifts(BASE, events, WEEK);
    const meet = out.filter(s => s.shift_name === 'Swim Meet');
    expect(meet).toHaveLength(1);
    expect(meet[0].date).toBe(SUN);
  });
});
