// ── "What hours does this employee mean?" — ONE resolver (Rule 0b) ───────────
//
// W-1 branch 2 (J-1a, C-4, J-1b — 2026-08-26). Three workflows used to turn words
// like "morning", "tonight" and "the AM shifts" into CLOCK hours from a hard-coded
// table (morning 09–13, afternoon 13–17, evening 17–21; the availability parser
// used earliest_start–12:00). None of those windows are a shift this club runs.
// The damage on the live client:
//   • Mia Shaffer "I want to work the am shifts next week" → an availability
//     override 09:00–12:00 that made her INELIGIBLE for every AM shift (the AM
//     shifts are 11:00–15:30 weekdays, 09:00–15:30 weekends). Jack approved it;
//     she got 0 shifts.
//   • Mia "I'm sick and I can't make it tonight" → time off 17:00–21:00 on a day
//     she had no shift at all.
//   • Katie "Friday August 21st in the morning" → 09:00–13:00 when her real
//     Friday shift was 11:00–15:30.
//
// The rule: shift words resolve against the TENANT'S OWN DATA — the company's
// shift definitions (`shift_types`) and the employee's published assignments —
// never a clock guess presented as fact. Order:
//   (1) an explicit clock range in the words ("11 to 3:30", "from 4pm")
//   (2) a shift the company has DEFINED, named in the words ("AM Weekday",
//       "afternoon", "flex") → that shift's hours
//   (3) if a date is given and the employee has a published assignment that
//       day → that assignment's hours (narrowed by the words on a double-shift day)
//   (4) with NO date, a time-of-day SENSE ("morning/AM" = shifts that start
//       before noon; "afternoon/PM/evening/night" = shifts that start at or
//       after noon), derived from the company's shift START TIMES — not from
//       the shift's name, so a "Lunch/Dinner/Close" tenant works unchanged
//   (5) otherwise null — the caller asks; nothing is invented.
//
// Sense (4) is deliberately NOT consulted when a date was given: a person who
// says "sick tonight" on a day they aren't scheduled gets asked, not booked
// off 15:00–20:15. (The order of (2) before (3) is the kickoff's; in practice a
// named shift on a date the employee is assigned to is the same answer.)
//
// Deterministic. No model call.

import { supabase } from '../db/client';
import type { ScheduleAssignment } from '../workflows/schedule-build';

type ScheduleData = { assignments?: ScheduleAssignment[] };

export interface ShiftTemplate {
  id: string;
  name: string;
  start_time: string;   // HH:MM or HH:MM:SS
  end_time: string;
  days_active: number[]; // 0=Sunday..6=Saturday
  active?: boolean | null;
}

export type MeantHoursSource = 'explicit' | 'named_shift' | 'assignment' | 'sense';

export interface MeantHours {
  start_time: string;   // HH:MM
  end_time: string;     // HH:MM
  shift_id: string | null;
  shift_name: string | null;
  source: MeantHoursSource;
  /** Every template that matched (named/sense) — for availability windows and confirm copy. */
  shifts: ShiftTemplate[];
}

// ── time helpers ──────────────────────────────────────────────────────────────

/** "15:30:00" | "15:30" | "3:30pm" → "15:30". Returns null when unparseable. */
export function toHHMM(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase();
  let m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)$/);
  if (m) {
    let h = parseInt(m[1], 10);
    const mm = m[2] ?? '00';
    const pm = m[3].startsWith('p');
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${mm}`;
  }
  return null;
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * The one employee-facing time formatter: "11:00:00"–"15:30:00" → "11am–3:30pm".
 * Never leaks seconds; drops ":00" on the hour; noon/midnight spelled out.
 * (C-7 "one formatter" — every employee-facing shift string should use this.)
 */
export function formatClock(raw: string): string {
  const hhmm = toHHMM(raw) ?? raw;
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const m = Number(mStr ?? 0);
  if (Number.isNaN(h)) return raw;
  if (h === 12 && m === 0) return 'noon';
  if (h === 0 && m === 0) return 'midnight';
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

export function formatClockRange(start: string, end: string): string {
  return `${formatClock(start)}–${formatClock(end)}`;
}

// ── (1) explicit clock range in the words ─────────────────────────────────────

const TIME_TOKEN = String.raw`(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)|\d{1,2}:\d{2})`;
// A bare hour ("11 to 3:30pm", "9 until 1pm") is accepted as the START only —
// the END must carry a meridiem or minutes so "Aug 21 to 23" is never read as a
// clock range.
const START_TOKEN = String.raw`(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)|\d{1,2}:\d{2}|\d{1,2})`;

/** "11 to 3:30pm", "11am-3:30pm", "from 9 until 1pm" → { start, end } in HH:MM; else null. */
export function parseExplicitRange(words: string): { start_time: string; end_time: string } | null {
  const t = (words || '').toLowerCase().replace(/–|—/g, '-');
  const re = new RegExp(`(?<![\\d:])${START_TOKEN}\\s*(?:-|to|until|till|thru|through)\\s*${TIME_TOKEN}(?![\\d:])`);
  const m = t.match(re);
  if (!m) return null;
  let a = m[1].replace(/\s+/g, '');
  const b = m[2].replace(/\s+/g, '');
  // A bare start with a bare-hour end that has no meridiem is not a clock range.
  if (/^\d{1,2}$/.test(a) && !/am|pm|a\.m\.|p\.m\./.test(b)) return null;
  // "11 to 3:30pm": inherit the meridiem from the end when the start has none
  // and the bare start would otherwise land before the end on a 24h read.
  const bMer = b.match(/am|pm|a\.m\.|p\.m\./)?.[0];
  if (!/am|pm|a\.m\.|p\.m\./.test(a) && bMer) {
    const aNum = parseInt(a, 10);
    const bNum = parseInt(b, 10);
    const bPm = bMer.startsWith('p');
    // "11 to 3:30pm" → 11am; "1 to 3:30pm" → 1pm; "9 to 1pm" → 9am.
    a = aNum > bNum && bPm ? `${a}am` : `${a}${bMer}`;
  }
  const start = toHHMM(a);
  const end = toHHMM(b);
  if (!start || !end) return null;
  if (minutes(start) >= minutes(end)) return null;
  return { start_time: start, end_time: end };
}

// ── (2) a defined shift named in the words ────────────────────────────────────

function norm(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Shift templates whose NAME appears in the words, longest names first so
 * "AM Weekday" wins over a bare "AM" when both are present. A bare token like
 * "am"/"pm" matches every template whose name contains that whole word
 * ("AM Weekday" AND "AM Weekend" for "the AM shifts"). Optional `dayOfWeek`
 * restricts to templates active that day.
 */
export function matchNamedShifts(words: string, templates: ShiftTemplate[], dayOfWeek?: number | null): ShiftTemplate[] {
  const w = ` ${norm(words)} `;
  if (!w.trim()) return [];
  const live = templates.filter(t => t.active !== false && (dayOfWeek == null || t.days_active.includes(dayOfWeek)));
  // Full-name hits first.
  const full = live.filter(t => {
    const n = norm(t.name);
    return n.length > 0 && w.includes(` ${n} `);
  });
  if (full.length > 0) return full;
  // Single-word hits: a template whose name contains a token that appears as a
  // whole word in the message (e.g. "am", "flex", "afternoon", "greeter").
  // Generic words that name a time of day but are NOT a shift name on their own
  // are left to sense matching (step 4) — except when they literally are a
  // template's whole name (handled above).
  const generic = new Set(['weekday', 'weekend', 'shift', 'shifts', 'the', 'a', 'an']);
  return live.filter(t => {
    const tokens = norm(t.name).split(' ').filter(tok => tok.length >= 2 && !generic.has(tok));
    return tokens.some(tok => w.includes(` ${tok} `));
  });
}

// ── (4) time-of-day sense from the company's shift START times ────────────────

export type DaySense = 'morning' | 'afternoon' | 'evening';

/**
 * The time-of-day sense in the message, or null. "morning"/"AM" → morning;
 * "afternoon"/"PM" → afternoon (any shift starting at or after noon);
 * "evening"/"night"/"tonight" → evening (the latest-starting block).
 */
export function senseInWords(words: string): DaySense | null {
  const t = (words || '').toLowerCase();
  if (/\b(morning|mornings|a\.?m\.?)\b/.test(t)) return 'morning';
  if (/\b(afternoon|afternoons|p\.?m\.?)\b/.test(t)) return 'afternoon';
  if (/\b(evening|evenings|night|nights|tonight)\b/.test(t)) return 'evening';
  return null;
}

/** Templates whose START time falls in the sense window. Afternoon means "starts at or after noon"; evening prefers the later starters when the club has both. */
export function matchShiftsBySense(sense: DaySense, templates: ShiftTemplate[], dayOfWeek?: number | null): ShiftTemplate[] {
  const live = templates.filter(t => t.active !== false && (dayOfWeek == null || t.days_active.includes(dayOfWeek)));
  const start = (t: ShiftTemplate) => minutes(toHHMM(t.start_time) ?? '00:00');
  if (sense === 'morning') return live.filter(t => start(t) < 12 * 60);
  const pm = live.filter(t => start(t) >= 12 * 60);
  if (sense === 'afternoon') return pm;
  // evening / "tonight": a pm shift that runs into the evening (ends 6pm or later).
  const end = (t: ShiftTemplate) => minutes(toHHMM(t.end_time) ?? '00:00');
  const evening = pm.filter(t => end(t) >= 18 * 60);
  return evening.length > 0 ? evening : pm;
}

// ── data loaders ──────────────────────────────────────────────────────────────

export async function loadShiftTemplates(companyId: string): Promise<ShiftTemplate[]> {
  const { data } = await supabase
    .from('shift_types')
    .select('id, name, start_time, end_time, days_active, active')
    .eq('company_id', companyId)
    .eq('active', true);
  return ((data ?? []) as ShiftTemplate[]).map(t => ({
    ...t,
    start_time: toHHMM(t.start_time) ?? t.start_time,
    end_time: toHHMM(t.end_time) ?? t.end_time,
    days_active: Array.isArray(t.days_active) ? t.days_active : [0, 1, 2, 3, 4, 5, 6],
  }));
}

/**
 * The employee's published (or, failing that, draft) assignments on a date, and
 * whether ANY schedule covers that week. "Not scheduled" is only an honest thing
 * to say when a schedule exists and the employee isn't on it; for a week that
 * hasn't been built yet the answer is "unknown", and the resolver falls back to
 * the company's shift definitions for that weekday.
 */
export async function loadAssignmentsOnDate(
  companyId: string,
  employeeId: string,
  date: string,
): Promise<{ scheduleExists: boolean; assignments: ScheduleAssignment[] }> {
  const base = () => supabase.from('schedules').select('id, data').is('deleted_at', null)
    .eq('company_id', companyId).lte('week_start', date).gte('week_end', date)
    .order('published_at', { ascending: false, nullsFirst: false }).limit(1);
  const { data: pub } = await base().eq('status', 'published').maybeSingle();
  let sched = (pub as { data: ScheduleData } | null)?.data ?? null;
  if (!sched) {
    const { data: draft } = await base().eq('status', 'draft').maybeSingle();
    sched = (draft as { data: ScheduleData } | null)?.data ?? null;
  }
  if (!sched) return { scheduleExists: false, assignments: [] };
  const assignments = Array.isArray(sched.assignments) ? sched.assignments : [];
  return { scheduleExists: true, assignments: assignments.filter((a: ScheduleAssignment) => a.employee_id === employeeId && a.date === date) };
}

function dayOfWeekOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

// ── the resolver ──────────────────────────────────────────────────────────────

export interface ResolveMeantHoursInput {
  companyId: string;
  employeeId: string;
  /** YYYY-MM-DD when the words are about a specific day (partial time off). */
  date?: string | null;
  words: string;
  /** Test seam / batching: pass pre-loaded data to skip the DB reads. */
  templates?: ShiftTemplate[];
  assignments?: ScheduleAssignment[];
  /** Whether a schedule covers `date` at all (default true when assignments are passed). */
  scheduleExists?: boolean;
}

/** Pure core — same rules, no I/O. Exported for tests and for callers that already hold the data. */
export function resolveMeantHoursPure(input: {
  words: string;
  date?: string | null;
  templates: ShiftTemplate[];
  assignments: ScheduleAssignment[];
  /** false = no schedule has been built for that week yet (unknown, not "not scheduled"). Default true. */
  scheduleExists?: boolean;
}): MeantHours | null {
  const { words, date, templates, assignments } = input;
  const scheduleExists = input.scheduleExists !== false;

  // (1) explicit clock range — the employee's own numbers always win.
  const explicit = parseExplicitRange(words);
  if (explicit) {
    return { ...explicit, shift_id: null, shift_name: null, source: 'explicit', shifts: [] };
  }

  // A SPECIFIC DAY (partial time off): the answer is one of the employee's own
  // assignments that day, or nothing. Not scheduled → null → the caller asks.
  // A shift name or a time-of-day word only picks WHICH of their shifts on a
  // double-shift day; it never conjures hours on a day they're not working.
  if (date && scheduleExists) {
    const mine = assignments.filter(a => a.date === date);
    if (mine.length === 0) return null;
    const fromAssignment = (a: ScheduleAssignment): MeantHours => {
      const tpl = templates.find(t => t.name === a.shift_name) ?? null;
      return { start_time: toHHMM(a.start_time)!, end_time: toHHMM(a.end_time)!, shift_id: tpl?.id ?? null, shift_name: a.shift_name, source: 'assignment', shifts: tpl ? [tpl] : [] };
    };
    if (mine.length === 1) return fromAssignment(mine[0]);
    const named = matchNamedShifts(words, templates, dayOfWeekOf(date));
    const byName = mine.filter(a => named.some(n => n.name === a.shift_name));
    if (byName.length === 1) return fromAssignment(byName[0]);
    const sense = senseInWords(words);
    const bySense = sense
      ? mine.filter(a => {
          const s = minutes(toHHMM(a.start_time) ?? '00:00');
          return sense === 'morning' ? s < 12 * 60 : s >= 12 * 60;
        })
      : [];
    if (bySense.length === 1) return fromAssignment(bySense[0]);
    return null; // two shifts that day and the words don't settle it → ask
  }

  // NO DATE (an availability pattern) — or a date in a week with no schedule yet
  // (a new hire, a future week): the company's own shift definitions, restricted
  // to that weekday when a date is known.
  const dow = date ? dayOfWeekOf(date) : null;
  const pickFrom = (hits: ShiftTemplate[], source: MeantHoursSource): MeantHours => {
    const start = hits.map(t => minutes(t.start_time)).sort((a, b) => a - b)[0];
    const end = hits.map(t => minutes(t.end_time)).sort((a, b) => b - a)[0];
    return {
      start_time: hits.find(t => minutes(t.start_time) === start)!.start_time,
      end_time: hits.find(t => minutes(t.end_time) === end)!.end_time,
      shift_id: hits.length === 1 ? hits[0].id : null,
      shift_name: hits.length === 1 ? hits[0].name : hits.map(h => h.name).join(' / '),
      source,
      shifts: hits,
    };
  };

  // (2) a defined shift, named ("the AM shifts", "flex", "afternoon")
  const named = matchNamedShifts(words, templates, dow);
  if (named.length > 0) return pickFrom(named, 'named_shift');

  // (4) a time-of-day sense against the company's shift START times
  const sense = senseInWords(words);
  if (sense) {
    const hits = matchShiftsBySense(sense, templates, dow);
    if (hits.length > 0) return pickFrom(hits, 'sense');
  }

  // (5) nothing honest to say
  return null;
}

export async function resolveMeantHours(input: ResolveMeantHoursInput): Promise<MeantHours | null> {
  const templates = input.templates ?? (await loadShiftTemplates(input.companyId));
  let assignments = input.assignments ?? [];
  let scheduleExists = input.scheduleExists ?? true;
  if (!input.assignments && input.date) {
    const loaded = await loadAssignmentsOnDate(input.companyId, input.employeeId, input.date);
    assignments = loaded.assignments;
    scheduleExists = loaded.scheduleExists;
  }
  return resolveMeantHoursPure({ words: input.words, date: input.date ?? null, templates, assignments, scheduleExists });
}

// ── availability windows from matched shifts ──────────────────────────────────

export interface WindowSlot { day_of_week: number; start_time: string; end_time: string }

/**
 * For an availability change phrased in shift terms ("the AM shifts"), the
 * windows that COVER those shifts on each day they run. Per-day accurate: for
 * Watermark's "AM shifts" that is Mon–Fri 11:00–15:30 and Sat/Sun 09:00–15:30.
 * `days` (0..6) restricts to the days the employee named ("Monday through
 * Friday"); omit for every day the shifts run.
 */
export function windowsCoveringShifts(shifts: ShiftTemplate[], days?: number[] | null): WindowSlot[] {
  const out: WindowSlot[] = [];
  for (let d = 0; d <= 6; d++) {
    if (days && days.length > 0 && !days.includes(d)) continue;
    const onDay = shifts.filter(s => s.days_active.includes(d));
    if (onDay.length === 0) continue;
    const start = onDay.map(s => minutes(s.start_time)).sort((a, b) => a - b)[0];
    const end = onDay.map(s => minutes(s.end_time)).sort((a, b) => b - a)[0];
    out.push({
      day_of_week: d,
      start_time: onDay.find(s => minutes(s.start_time) === start)!.start_time,
      end_time: onDay.find(s => minutes(s.end_time) === end)!.end_time,
    });
  }
  return out;
}

/** "AM Weekday (11am–3:30pm) and AM Weekend (9am–3:30pm)" */
export function describeShifts(shifts: ShiftTemplate[]): string {
  const parts = shifts.map(s => `${s.name} (${formatClockRange(s.start_time, s.end_time)})`);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Does this text talk about shifts in the company's terms (a named shift or a time-of-day word)? */
export function mentionsShiftTerms(words: string, templates: ShiftTemplate[]): boolean {
  return matchNamedShifts(words, templates).length > 0 || senseInWords(words) !== null;
}
