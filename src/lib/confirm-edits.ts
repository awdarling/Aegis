// ── W-2 branch 2 (C-5, J-4): deterministic readings of confirm-gate replies ───
//
// A yes/no confirm gate must treat a non-yes/no reply as an EDIT, not noise
// (Working_Preferences: "applying a partial correction instead of making
// someone start over — that intelligence is the premium worth building").
// These parsers are the DETERMINISTIC pre-pass: the common correction shapes
// the competition transcripts showed, resolved with zero model calls
// (MINIMIZE LLM CALLS). Anything they don't match falls through to each
// gate's EXISTING model call — never a new one.
//
// Rule 0b: one reading per shape, shared by every gate and by the classifier
// backstops. No gate may keep its own copy of these regexes.

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// ── Reason edits ──────────────────────────────────────────────────────────────
//
// Maisey: "make sure to say it's due to the watermark entry"
// Katie:  "I cannot work the morning of August 18th. THIS IS FOR COMPETITION."
// Also:   "it's for the competition", "reason: doctor's appointment",
//         "tell him it's because of my car", "due to a family thing"
//
// Returns the extracted reason text (untrimmed of meaning, trimmed of
// punctuation), or null when the message doesn't read as a reason statement.
export function parseReasonEdit(body: string): string | null {
  const t = body.trim();
  if (!t) return null;

  // Frame 1 — an explicit edit instruction: "make sure to say / say / tell
  // him / add / note / mention (that) it's (for|due to|because of) X".
  const framed = t.match(
    /\b(?:make sure(?: to| you| it)?|please)?\s*(?:say|says|tell (?:him|her|them|my manager|jack|the manager)|add|note|mention|include)\b[^a-z0-9]*(?:that\s+)?(?:it'?s|it is|this is|i'?m out|the reason is)?\s*(?:for|due to|because(?: of)?|:)?\s+(.{2,120})$/i,
  );
  if (framed) return cleanReason(framed[1]);

  // Frame 2 — a bare reason statement: "THIS IS FOR COMPETITION", "it's for
  // the competition", "the reason is my sister's wedding", "due to the
  // watermark entry", "because of a doctor's appointment", "reason: illness".
  const bare = t.match(
    /^(?:it'?s|it is|this is|that'?s|the reason is|reason)\s*(?:for|due to|because(?: of)?|:)?\s+(.{2,120})$/i,
  ) ?? t.match(/^(?:for|due to|because(?: of)?)\s+(.{2,120})$/i);
  if (bare) return cleanReason(bare[1]);

  return null;
}

function cleanReason(raw: string): string | null {
  let r = raw.trim().replace(/[.!?\s]+$/, '');
  // Strip a leading connective the regex let through ("for the competition").
  r = r.replace(/^(?:for|due to|because(?: of)?|that|it'?s|:)\s+/i, '').trim();
  if (!r) return null;
  // A "reason" that is really a date/time correction is not a reason.
  if (/^\d|^(the )?\d{1,2}(st|nd|rd|th)\b/i.test(r)) return null;
  // ALL-CAPS shouting ("THIS IS FOR COMPETITION") stores calmly.
  return /[A-Z]/.test(r) && r === r.toUpperCase() ? r.toLowerCase() : r;
}

// Does this read as a reason edit at all? (The classifier backstop's cheap
// test — the extraction above answers "what is the reason".)
export function looksLikeReasonEdit(body: string): boolean {
  return parseReasonEdit(body) !== null;
}

// ── Named-person directives at the swap gate ──────────────────────────────────
//
// Maisey: "ask mia" → a DIRECTED swap to Mia, never a broadcast.
// Katie:  "Ask Jenna", "Can u send the shift request by Jenna", "send it to Jenna"
export function parseNamedDirective(body: string): string | null {
  const t = body.trim().replace(/[.!?]+$/, '');
  const m = t.match(
    /^(?:can (?:you|u)\s+)?(?:please\s+)?(?:just\s+)?(?:ask|send (?:it|that|the (?:shift )?(?:swap |trade )?request)?\s*(?:by|to)|check with|go with|offer it to|give it to|try)\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+)?)$/i,
  );
  if (!m) return null;
  const name = m[1].trim();
  // Words that end up in the name slot but aren't names.
  if (/^(the team|everyone|anybody|anyone|them|him|her|me|again|around)$/i.test(name)) return null;
  return name;
}

// ── Willing-days replies at the facilitated swap gate (J-4 root-cause kin) ───
//
// The broadcast confirm invites "tell me which days you can work" — and the
// reply ("I can work Mondays and Tuesdays") used to be re-classified as an
// AVAILABILITY CHANGE, clearing the pending swap. A bare can-work-weekdays
// reply with no availability language is the answer to that invitation.
// Returns weekday indices (0=Sun..6=Sat), or null when it doesn't parse — or
// when it smells like a real availability change ("only", "going forward"),
// which must keep flowing to the classifier.
export function parseWillingDaysReply(body: string): number[] | null {
  const t = body.trim().toLowerCase();
  if (!/^(?:i\s+)?(?:can|could)\s+(?:work|do|take)\b/.test(t)) return null;
  if (/\bonly\b|\bgoing forward\b|\bfrom now\b|\banymore\b|\bpermanent|availab|\bevery week\b|\bfor the rest\b/.test(t)) return null;
  const days: number[] = [];
  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (new RegExp(`\\b${WEEKDAYS[i]}s?\\b`).test(t)) days.push(i);
  }
  return days.length > 0 ? days : null;
}

// ── One-word (or few-word) answers to "which shift?" ──────────────────────────
//
// Katie answered "Sunday" and was given a schedule query. The open question's
// state now survives (PendingSwap.awaiting), and this reads the answer:
// a weekday, "today"/"tonight"/"tomorrow", or a short shift descriptor
// ("the flex shift", "the morning one") passed on as a name hint.
export function parseShiftAnswer(
  body: string,
  today: string,
): { shift_date?: string; shift_name_hint?: string } | null {
  const t = body.trim().toLowerCase().replace(/[.!?]+$/, '');
  if (!t) return null;
  // A bare yes/no is not an answer to "which one?".
  if (/^(yes|yeah|yep|yup|ok|okay|sure|no|nope|nah|never ?mind|nvm)$/.test(t)) return null;

  if (/^(today|tonight)$/.test(t)) return { shift_date: today };
  if (/^(tomorrow|tmrw)$/.test(t)) return { shift_date: addDaysLocal(today, 1) };

  // A bare weekday (optionally "the <weekday> one/shift", "on <weekday>",
  // "<weekday> august 23" keeps just the weekday resolution simple): next
  // occurrence of that weekday on or after today.
  const wd = t.match(/^(?:the\s+)?(?:on\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+(?:one|shift))?$/);
  if (wd) {
    const want = WEEKDAYS.indexOf(wd[1]);
    const todayDow = new Date(today + 'T12:00:00Z').getUTCDay();
    const delta = (want - todayDow + 7) % 7; // today counts as this weekday
    return { shift_date: addDaysLocal(today, delta) };
  }

  // A short descriptor: "the flex shift", "flex", "the morning one",
  // "AM Weekday". Anything sentence-length is NOT an answer — let it flow on.
  const words = t.split(/\s+/);
  if (words.length <= 4 && /[a-z]/.test(t)) {
    const hint = t.replace(/^the\s+/, '').replace(/\s+(one|shift)$/, '').trim();
    if (hint) return { shift_name_hint: hint };
  }
  return null;
}

function addDaysLocal(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
