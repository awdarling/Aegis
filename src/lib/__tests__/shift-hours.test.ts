import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/client', () => ({ supabase: { from: () => { throw new Error('no db in pure tests'); } } }));

import {
  resolveMeantHoursPure,
  parseExplicitRange,
  matchNamedShifts,
  senseInWords,
  windowsCoveringShifts,
  describeShifts,
  formatClock,
  formatClockRange,
  toHHMM,
  type ShiftTemplate,
} from '../shift-hours';
import type { ScheduleAssignment } from '../../workflows/schedule-build';

// Watermark's real shift definitions (live DB, 2026-08-26). Flex is inactive.
const WM: ShiftTemplate[] = [
  { id: 'am-we', name: 'AM Weekend', start_time: '09:00', end_time: '15:30', days_active: [0, 6], active: true },
  { id: 'am-wd', name: 'AM Weekday', start_time: '11:00', end_time: '15:30', days_active: [1, 2, 3, 4, 5], active: true },
  { id: 'gr-we', name: 'Weekend Greeter', start_time: '11:00', end_time: '19:30', days_active: [0, 6], active: true },
  { id: 'gr-wd', name: 'Weekday Greeter', start_time: '12:00', end_time: '19:30', days_active: [1, 2, 3, 4, 5], active: true },
  { id: 'flex', name: 'Flex', start_time: '13:00', end_time: '20:00', days_active: [0, 1, 2, 3, 4, 5, 6], active: false },
  { id: 'aft', name: 'Afternoon', start_time: '15:00', end_time: '20:15', days_active: [0, 1, 2, 3, 4, 5, 6], active: true },
];

const asg = (date: string, shift_name: string, start_time: string, end_time: string, employee_id = 'katie'): ScheduleAssignment =>
  ({ date, employee_id, employee_name: 'x', shift_name, role: 'Lifeguard', start_time, end_time, hours: 4.5 });

describe('formatClock — the one employee-facing time formatter (no seconds ever)', () => {
  it('drops seconds and :00', () => {
    expect(formatClock('11:00:00')).toBe('11am');
    expect(formatClock('15:30:00')).toBe('3:30pm');
    expect(formatClockRange('11:00:00', '15:30:00')).toBe('11am–3:30pm');
    expect(formatClock('12:00')).toBe('noon');
    expect(formatClock('00:00')).toBe('midnight');
    expect(formatClock('20:15')).toBe('8:15pm');
  });
  it('toHHMM normalises DB and human forms', () => {
    expect(toHHMM('15:30:00')).toBe('15:30');
    expect(toHHMM('3:30pm')).toBe('15:30');
    expect(toHHMM('12am')).toBe('00:00');
    expect(toHHMM('nope')).toBeNull();
  });
});

describe('parseExplicitRange — the employee\'s own numbers', () => {
  it('reads "11 to 3:30pm" as 11:00–15:30', () => {
    expect(parseExplicitRange('I can do 11 to 3:30pm on Fridays')).toEqual({ start_time: '11:00', end_time: '15:30' });
  });
  it('reads "9am-1pm" and "from 4pm until 8pm"', () => {
    expect(parseExplicitRange('9am-1pm')).toEqual({ start_time: '09:00', end_time: '13:00' });
    expect(parseExplicitRange('from 4pm until 8pm')).toEqual({ start_time: '16:00', end_time: '20:00' });
  });
  it('ignores words with no clock range', () => {
    expect(parseExplicitRange('the am shifts next week')).toBeNull();
    expect(parseExplicitRange('Friday August 21st in the morning')).toBeNull();
  });
});

describe('matchNamedShifts / senseInWords — tenant data, not hard-coded names', () => {
  it('"the am shifts" hits BOTH AM templates by the whole word "am"', () => {
    expect(matchNamedShifts('I want to work the am shifts next week', WM).map(t => t.id).sort()).toEqual(['am-wd', 'am-we']);
  });
  it('a full name wins over a token ("AM Weekday" → only that one)', () => {
    expect(matchNamedShifts('take me off the AM Weekday shift', WM).map(t => t.id)).toEqual(['am-wd']);
  });
  it('"flex" does not match an INACTIVE template', () => {
    expect(matchNamedShifts('the flex shift', WM)).toEqual([]);
  });
  it('"in the morning" is NOT a shift name here — it is a sense', () => {
    expect(matchNamedShifts('Friday August 21st in the morning', WM)).toEqual([]);
    expect(senseInWords('Friday August 21st in the morning')).toBe('morning');
    expect(senseInWords('I can only work pm shifts')).toBe('afternoon');
    expect(senseInWords("I'm sick and I can't make it tonight")).toBe('evening');
    expect(senseInWords('Saturdays')).toBeNull();
  });
});

describe('resolveMeantHoursPure — Mia Shaffer, Aug 14: "I want to work the am shifts next week"', () => {
  it('→ the AM shifts themselves (09:00–15:30 overall), never 09:00–12:00', () => {
    const r = resolveMeantHoursPure({ words: 'I want to work the am shifts next week', templates: WM, assignments: [] });
    expect(r).not.toBeNull();
    expect(r!.source).toBe('named_shift');
    expect(r!.start_time).toBe('09:00');
    expect(r!.end_time).toBe('15:30');
    expect(r!.shifts.map(s => s.name).sort()).toEqual(['AM Weekday', 'AM Weekend']);
  });
  it('windowsCoveringShifts is per-day accurate: Mon–Fri 11:00–15:30, Sat/Sun 09:00–15:30', () => {
    const r = resolveMeantHoursPure({ words: 'the am shifts', templates: WM, assignments: [] })!;
    const win = windowsCoveringShifts(r.shifts);
    expect(win.find(w => w.day_of_week === 1)).toEqual({ day_of_week: 1, start_time: '11:00', end_time: '15:30' });
    expect(win.find(w => w.day_of_week === 6)).toEqual({ day_of_week: 6, start_time: '09:00', end_time: '15:30' });
    expect(win.length).toBe(7);
    // restricted to the days the employee named
    expect(windowsCoveringShifts(r.shifts, [1, 2, 3, 4, 5]).map(w => w.day_of_week)).toEqual([1, 2, 3, 4, 5]);
  });
  it('the confirm names the shifts with human times', () => {
    const r = resolveMeantHoursPure({ words: 'the am shifts', templates: WM, assignments: [] })!;
    const sorted = [...r.shifts].sort((a, b) => a.name.localeCompare(b.name));
    expect(describeShifts(sorted)).toBe('AM Weekday (11am–3:30pm) and AM Weekend (9am–3:30pm)');
  });
});

describe('resolveMeantHoursPure — Mia, Aug 11: "Next week I can only work pm shifts Monday through Friday"', () => {
  it('→ every shift starting at or after noon (sense), 12:00–20:15', () => {
    const r = resolveMeantHoursPure({ words: 'Next week I can only work pm shifts Monday through Friday', templates: WM, assignments: [] })!;
    expect(r.source).toBe('sense');
    expect(r.start_time).toBe('12:00');
    expect(r.end_time).toBe('20:15');
    expect(r.shifts.map(s => s.name).sort()).toEqual(['Afternoon', 'Weekday Greeter']);
  });
});

describe('resolveMeantHoursPure — Katie, "Friday August 21st in the morning" with an 11:00–15:30 AM Weekday assignment', () => {
  it('→ THAT shift (11:00–15:30), shift_name filled — not 09:00–13:00', () => {
    const r = resolveMeantHoursPure({
      words: 'I cannot work Friday August 21st in the morning',
      date: '2026-08-21',
      templates: WM,
      assignments: [asg('2026-08-21', 'AM Weekday', '11:00:00', '15:30:00')],
    })!;
    expect(r.source).toBe('assignment');
    expect(r.start_time).toBe('11:00');
    expect(r.end_time).toBe('15:30');
    expect(r.shift_name).toBe('AM Weekday');
    expect(r.shift_id).toBe('am-wd');
  });
});

describe('resolveMeantHoursPure — Mia, Aug 21: "I\'m sick and I can\'t make it tonight" with NO assignment', () => {
  it('→ null (ask), never 17:00–21:00', () => {
    const r = resolveMeantHoursPure({ words: "I'm sick and I can't make it tonight", date: '2026-08-21', templates: WM, assignments: [] });
    expect(r).toBeNull();
  });
  it('a named shift on a day with no assignment is still null (not scheduled → ask)', () => {
    const r = resolveMeantHoursPure({ words: "can't do my afternoon shift Friday", date: '2026-08-21', templates: WM, assignments: [] });
    expect(r).toBeNull();
  });
});

describe('resolveMeantHoursPure — double-shift day', () => {
  const two = [asg('2026-08-22', 'AM Weekend', '09:00:00', '15:30:00'), asg('2026-08-22', 'Afternoon', '15:00:00', '20:15:00')];
  it('"this morning" picks the AM one', () => {
    expect(resolveMeantHoursPure({ words: 'sick this morning', date: '2026-08-22', templates: WM, assignments: two })!.shift_name).toBe('AM Weekend');
  });
  it('"tonight" picks the Afternoon one', () => {
    expect(resolveMeantHoursPure({ words: "can't make it tonight", date: '2026-08-22', templates: WM, assignments: two })!.shift_name).toBe('Afternoon');
  });
  it('no descriptor → null (ask which)', () => {
    expect(resolveMeantHoursPure({ words: 'need Saturday off partly', date: '2026-08-22', templates: WM, assignments: two })).toBeNull();
  });
  it('explicit clock always wins', () => {
    expect(resolveMeantHoursPure({ words: 'leave at 1pm-3pm Saturday', date: '2026-08-22', templates: WM, assignments: two })!.source).toBe('explicit');
  });
});

describe('a brand-new tenant with "Lunch/Dinner/Close" shifts works with zero code change', () => {
  const diner: ShiftTemplate[] = [
    { id: 'l', name: 'Lunch', start_time: '10:30', end_time: '14:30', days_active: [1, 2, 3, 4, 5], active: true },
    { id: 'd', name: 'Dinner', start_time: '16:00', end_time: '21:00', days_active: [1, 2, 3, 4, 5, 6], active: true },
    { id: 'c', name: 'Close', start_time: '19:00', end_time: '23:30', days_active: [4, 5, 6], active: true },
  ];
  it('"mornings" → Lunch by start time; "nights" → the late block (Dinner + Close); "dinner" by name', () => {
    expect(resolveMeantHoursPure({ words: 'I can work mornings', templates: diner, assignments: [] })!.shift_name).toBe('Lunch');
    expect(resolveMeantHoursPure({ words: 'I can work nights', templates: diner, assignments: [] })!.shifts.map(s => s.name).sort()).toEqual(['Close', 'Dinner']);
    expect(resolveMeantHoursPure({ words: 'only dinner shifts', templates: diner, assignments: [] })!.shift_name).toBe('Dinner');
  });
});

describe('a date in a week with NO schedule yet (new hire / not built) — unknown, not "not scheduled"', () => {
  it('"the afternoon of the 20th" → the club\'s own "Afternoon" shift by NAME (3pm–8:15pm), not a clock table', () => {
    const r = resolveMeantHoursPure({ words: 'the afternoon of the 20th', date: '2026-08-20', templates: WM, assignments: [], scheduleExists: false })!;
    expect(r).not.toBeNull();
    expect(r.source).toBe('named_shift');
    expect(r.start_time).toBe('15:00');
    expect(r.end_time).toBe('20:15');
    expect(r.shift_name).toBe('Afternoon');
  });
  it('"the morning of the 20th" (a Thursday) → AM Weekday only, by weekday + start time', () => {
    const r = resolveMeantHoursPure({ words: 'the morning of the 20th', date: '2026-08-20', templates: WM, assignments: [], scheduleExists: false })!;
    expect(r.source).toBe('sense');
    expect(r.shift_name).toBe('AM Weekday');
    expect(r.start_time).toBe('11:00');
  });
  it('but with a schedule that exists and no shift → null (ask)', () => {
    expect(resolveMeantHoursPure({ words: 'the afternoon of the 20th', date: '2026-08-20', templates: WM, assignments: [], scheduleExists: true })).toBeNull();
  });
});
