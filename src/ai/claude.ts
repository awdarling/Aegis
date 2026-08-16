import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { coerceJsonObject } from '../utils/coerce-json';

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-6';

// ── Retry / overload handling ─────────────────────────────────────────────────
// NOTE: The Homebase Soteria routes
// (src/app/api/soteria-validate-schedule/route.ts and
// src/app/api/soteria-validate-assignment/route.ts) live in a different repo
// and make their own Anthropic calls — they need the same retry treatment as
// what is implemented here. Follow-up in the Homebase repo.

export class AnthropicOverloadError extends Error {
  constructor(message = 'Anthropic API overloaded after 3 attempts') {
    super(message);
    this.name = 'AnthropicOverloadError';
  }
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 2000]; // delay before attempt 2, then before attempt 3
const RETRYABLE_STATUSES = new Set([500, 503, 529]);

function getRetryableStatus(err: unknown): number | null {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === 'number' && RETRYABLE_STATUSES.has(status)) {
      return status;
    }
  }
  return null;
}

export async function withAnthropicRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  let lastStatus: number | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const status = getRetryableStatus(err);
      if (status === null) throw err;
      lastErr = err;
      lastStatus = status;
      if (attempt < MAX_ATTEMPTS) {
        const delayMs = RETRY_DELAYS_MS[attempt - 1];
        console.log(
          `[claude] API overloaded, retry attempt ${attempt + 1}/${MAX_ATTEMPTS} in ${delayMs / 1000}s...`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  if (lastStatus === 529) {
    throw new AnthropicOverloadError();
  }
  throw lastErr;
}

export interface ClassifyResult {
  intent: string;
  confidence: 'high' | 'medium' | 'low';
  extracted: Record<string, unknown>;
}

// ── Intent lists by role ──────────────────────────────────────────────────────

export const EMPLOYEE_INTENTS = [
  'submit_time_off',
  'query_my_time_off',
  'query_my_shifts',
  'query_my_availability',
  'update_availability',
  'report_departure',
  'initiate_swap',
  'respond_swap_accept',
  'respond_swap_decline',
  'operational_query',
  'general_question',
  'capabilities',
] as const;

export const MANAGER_INTENTS = [
  ...EMPLOYEE_INTENTS,
  'approve_time_off',
  'deny_time_off',
  'approve_swap',
  'deny_swap',
  'initiate_onboarding',
  'add_employee',
  'request_emergency_coverage',
  'build_schedule',
  'distribute_schedule',
  'run_payroll_check',
  'homebase_edit',
  'notify_day_closure',
  'recheck_time_off',
  // Managers CAN broadcast to their OWN company (Batch-1 F4). Targeting is scoped
  // to all / employees / a role / specific people; managers-only targeting stays a
  // quria-admin action (enforced in handleBroadcast by role).
  'broadcast_message',
] as const;

export const QURIA_INTENTS = [
  ...MANAGER_INTENTS,
  'quria_diagnostic',
] as const;

// ── Public API ────────────────────────────────────────────────────────────────

// Classifies the intent of an inbound message given the caller's role.
// Returns structured JSON — if parsing fails, intent is 'unknown'.
export async function classifyIntent(
  message: string,
  role: 'employee' | 'manager' | 'quria_admin',
  companyContext: string,
  companyTimezone: string
): Promise<ClassifyResult> {
  // Anchor relative-date resolution (e.g. "Friday", "June 5") to today in the
  // company's local timezone. Without this the model has no reliable date
  // reference and frequently resolves bare month-day phrases to the prior year.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: companyTimezone }).format(new Date());
  const currentYear = today.slice(0, 4);
  const systemPrompt = buildClassifySystemPrompt(role, companyContext, today, currentYear);

  const response = await withAnthropicRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }],
    })
  );

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  const parsed = coerceJsonObject<ClassifyResult>(text) ??
    { intent: 'unknown', confidence: 'low', extracted: {} };

  return applyManagerCoverageBackstop(
    applyDepartureBackstop(
      applyBareTimeOffBackstop(applyAvailabilityBackstop(parsed, message), message),
      message
    ),
    message,
    role
  );
}

// A MANAGER reporting that a THIRD PARTY can't work is an emergency-coverage
// call-out, not a swap (a coworker's own trade) and not the manager's own time
// off. The classifier had zero few-shots for request_emergency_coverage and the
// informal rules steered "<name> can't work" to initiate_swap / submit_time_off
// (live 2026-08-10, finding #11). This deterministic seam upgrades those to
// coverage when a manager reports someone ELSE out. Deliberately narrow: it never
// fires on first-person ("I can't work") or on "my shift" (the sender's own),
// so a manager's own time-off / swap is left to the model.
export function looksLikeManagerCoverageCallout(body: string): boolean {
  const b = body.trim().toLowerCase();
  if (!b) return false;
  // The sender's OWN shift is a swap, never coverage.
  if (/\bmy\s+(shift|shifts)\b/.test(b)) return false;
  // A manager's direct ask to fill a hole — coverage regardless of a named person.
  // Checked BEFORE the first-person guard so "I need someone to cover …" counts
  // (the guard only excludes the sender's OWN absence, e.g. "I need Friday off").
  if (/\b(emergency\s+coverage|need\s+coverage|coverage\s+(for|needed)|need\s+(someone|somebody|a\s+(sub|replacement|fill[-\s]?in|guard|lifeguard))\s+(to\s+)?(cover|fill|work|come\s+in)|find\s+(a\s+)?(sub|replacement|cover)|fill\s+(the|a)\s+\w+\s+shift)\b/.test(b)) {
    return true;
  }
  // First-person = the sender's OWN absence — that's their time off / swap, not
  // a coverage call-out for someone else.
  if (/^(i|i'?m|im|we|we'?re)\b/.test(b)) return false;
  if (/\bi\s+(can'?t|cannot|can\s?not|need|won'?t)\b/.test(b)) return false;
  // Third-party call-out: <someone other than the sender> + can't-work language.
  // The subject clause must NOT be the sender ("I"/"we") — guarded above.
  const callout = /(can'?t|cannot|can\s?not)\s+(work|make\s+it|come\s+in|be\s+(here|in))|call(ed)?\s+(in|out)(\s+sick)?|is\s+(out|sick)\b|out\s+sick\b|won'?t\s+(make\s+it|be\s+(in|here))|phoned\s+in\s+sick/;
  if (callout.test(b)) {
    // Require a plausible third-party subject before the call-out verb: a proper
    // name, a pronoun (he/she/they), or a role/"someone". "off tuesday" etc. with
    // no subject stays with the model.
    const subject = /\b([a-z]+|he|she|they|someone|somebody|nobody)\b\s+(can'?t|cannot|can\s?not|call(ed)?|is\s+(out|sick)|out\s+sick|won'?t|phoned)/;
    return subject.test(b);
  }
  return false;
}

// Deterministic backstop for finding #11. When the sender is a MANAGER/QURIA and
// the model landed on initiate_swap or submit_time_off but the message is clearly
// a third-party coverage call-out, reclassify to request_emergency_coverage. The
// coverage handler re-extracts the absent person + shift from the body, so an
// empty extracted is fine here. Never touches employee senders.
export function applyManagerCoverageBackstop(
  result: ClassifyResult,
  message: string,
  role: 'employee' | 'manager' | 'quria_admin'
): ClassifyResult {
  if (role === 'employee') return result;
  if (result.intent !== 'initiate_swap' && result.intent !== 'submit_time_off') return result;
  if (!looksLikeManagerCoverageCallout(message)) return result;
  return {
    intent: 'request_emergency_coverage',
    confidence: result.confidence === 'low' ? 'medium' : result.confidence,
    extracted: {},
  };
}

// A purely-positive availability statement ("I can work …", "I'm available …")
// states when the employee CAN work — the opposite of time off. The classifier
// occasionally mis-fires these to submit_time_off when a specific date/week is
// present (the "specific date wins" rule). Returns true ONLY for clearly positive
// statements with NO off/can't/unavailable language, so mixed messages ("I can
// work Mon but need Fri off") are left to the model.
export function looksLikePositiveAvailability(body: string): boolean {
  const positive = /\bi can work\b|\bi can do\b|\bi['’ ]?a?m available\b|\bavailable to work\b|\bput me down for\b|\bi['’ ]?a?m free\b/i.test(body);
  if (!positive) return false;
  const negative = /\boff\b|\bcan['’]?t\b|\bcannot\b|\bcan ?not\b|\bunavailable\b|\bno more\b|\btake me off\b|\bneed[s]?\b.*\boff\b/i.test(body);
  return !negative;
}

// Deterministic backstop for the availability-vs-time-off bug: if the model picked
// submit_time_off but the message is a clear positive availability statement,
// reclassify to update_availability. Carries the date-range end (if the model
// captured one) into end_date so a week-bounded statement stays date-limited.
export function applyAvailabilityBackstop(result: ClassifyResult, message: string): ClassifyResult {
  if (result.intent !== 'submit_time_off' || !looksLikePositiveAvailability(message)) return result;
  const ex = (result.extracted ?? {}) as Record<string, unknown>;
  const dates = Array.isArray(ex.dates) ? (ex.dates as Array<Record<string, unknown>>) : [];
  const ends = dates
    .map(d => d?.end_date)
    .filter((s): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s))
    .sort();
  const lastEnd = ends.length ? ends[ends.length - 1] : null;
  return {
    intent: 'update_availability',
    confidence: result.confidence,
    extracted: lastEnd ? { end_date: lastEnd } : {},
  };
}

// A bare intent to request time off with NO date ("I want to request time off",
// "I need to put in for a day off") kept landing in general_question, which then
// hallucinated a "log into Homebase" process. It is unambiguously a time-off
// REQUEST — route it to submit_time_off (the workflow then asks for the dates).
// Deliberately narrow, mirroring looksLikePositiveAvailability: it fires ONLY for
// an explicit want/need to take time off, with no date and no how-to/status
// framing, so time-off QUERIES ("what time off do I have?"), how-to questions
// ("how do I request time off?"), dated requests (the model handles those), and
// availability phrasing ("take me off Thursdays") are all left untouched.
export function looksLikeBareTimeOffRequest(body: string): boolean {
  const b = body.trim().toLowerCase();
  if (!b) return false;
  // How-to / status / already-exists questions are NOT a new request.
  if (/\b(how|what|when|where|why|status|already|approved|do i have|did i)\b/.test(b)) return false;
  // Cancellations, withdrawals, and negations are NOT a fresh request — the word
  // "need" matches even in "I DON'T need time off anymore", so exclude those
  // explicitly ("never mind", "changed my mind", "cancel", "no longer", etc.).
  if (/\b(don'?t|do not|no longer|never ?mind|change[d]? my mind|cancel|withdraw|retract|forget|nvm|scratch that|nix)\b/.test(b)) return false;
  // Must be about TAKING time off specifically (not "leave early", not "off Tuesdays").
  if (!/\b(time[-\s]?off|days? off|pto|vacation)\b/.test(b)) return false;
  // Must read as wanting / needing to MAKE the request.
  if (!/\b(request|put ?in|putting in|submit|take|book|get|need|want|wanna|would like|like to|gonna)\b/.test(b)) return false;
  // If a concrete or relative date is present, the normal classifier handles it
  // (and extracts the dates), so don't backstop those.
  const hasDate =
    /\b\d{1,2}(st|nd|rd|th)?\b/.test(b) ||
    /\b(jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)/.test(b) ||
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(b) ||
    /\b(today|tomorrow|tonight|this week|next week|this weekend|next weekend)\b/.test(b);
  return !hasDate;
}

// Deterministic backstop for the bare-time-off-request bug. ONLY upgrades from
// the "general" buckets (general_question / operational_query / unknown) so it
// can never override a confident, more specific action the model already found.
export function applyBareTimeOffBackstop(result: ClassifyResult, message: string): ClassifyResult {
  if (
    result.intent !== 'general_question' &&
    result.intent !== 'operational_query' &&
    result.intent !== 'unknown'
  ) {
    return result;
  }
  if (!looksLikeBareTimeOffRequest(message)) return result;
  return {
    intent: 'submit_time_off',
    confidence: result.confidence === 'low' ? 'medium' : result.confidence,
    extracted: {},
  };
}

// True for a clear employee DEPARTURE signal (quitting / resigning / naming a last
// day). Deliberately narrow, mirroring looksLikeBareTimeOffRequest: it fires only on
// unambiguous leaving-the-job phrasing so it never swallows time-off or a schedule
// question. Excludes retractions ("never mind, not quitting").
export function looksLikeDeparture(body: string): boolean {
  const b = body.toLowerCase();
  if (/\b(don'?t|do not|never ?mind|not (quitting|leaving|resigning)|change[d]? my mind|cancel|nvm|scratch that|kidding|jk)\b/.test(b)) return false;
  // "last day" as employment, "two weeks(' notice)", quit/resign/leaving-the-job.
  const departure =
    /\bmy last day\b/.test(b) ||
    /\b(two|2)[-\s]?weeks?('?s)?( notice)?\b/.test(b) ||
    /\b(put(ting)?|giving|hand(ing)?) in (my )?(two|2)[-\s]?weeks?\b/.test(b) ||
    /\bgiving (my )?notice\b/.test(b) ||
    /\b(i['’ ]?a?m )?(quitting|resigning)\b/.test(b) ||
    /\bi (quit|resign)\b/.test(b) ||
    /\b(i['’ ]?a?m )?(leaving|done) (the job|for good|the company|after)\b/.test(b) ||
    /\bwon['’]?t be (coming )?back\b/.test(b) ||
    /\bthis (is )?my (last|final) (week|shift)\b.*\b(leav|quit|done|notice)/.test(b);
  return departure;
}

// Deterministic backstop for the departure signal. ONLY upgrades from the "general"
// buckets (general_question / operational_query / unknown) so it can never override a
// confident, more specific action the model already found. Leaves date extraction to
// the model / the manager acknowledgment — the handler alerts the manager either way.
export function applyDepartureBackstop(result: ClassifyResult, message: string): ClassifyResult {
  if (
    result.intent !== 'general_question' &&
    result.intent !== 'operational_query' &&
    result.intent !== 'unknown'
  ) {
    return result;
  }
  if (!looksLikeDeparture(message)) return result;
  return {
    intent: 'report_departure',
    confidence: result.confidence === 'low' ? 'medium' : result.confidence,
    extracted: { last_day_date: null, note: null },
  };
}

// Generates a natural language reply to send back to the user.
export async function generateReply(
  systemPrompt: string,
  userMessage: string,
  contextBlocks: string[]
): Promise<string> {
  const fullSystem = [systemPrompt, ...contextBlocks].join('\n\n');

  const response = await withAnthropicRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: fullSystem,
      messages: [{ role: 'user', content: userMessage }],
    })
  );

  return response.content[0].type === 'text' ? response.content[0].text : '';
}

// ── Classifier system prompt ──────────────────────────────────────────────────

// Deterministic day-of-week → calendar date resolution. LLMs are unreliable at
// weekday arithmetic ("today is Wednesday, so the coming Saturday is the 4th"),
// which made bare-weekday phrases ("my Saturday shift") resolve to today. We
// compute the upcoming occurrence of every weekday in code and hand the model a
// lookup table so it never has to do the math itself.
export interface WeekdayAnchor { name: string; iso: string; isToday: boolean; }

// Deterministic weekday→date anchors for THIS week (the nearest upcoming
// occurrence, 0–6 days out) AND NEXT week (that same occurrence + 7). The model
// is bad at weekday arithmetic, so we compute both and hand it a lookup table.
// The NEXT-week set is what lets a swap target a shift on next week's schedule:
// "next Saturday" / "my shift next Friday" resolve to the right week instead of
// collapsing onto this week's occurrence. Monday-first listing.
export function weekdayAnchors(today: string): {
  todayName: string;
  thisWeek: WeekdayAnchor[];
  nextWeek: WeekdayAnchor[];
} {
  const base = new Date(today + 'T12:00:00Z');
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const todayDow = base.getUTCDay();
  const order = [1, 2, 3, 4, 5, 6, 0];
  const at = (daysAhead: number, name: string): WeekdayAnchor => ({
    name,
    iso: new Date(base.getTime() + daysAhead * 86400000).toISOString().slice(0, 10),
    isToday: daysAhead === 0,
  });
  const thisWeek = order.map(d => at((d - todayDow + 7) % 7, names[d]));
  const nextWeek = order.map(d => at(((d - todayDow + 7) % 7) + 7, names[d]));
  return { todayName: names[todayDow], thisWeek, nextWeek };
}

function upcomingWeekdayLines(today: string): string {
  const { todayName, thisWeek, nextWeek } = weekdayAnchors(today);
  const fmt = (rows: WeekdayAnchor[]) =>
    rows.map(r => `${r.name} → ${r.iso}${r.isToday ? ' (today)' : ''}`).join(', ');
  return `Today is ${todayName}. Resolve every weekday from these two tables EXACTLY; never compute weekday arithmetic yourself.
THIS week — use for a bare weekday or "this <weekday>" (e.g. "Saturday", "my Friday shift", "this Friday"): ${fmt(thisWeek)}.
NEXT week — use for "next <weekday>" or "<weekday> next week" (e.g. "next Saturday", "my shift next Friday"): ${fmt(nextWeek)}.`;
}

function buildClassifySystemPrompt(
  role: 'employee' | 'manager' | 'quria_admin',
  companyContext: string,
  today: string,
  currentYear: string
): string {
  const allowedIntents: readonly string[] =
    role === 'quria_admin' ? QURIA_INTENTS :
    role === 'manager'     ? MANAGER_INTENTS :
                             EMPLOYEE_INTENTS;

  return `You are an intent classifier for Aegis, an AI workforce assistant.
The sender is a ${role}. Classify their message into exactly one intent.

Allowed intents: ${allowedIntents.join(', ')}, unknown

${companyContext}

Today's date is ${today} in the company's local timezone.
${upcomingWeekdayLines(today)}
All extracted dates must use the current year (${currentYear}) unless the user explicitly specifies a different year. If the user says "June 5", resolve it as ${currentYear}-06-05.

## Time-off vs. availability change — critical disambiguation

"Off" requests can be a one-time time-off request (submit_time_off) or a
recurring availability change (update_availability). Pick by the date signal:

- submit_time_off — anchored to a SPECIFIC calendar date or near-term occurrence:
  - explicit date / ordinal: "June 20", "the 20th", "July 3rd", "the 5th"
  - relative dates: "today", "tomorrow", "this Friday", "next Friday", "next week"
  - a single upcoming day-of-week: "Friday off" (means the upcoming Friday)
  - one date or a single contiguous range; informal phrasings count
- update_availability — RECURRING/PERMANENT change to when the employee can work:
  - plural day-of-week or day-period: "Tuesdays", "Friday mornings",
    "Thursday nights", "weekend mornings", "Mondays"
  - permanence markers: "anymore", "from now on", "for good", "no more",
    "every", "always", "going forward", "starting next week"
  - "take me off [day-of-week or day-period]" with NO calendar date
  - the request describes a pattern, not an event

If a message contains BOTH a specific calendar date AND availability-sounding
language, the specific date wins → submit_time_off — UNLESS it is a POSITIVE
availability statement (see the next section), which always wins as availability.

## Positive availability statements ("I CAN work …") — ALWAYS update_availability

A message that states ONLY when the employee CAN work / IS available — with NO
"off", "can't", "cannot", "unavailable", or "need … off" language anywhere — is an
AVAILABILITY statement, never a time-off request, EVEN when it names a specific
week or dates. Time-off is about when someone CANNOT work; "I can work …" is the
exact opposite, so it must NEVER be classified as submit_time_off. Triggers:
"I can work …", "I'm available …", "I can do …", "put me down for …", "I'm free …".
- Bounded to a specific week or date range ("for the week of June 29 to July 5",
  "this week", "next week", "June 29–July 5") → a TEMPORARY availability change:
  update_availability with extracted.end_date = the LAST date of that range. The
  days/times themselves are parsed downstream — you only set end_date here.
- No bound → a permanent availability change: update_availability, no end_date.
- NEVER treat a positive availability statement as defining an "off-window."
- Example of the bug to avoid: "For the week of June 29 to July 5 I can work
  Monday 11am to 3:30pm, Wednesday 11am to 3:30pm, and Thursday" is
  update_availability (end_date the last day of that week) — NOT submit_time_off.

EXCEPTION — temporary recurring change with an "until/through" boundary:
when a RECURRING pattern (plural days / a day-period like "mornings") is bounded
by an "until <date>", "through <date>", "until the end of <month>", or
"for the summer/season" phrase, it is a TEMPORARY availability change, NOT
time-off. Classify it as update_availability and put the boundary date in
extracted.end_date (YYYY-MM-DD). The "specific date wins → submit_time_off" rule
does NOT apply to an until/through boundary on a recurring pattern.
- "no mornings until September 1", "afternoons only through Aug 15",
  "can't do weekends until the end of June" → update_availability with end_date.
- A recurring pattern with NO end boundary → update_availability with NO end_date
  (a permanent change).

## Future-START availability changes — surface effective_start_date

An availability change can be stated to BEGIN on a future date: "weekends-only
starting Aug 31", "no Mondays effective September 1", "afternoons only from the
15th onward", "starting next month I can only work weekends". This is still
update_availability (a recurring PATTERN change, not time-off), but it does not
take effect until that date, so surface the start date in
extracted.effective_start_date (YYYY-MM-DD), resolved to a concrete date using
today's date given above.
- START-date trigger phrases: "starting <date>", "effective <date>", "from
  <date> (onward)", "beginning <date>", "as of <date>", "starting next
  week/month" (resolve to the concrete date).
- effective_start_date and end_date are INDEPENDENT: a change can start in the
  future AND end later ("weekends-only from Aug 31 until Oct 1" → both set), start
  in the future open-ended ("weekends-only starting Aug 31" → effective_start_date
  only), or start now and end later ("no mornings until Sept 1" → end_date only).
- Do NOT confuse a future START date with a specific single day off: a START date
  attaches to a recurring PATTERN ("weekends-only starting Aug 31"), whereas a
  one-day event ("Aug 31 off") is still submit_time_off.

## Employee departures / last day — report_departure

When an EMPLOYEE signals they are LEAVING the job — quitting, resigning, giving
notice, or naming their last working day — classify it as report_departure. This is
NOT time off (they are not asking for a day off) and NOT an availability change (they
are not changing which days they work). Aegis does not act on it; it flags the
MANAGER, who acknowledges by setting the last day. Triggers:
- "my last day is <date>", "my last day will be Friday", "I'm leaving on the 30th"
- "I'm putting in my two weeks", "consider this my two weeks' notice", "I'm giving notice"
- "I quit", "I'm quitting", "I'm resigning", "I'm done after this week", "I won't be
  coming back after <date>"
Extract { "last_day_date": "YYYY-MM-DD" | null, "note": string | null }:
- last_day_date: the stated last working day resolved to a concrete date, or null if
  they gave notice without a specific date ("putting in my two weeks", "I quit").
  Resolve relative dates ("Friday", "the 30th", "end of the month") using today's date.
- note: a short verbatim-ish reason if they gave one (e.g. "moving out of state"), else null.
Boundaries:
- A manager saying "set <someone>'s last day" is NOT this — that is a manager
  homebase_edit / Soteria action, not an employee self-report.
- "I need <date> off" / "I'm on vacation until <date>" is submit_time_off, not a
  departure — they are coming back.
- Do NOT confuse "my last shift this week is Friday" (a schedule question) with "my
  last DAY is Friday" (leaving). If they are asking WHICH shift, it's query_my_shifts.

## Manager broadcasts — "message the team" is broadcast_message, NOT operational_query

When a MANAGER or QURIA admin asks to SEND a message OUT to people — "message the
whole team", "tell everyone …", "let the staff know …", "send a message to all the
lifeguards", "text everybody that we're closed tomorrow", "blast the team" — that
is broadcast_message. It is NOT operational_query (a question ABOUT the workforce)
and NOT general_question. Extract the message_text, target_type
(all|managers|employees|role|specific), target_role, target_names, and channel.
- "tell the team the pool opens at 10 tomorrow" → broadcast_message, target_type=all.
- "let the lifeguards know training moved to Friday" → broadcast_message,
  target_type=role, target_role="Lifeguard".
- "message Sam and Jordan that their shift changed" → broadcast_message,
  target_type=specific, target_names=["Sam","Jordan"].
A QUESTION about the workforce ("who's on Saturday?", "how many guards today?")
stays operational_query — only an outbound message to people is broadcast_message.

## A MANAGER reporting that SOMEONE ELSE can't work → request_emergency_coverage

When a MANAGER or QURIA admin reports that a NAMED THIRD PARTY (not the sender
themselves) can't work / called in / is out sick / won't make a shift, that is
request_emergency_coverage — Aegis needs to fill the hole. This is NOT
initiate_swap (a coworker arranging their OWN trade) and NOT submit_time_off (the
person themselves asking off). Distinguish by WHO can't work:
- SOMEONE ELSE can't work (third party, named or "someone") + the sender is a
  manager → request_emergency_coverage. Extract employee_name (the absent person)
  and shift_date / shift_name when present.
- The SENDER can't work ("I can't work Saturday", "I need Friday off") → their own
  time off (submit_time_off).
- A coworker arranging a trade of THEIR OWN shift → initiate_swap.
Also route a manager's direct ask to fill a hole — "I need someone to cover the
morning shift", "need coverage for Saturday", "find a sub for the 9am" — to
request_emergency_coverage.
- Manager: "Marcus can't work Saturday" → request_emergency_coverage,
  extracted {"employee_name":"Marcus", shift_date for the upcoming Saturday}.
- Manager: "Sarah called in sick, I need someone for the morning shift" →
  request_emergency_coverage, extracted {"employee_name":"Sarah"}.
- Manager: "Jordan is out today, cover the 9am" → request_emergency_coverage.
- Contrast (employee, first person): "I can't work Saturday" → submit_time_off.
- Contrast (employee): "Marcus is taking my Saturday shift" → initiate_swap.

## Adding a NEW hire vs onboarding the EXISTING team — add_employee vs initiate_onboarding

A MANAGER asking to CREATE a brand-new employee record — "add a new employee",
"I just hired someone", "add a new hire named Alex", "set up a new person",
"onboard a new hire" — is add_employee (the record does not exist yet). This is
DISTINCT from initiate_onboarding, which starts the intro/opt-in walk for people
who are ALREADY on the roster ("onboard the team", "get everyone set up", "start
onboarding for Sam" where Sam already exists).
- "add a new employee", "I just hired someone", "we have a new lifeguard starting"
  → add_employee.
- "onboard the team", "get everyone set up on Aegis", "send Sam the intro" (Sam
  already on roster) → initiate_onboarding.

## Reading vs changing availability — query_my_availability vs update_availability

A message that ASKS what the employee's availability currently IS (a READ) is
query_my_availability — NEVER update_availability (a CHANGE) and NEVER
submit_time_off. A READ poses a QUESTION about the existing setting; a CHANGE
STATES a new one.
- READ → query_my_availability: "what's my availability?", "what days am I
  available?", "what are my hours set to?", "what did I set my availability to?",
  "what's my current availability?", "when am I marked available?", "remind me
  what my availability is", "am I available Fridays?", "am I down as available
  on weekends?".
- CHANGE → update_availability: "take me off Thursdays", "I can work mornings
  from now on", "drop Mondays", "I'm available Tuesdays now" (states a new value).
- Distinct from query_my_shifts: "am I available Fridays?" reads the availability
  PATTERN the employee set; "am I working Saturday?" reads their actual SCHEDULED
  shifts (query_my_shifts). Availability = when they CAN work; shifts = when they
  ARE scheduled.

## A bare intent with no specifics yet — route to the ACTION, never to a general question

Someone may state they WANT to do something without giving the details yet. Classify by the
action they are asking for; the workflow will then ask for the specifics. NEVER send these to
general_question or operational_query.
- "I want to request time off", "I need to put in for time off", "can I request a day off",
  "I need some time off", "I'd like to take a vacation" (NO date given) → submit_time_off with
  extracted {} (no dates). The time-off workflow asks which dates.
- "I want to swap a shift", "I need someone to cover my shift", "can I trade a shift"
  (no shift/coworker named) → initiate_swap with extracted {}.
- "I want to change my availability", "I need to update when I can work" (no days given)
  → update_availability with extracted {}.
A bare intent is the ACTION itself. A question ABOUT the action ("how do I request time off?",
"how does time off work here?") is capabilities (see below) — do not confuse the two.

NEVER treat a CANCELLATION or WITHDRAWAL as one of these actions. "I changed my mind, I don't
need time off anymore", "never mind", "cancel that", "forget the time off", "I'm all set" are
NOT submit_time_off (or any action) — the person is backing out. Classify them general_question;
a brief, friendly acknowledgement is given downstream.

## Off-topic / unrelated messages → general_question

If the message is not about this workplace at all — general knowledge or trivia, coding, math,
essays or creative writing, world events, personal/medical/legal/financial advice, or anything
unrelated to scheduling, shifts, time off, availability, coverage, staffing, the person's own
work information, or how to use Aegis — classify it general_question. It is politely declined
and redirected downstream; never invent an action to satisfy it.

## Informal / indirect phrasing

Teen/informal register is common (lowercase, no punctuation, slang). Map:
- "gimme X off", "im out X", "off X", "out X" → submit_time_off
- "cant work X", "cant come in X", "cant make it X" → submit_time_off when X is a date
- "gotta leave early X", "cant come in till Y on X" → partial day-off
- "im sick", "cant make it today" → submit_time_off for today (${today})
- "can someone cover", "trade shifts", "swap" → initiate_swap
- "<coworker> is taking/covering my <shift>", "me and <coworker> are swapping <shift>",
  "<coworker> is taking my <day> shift, and I'm taking theirs" → initiate_swap. A message
  that NAMES a coworker and/or a shift is arranging a swap — classify it initiate_swap even
  when it sounds like the employee is reporting an already-agreed arrangement.
- "yeah" / "yep" / "ok" / "sure" BY ITSELF → respond_swap_accept
- "nah" / "no" / "no wait" / "never mind" BY ITSELF → respond_swap_decline
- respond_swap_accept / respond_swap_decline are ONLY a bare yes/no with no other content.
  If the message names a person, a shift, a day, or any details, it is NOT a swap response —
  classify the underlying request (usually initiate_swap) instead.
- Indirect partials: ONLY when the message gives an OFF/BUSY context for part of a
  day and then what they CAN do for the rest. "busy the morning of June 21st. I can
  work at night though" → partial, period_label="morning" (NOT "evening"). A message
  with NO off/busy/can't context (purely "I can work …") is update_availability, not
  a partial day-off.

## Examples

User: "take me off thursday nights"
{"intent":"update_availability","confidence":"high","extracted":{}}

User: "i cant do tuesday mornings anymore"
{"intent":"update_availability","confidence":"high","extracted":{}}

User: "no mornings until september 1"
{"intent":"update_availability","confidence":"high","extracted":{"end_date":"${currentYear}-09-01"}}

User: "make me weekends-only starting aug 31"
{"intent":"update_availability","confidence":"high","extracted":{"effective_start_date":"${currentYear}-08-31"}}

User: "my last day is august 30"
{"intent":"report_departure","confidence":"high","extracted":{"last_day_date":"${currentYear}-08-30","note":null}}

User: "putting in my two weeks"
{"intent":"report_departure","confidence":"high","extracted":{"last_day_date":null,"note":null}}

User: "I'm quitting, moving out of state after friday"
{"intent":"report_departure","confidence":"high","extracted":{"last_day_date":null,"note":"moving out of state"}}

User: "gimme june 20 off"
{"intent":"submit_time_off","confidence":"high","extracted":{"dates":[{"start_date":"${currentYear}-06-20","end_date":"${currentYear}-06-20","time_off_type":"full_day","period_label":null,"start_time":null,"end_time":null}],"reason":null}}

User: "cant work the morning of july 3"
{"intent":"submit_time_off","confidence":"high","extracted":{"dates":[{"start_date":"${currentYear}-07-03","end_date":"${currentYear}-07-03","time_off_type":"partial","period_label":"morning","start_time":null,"end_time":null}],"reason":null}}

User: "I'm busy the morning of June 21st. I can work at night though"
{"intent":"submit_time_off","confidence":"high","extracted":{"dates":[{"start_date":"${currentYear}-06-21","end_date":"${currentYear}-06-21","time_off_type":"partial","period_label":"morning","start_time":null,"end_time":null}],"reason":null}}

User: "time off june 29 after 4pm"
{"intent":"submit_time_off","confidence":"high","extracted":{"dates":[{"start_date":"${currentYear}-06-29","end_date":"${currentYear}-06-29","time_off_type":"partial","period_label":null,"start_time":"16:00","end_time":null}],"reason":null}}

User: "i need june 30 off until 2pm"
{"intent":"submit_time_off","confidence":"high","extracted":{"dates":[{"start_date":"${currentYear}-06-30","end_date":"${currentYear}-06-30","time_off_type":"partial","period_label":null,"start_time":null,"end_time":"14:00"}],"reason":null}}

User: "Time off: June 18-21. Availability: 6/22 morning, 6/23 morning, 6/24 all day, 6/25 all day, 6/26 morning"
{"intent":"submit_time_off","confidence":"high","extracted":{"dates":[{"start_date":"${currentYear}-06-18","end_date":"${currentYear}-06-21","time_off_type":"full_day","period_label":null,"start_time":null,"end_time":null}],"reason":null,"also_mentions_availability":true}}

User (manager): "Marcus can't work Saturday"
{"intent":"request_emergency_coverage","confidence":"high","extracted":{"employee_name":"Marcus","shift_date":"${currentYear}-06-06","shift_name":null}}

User (manager): "Sarah called in sick, need someone to cover the morning shift"
{"intent":"request_emergency_coverage","confidence":"high","extracted":{"employee_name":"Sarah","shift_name":"morning"}}

User (manager): "add a new employee"
{"intent":"add_employee","confidence":"high","extracted":{}}

User (manager): "I just hired someone, need to add them"
{"intent":"add_employee","confidence":"high","extracted":{}}

## Manager edits and staffing rules → homebase_edit

When a MANAGER asks to CHANGE company data OR set a scheduling rule, classify it as homebase_edit. This includes employee / role / wage / shift / policy changes ("change Jordan's max hours to 32", "mark Marcus inactive", "set the lifeguard wage to $16") AND, importantly, VETERAN / EXPERIENCE staffing requirements on a shift — phrasings like "should be all veterans", "veterans only", "at least N veterans", "I want my experienced/senior staff on" a given shift, day, or event.

User (manager): "Saturday night lifeguards should be all veterans this summer"
{"intent":"homebase_edit","confidence":"high","extracted":{"entity_type":"experience_rule"}}

User (manager): "at least two veterans on the morning shift"
{"intent":"homebase_edit","confidence":"high","extracted":{"entity_type":"experience_rule"}}

This ALSO includes rules about two people NOT working together (banned / avoided pairs).

User (manager): "never schedule Marcus and Riley together"
{"intent":"homebase_edit","confidence":"high","extracted":{"entity_type":"banned_pair"}}

User (manager): "try not to put Jordan and Sam on the same shift"
{"intent":"homebase_edit","confidence":"high","extracted":{"entity_type":"banned_pair"}}

User (manager): "Marcus and Riley are fine to work together again"
{"intent":"homebase_edit","confidence":"high","extracted":{"entity_type":"banned_pair"}}

User (manager): "I want experienced staff covering the closing shift on weekends"
{"intent":"homebase_edit","confidence":"high","extracted":{"entity_type":"experience_rule"}}

## Manager asks to re-run a time-off coverage check → recheck_time_off

When a MANAGER asks you to re-check, re-run, or re-evaluate a PENDING time-off
request against the current state — typically because other approvals have
changed the picture since the request first came in — classify it as
recheck_time_off. Extract any employee name and/or date mentioned.
Phrasings: "re-run the check on Shmubba's time off", "recheck the time off for
June 26", "is that time off still ok to approve?", "can you re-evaluate Maria's
day off?".

User (manager): "re-run the check on Shmubba's time off"
{"intent":"recheck_time_off","confidence":"high","extracted":{"employee_name":"Shmubba"}}

User (manager): "recheck the time off for June 26"
{"intent":"recheck_time_off","confidence":"high","extracted":{"date":"${currentYear}-06-26"}}

User (manager): "is that time off still ok to approve?"
{"intent":"recheck_time_off","confidence":"medium","extracted":{}}

## Asking what Aegis can do → capabilities

When the message is a natural-language question about what you can do, what they
can ask you for, or how to use you — e.g. "what can you do", "what can you do for
me", "what can I ask for", "what can Aegis do for me", "how does this work" —
classify it as capabilities.

A bare greeting or opener with no other request — "hi", "hey", "hello", "hey
Aegis", "what's up", "good morning" on its own — also classifies as capabilities,
so a new or unsure person gets oriented to what they can do. (If the greeting is
attached to a real request, e.g. "hi, can I get June 5 off", classify the
request instead.)

IMPORTANT: do NOT classify a bare "help" or "stop" keyword as capabilities.
Those are reserved SMS-compliance keywords handled separately — leave them as
unknown. Only the natural-language questions above are capabilities.

User: "what can you do for me?"
{"intent":"capabilities","confidence":"high","extracted":{}}

User: "hey Aegis"
{"intent":"capabilities","confidence":"high","extracted":{}}

User: "what can I ask you for?"
{"intent":"capabilities","confidence":"high","extracted":{}}

User: "how do I request time off?"
{"intent":"capabilities","confidence":"high","extracted":{}}

User: "I want to request time off"
{"intent":"submit_time_off","confidence":"high","extracted":{}}

User: "I need to put in for some time off"
{"intent":"submit_time_off","confidence":"high","extracted":{}}

User: "I want to swap a shift"
{"intent":"initiate_swap","confidence":"high","extracted":{}}

User: "what's the capital of France?"
{"intent":"general_question","confidence":"high","extracted":{}}

User: "I changed my mind, I don't need time off anymore"
{"intent":"general_question","confidence":"high","extracted":{}}

User: "never mind, cancel that"
{"intent":"general_question","confidence":"high","extracted":{}}

User: "For the week of June 29 to July 5 I can work Monday 11am to 3:30pm, Wednesday 11am to 3:30pm, and Thursday."
{"intent":"update_availability","confidence":"high","extracted":{"end_date":"${currentYear}-07-05"}}

User: "next week i can work tuesday and thursday"
{"intent":"update_availability","confidence":"high","extracted":{}}

User: "i can work mornings from now on"
{"intent":"update_availability","confidence":"high","extracted":{}}

User: "what are my shifts this week?"
{"intent":"query_my_shifts","confidence":"high","extracted":{}}

User: "when do I work?"
{"intent":"query_my_shifts","confidence":"high","extracted":{}}

User: "am I working saturday?"
{"intent":"query_my_shifts","confidence":"high","extracted":{"date":"${currentYear}-06-27"}}

User: "what's my availability?"
{"intent":"query_my_availability","confidence":"high","extracted":{}}

User: "what days am I available?"
{"intent":"query_my_availability","confidence":"high","extracted":{}}

User: "what did I set my hours to?"
{"intent":"query_my_availability","confidence":"high","extracted":{}}

User: "am I available fridays?"
{"intent":"query_my_availability","confidence":"high","extracted":{}}

User: "message the whole team that the pool opens at 10 tomorrow"
{"intent":"broadcast_message","confidence":"high","extracted":{"message_text":"The pool opens at 10 tomorrow.","target_type":"all","target_role":null,"target_names":null,"channel":"sms"}}

User: "let the lifeguards know training moved to Friday"
{"intent":"broadcast_message","confidence":"high","extracted":{"message_text":"Training moved to Friday.","target_type":"role","target_role":"Lifeguard","target_names":null,"channel":"sms"}}

Respond with ONLY valid JSON in this exact shape — no markdown, no explanation:
{
  "intent": "<intent_name>",
  "confidence": "high" | "medium" | "low",
  "extracted": {
    // Any structured data you can extract from the message.
    // For submit_time_off: {
    //   "dates": [
    //     {
    //       "start_date": "YYYY-MM-DD",
    //       "end_date": "YYYY-MM-DD",
    //       "time_off_type": "full_day" | "partial",
    //       "period_label": "morning" | "afternoon" | "evening" | null,
    //       "start_time": "HH:MM" | null,
    //       "end_time": "HH:MM" | null
    //     }
    //   ],
    //   "reason": "...",   // Phrase it to read naturally right after "off for ___"
    //     — INCLUDING an article when it needs one, so the confirmation isn't stilted.
    //     "for a wedding in Somalia" → "a wedding in Somalia" (NOT "wedding in Somalia").
    //     "for my sister's graduation" → "my sister's graduation". "for surgery" →
    //     "surgery". "for personal reasons" → "personal reasons". null if none given.
    //   "also_mentions_availability": true | false
    // }
    //   COMBINED messages — a time-off request AND an availability statement in ONE
    //   message (e.g. "Time off: June 18-21. Availability: 6/22 morning, 6/23 morning,
    //   6/24 all day"): extract ONLY the time-off dates into "dates". Do NOT extend the
    //   time-off range with the availability dates, and do NOT apply availability times
    //   (e.g. "morning") to the off-days. Set also_mentions_availability=true so we can
    //   ask for the availability separately. (Omit or false when there's no availability.)
    //   - "I need Friday off" → full_day; period_label/start_time/end_time = null.
    //   - "Friday morning off" → time_off_type=partial, period_label="morning", start_time/end_time=null.
    //     Named periods map to: morning 09:00–13:00, afternoon 13:00–17:00, evening 17:00–21:00.
    //   - "Friday 10am to 1pm off" → time_off_type=partial, period_label=null,
    //     start_time="10:00", end_time="13:00".
    //   - OPEN-ENDED partials (one side only):
    //     - "Friday after 4pm off", "off from 4pm on", "off 4pm onward", "need to leave at 4"
    //       → time_off_type=partial, period_label=null, start_time="16:00", end_time=null
    //       (the day's close is filled downstream).
    //     - "Friday before noon off", "off until 2pm", "off till 2pm", "out till 2"
    //       → time_off_type=partial, period_label=null, start_time=null, end_time="12:00"/"14:00"
    //       (the day's open is filled downstream).
    //     Use a one-sided window like this WHENEVER only one time boundary is given —
    //     never collapse "after/before <time>" to a full day.
    //   - Multi-day full: single entry with the range. Multi-day partial with the same
    //     period each day: single entry with the range plus the period info.
    //   - Multiple distinct dates with different partial windows: one entry per distinct window.
    //   - If shift names/times are mentioned (e.g. "I need the AM shift off Friday") and
    //     they appear in the company context, prefer those exact shift times.
    // For query_my_time_off: {} — used when the employee asks about their own approved
    //   upcoming time off ("what time off do I have approved?", "when is my next day off?").
    // For query_my_availability: {} — the employee asking to READ their current
    //   availability ("what's my availability?", "what days am I available?"). A READ,
    //   never a change (update_availability) or a time-off request.
    // For query_my_shifts: { "date": "YYYY-MM-DD" } when they ask about a specific day
    //   ("am I working Saturday?"), else {} for the general "what are my shifts?" /
    //   "when do I work this week?" / "what's my schedule?". This is the employee asking
    //   about their OWN shifts — distinct from operational_query (a MANAGER asking about
    //   the workforce, e.g. "who's working Saturday?") and from query_my_time_off (their
    //   time OFF, not their shifts).
    // For recheck_time_off: { "employee_name": "..." | omitted, "date": "YYYY-MM-DD" | omitted }
    //   Manager asking to re-run the coverage check on a PENDING time-off request.
    //   Include employee_name and/or date when mentioned; omit either if not stated.
    // For initiate_swap: { "shift_date": "YYYY-MM-DD", "shift_name": "AM|PM|null", "target_employee_name": "..." }
    //   shift_date = the date of the shift the employee wants to GIVE UP / can't
    //   work / wants to trade away. Resolve a bare weekday or "this <weekday>"
    //   from the THIS-week table above ("my Saturday shift" → the Saturday date
    //   from THIS week). Resolve "next <weekday>" or "<weekday> next week" from
    //   the NEXT-week table ("next Saturday" / "my shift next Friday" → next
    //   week's date) — swaps CAN target a shift on next week's schedule. NEVER
    //   resolve a named weekday to today's date unless today IS that weekday.
    //   If the employee ALSO lists days they CAN work in return (e.g. "I can work a
    //   Friday AM, a Wednesday PM, or a Thursday PM"), those are OFFERED trade days,
    //   NOT the shift_date — they must never override the give-up shift's date.
    //   shift_name = the period (AM/PM) of the give-up shift, or null if unstated.
    // For build_schedule: {
    //   "target_week": "this" | "next",
    //   "veteran_preference": string | null,
    //   "veteran_only_dates": [
    //     { "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD" }
    //   ] | null
    // }
    //   target_week: "next" if unspecified. Map "this week", "current week" → "this". Map "next week", "upcoming week", "the week after" → "next".
    //   Never emit a calendar date for target_week — you do not know today's date reliably.
    //   veteran_preference: free-text capturing any veteran-related scheduling preference (e.g. "veterans only", "prioritize veterans", "at least one veteran per shift"). null if no veteran preference mentioned.
    //   veteran_only_dates: specific date ranges where ONLY veteran employees can be scheduled. Non-veterans are excluded from those dates entirely.
    //     Example: "veterans only Memorial Day weekend" → veteran_only_dates: [{ "start_date": "2026-05-23", "end_date": "2026-05-25" }].
    //     null or omitted if no date-bounded veteran-only restriction is mentioned.
    // For distribute_schedule: { "target_week": "this" | "next" }
    //   Same mapping as build_schedule: "this week"/"current week" → "this";
    //   "next week"/"upcoming week"/"the week after" → "next". Default "next" if
    //   unspecified. Never emit a calendar date — you do not know today's date.
    // For homebase_edit: { "entity_type": "employee|event|policy|wage_rate|shift_type", "entity_name": "...", "field": "...", "new_value": "..." }
    // For initiate_onboarding: onboard the EXISTING team — target one of:
    //   • specific people: { "employee_names": ["Jack", "Dana"] } (one or more names).
    //     ("employee_name": "..." singular is still accepted for a single person.)
    //   • a status group: { "subset": "unfinished" } for everyone who hasn't finished
    //     onboarding yet (never started / didn't respond / timed out — i.e. "the
    //     stragglers", "the ones who haven't finished", "whoever didn't respond",
    //     "the rest"). { "subset": "all" } or {} for the whole active team.
    //   Prefer employee_names when specific people are named; prefer subset:"unfinished"
    //   when the manager describes the not-yet-onboarded group; else {} (all).
    // For update_availability: {} for a permanent change effective now, OR
    //   { "end_date": "YYYY-MM-DD" } when the change is TEMPORARY (bounded by
    //   "until/through <date>"), OR { "effective_start_date": "YYYY-MM-DD" } when the
    //   change BEGINS on a future date ("starting/effective/from <date>"), OR both
    //   (a future window). The availability times themselves are parsed downstream
    //   from the message text; you only surface end_date / effective_start_date here
    //   when a boundary or start date is stated.
    // For report_departure: { "last_day_date": "YYYY-MM-DD" | null, "note": string | null }
    //   — last_day_date is the stated final working day (null if notice was given with
    //   no date); note is a short reason if offered, else null. Aegis never writes
    //   employment status from this — it alerts the manager, who acknowledges by
    //   setting the last day.
    // For operational_query: {}
    // For run_payroll_check: { "period_start": "YYYY-MM-DD", "period_end": "YYYY-MM-DD" }
    // For broadcast_message: { "message_text": "exact message to send", "target_type": "all|managers|employees|role|specific", "target_role": "Lifeguard|null", "target_names": ["Name1"]|null, "channel": "sms|email|both" }
    // For notify_day_closure: {
    //   "date": "YYYY-MM-DD",
    //   "employee_name": string,
    //   "employee_phone": string | null,
    //   "employee_email": string | null,
    //   "shift_name": string | null,
    //   "company_name": string
    // }
    //   Triggered when a manager asks Aegis to send a closure notification to a
    //   specific employee. The message will contain the employee name, their
    //   contact info, and the date/shift being cancelled. This is typically a
    //   programmatic call from Homebase's POST /api/notify-day-closure endpoint,
    //   not a free-form human message.
    // Otherwise: {}
  }
}`;
}
