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
  'update_availability',
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
  'request_emergency_coverage',
  'build_schedule',
  'distribute_schedule',
  'run_payroll_check',
  'homebase_edit',
  'notify_day_closure',
  'recheck_time_off',
] as const;

export const QURIA_INTENTS = [
  ...MANAGER_INTENTS,
  'broadcast_message',
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

  return applyAvailabilityBackstop(parsed, message);
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

## Informal / indirect phrasing

Teen/informal register is common (lowercase, no punctuation, slang). Map:
- "gimme X off", "im out X", "off X", "out X" → submit_time_off
- "cant work X", "cant come in X", "cant make it X" → submit_time_off when X is a date
- "gotta leave early X", "cant come in till Y on X" → partial day-off
- "im sick", "cant make it today" → submit_time_off for today (${today})
- "can someone cover", "trade shifts", "swap" → initiate_swap
- "yeah" / "yep" / "ok" / "sure" by itself → respond_swap_accept
- "nah" / "no" / "no wait" / "never mind" by itself → respond_swap_decline
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

## Manager edits and staffing rules → homebase_edit

When a MANAGER asks to CHANGE company data OR set a scheduling rule, classify it as homebase_edit. This includes employee / role / wage / shift / policy changes ("change Jordan's max hours to 32", "mark Marcus inactive", "set the lifeguard wage to $16") AND, importantly, VETERAN / EXPERIENCE staffing requirements on a shift — phrasings like "should be all veterans", "veterans only", "at least N veterans", "I want my experienced/senior staff on" a given shift, day, or event.

User (manager): "Saturday night lifeguards should be all veterans this summer"
{"intent":"homebase_edit","confidence":"high","extracted":{"entity_type":"experience_rule"}}

User (manager): "at least two veterans on the morning shift"
{"intent":"homebase_edit","confidence":"high","extracted":{"entity_type":"experience_rule"}}

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
    //   "reason": "...",
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
    //   work / wants to trade away. Resolve a bare day-of-week to its UPCOMING
    //   occurrence relative to today (${today}): "my Saturday shift" / "trade my
    //   Saturday PM shift" → this coming Saturday's calendar date. NEVER resolve a
    //   named weekday to today's date.
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
    // For initiate_onboarding: { "employee_name": "..." } if targeting one employee, or {} for all
    // For update_availability: {} for a permanent change, OR { "end_date": "YYYY-MM-DD" }
    //   when the change is TEMPORARY (bounded by "until/through <date>"). The
    //   availability times themselves are parsed downstream from the message text;
    //   you only need to surface end_date here when a boundary is stated.
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
