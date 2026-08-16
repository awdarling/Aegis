// L5 — THE single authoritative answer to "is this employee onboarded?"
//
// ── THE BUG THIS EXISTS TO END (live at Watermark, 2026-08-16) ───────────────
//
// Alexander asked Aegis to "onboard everyone who hasn't finished onboarding yet"
// and got back only Ally Becker — despite having been texted, twice, that Bennet
// Nieukoop and Rosa Thornburg hadn't finished, and despite Homebase showing
// those two as BOTH "timed out" AND with a "Completed" date.
//
// Verified read-only against the live DB, both employees identical:
//   • sms_consent_state = 'confirmed' (8/13)
//   • role on file, email on file, 6–7 availability rows on file
//   • latest onboarding event = onboarding_timeout (8/16), step_reached 'time_off'
//   • NO onboarding_complete event, ever
//
// They were FULLY COLLECTED. After consent, Aegis found nothing left to ask,
// texted them "Great, you're confirmed! It looks like you're all set", and then
// parked them on an OPTIONAL courtesy question — "any time off coming up?" —
// which they never answered. Because `onboarding_complete` is only reachable
// through that question, an employee who ignored one optional message could
// never be recorded as finished, and was re-nagged and re-timed-out forever.
//
// ── WHY THREE ANSWERS DISAGREED ──────────────────────────────────────────────
//
// "Onboarded" was decided in three places, and NONE of them was actually asking
// that question:
//
//   A. the aegis_memory session row  — answers "is a walk in flight?"
//        → read by both sweepers and by Homebase's in-progress fallback
//   B. employees.sms_consent_state   — answers "may we text them?"
//        → read by N4's isUnfinishedOnboarding as if it meant "finished"
//   C. activity_log                  — answers "what happened most recently?"
//        → read by the Homebase Onboarding tab
//
// So the sweeper said "hasn't finished" (A), N4 said "finished" (B), and the tab
// said "timed out" next to a Completed date (C) — all about the same person, on
// the same day. They can never be reconciled by patching any one of them.
//
// Note especially that migration 021 was explicit that `sms_consent_state` is a
// CONSENT cache and that activity_log remains the record. N4 repurposed it as a
// completion marker. That repurposing is its own bug.
//
// ── THE DEFINITION ───────────────────────────────────────────────────────────
//
// RULE 0 — one fact, one place. Onboarding is defined by WHAT THE MANAGER NEEDS
// TO BE TRUE, not by whether a conversation reached its last turn:
//
//   An employee is ONBOARDED when Aegis can both reach them and schedule them:
//   a reachable channel they've consented to (or an email-channel hire, who is
//   not under the SMS opt-in regime), plus the data onboarding exists to
//   collect — a role and availability.
//
// Every input already exists in the database. **No migration is required, and
// none should be added**: a stored `onboarding_status` column would become a
// FOURTH source that can drift out of step with the other three, which is
// precisely the failure being fixed here.
//
// RULE 0b — one question, one function. Everything that needs to know whether
// someone is onboarded calls THIS, and nothing re-derives it: N4's
// "unfinished" subset, both scheduler sweepers, and (via the ported copy) the
// Homebase Onboarding tab.

export type OnboardingStatus =
  /** Nothing on record and no walk ever started. */
  | 'not_started'
  /** A walk is live and waiting on the employee's SMS opt-in. */
  | 'awaiting_consent'
  /** Consented (or email-channel), but role/availability are still missing. */
  | 'in_progress'
  /** Reachable + schedulable. Done — regardless of how the conversation ended. */
  | 'onboarded'
  /** Said no to SMS, or opted out later. Terminal: never auto-re-onboard. */
  | 'declined'
  /** No phone and no email — Aegis cannot start at all. Needs manager data entry. */
  | 'unreachable';

export interface OnboardingStatusInput {
  contact_phone?: string | null;
  contact_email?: string | null;
  primary_role?: string | null;
  qualified_roles?: string[] | null;
  sms_consent_state?: string | null;
}

/** True when the employee has a role recorded either way round. */
export function hasRoleOnFile(e: OnboardingStatusInput): boolean {
  return !!e.primary_role || (Array.isArray(e.qualified_roles) && e.qualified_roles.length > 0);
}

/**
 * Derive the ONE onboarding status. Pure — no database, fully unit-testable.
 *
 * @param hasAvailability  does this employee have any `availability` row?
 * @param hasLiveSession   is there a live (unexpired) aegis_memory session row?
 *                         Used ONLY to distinguish 'not_started' from
 *                         'in_progress'; it can never make someone
 *                         un-onboarded, which is the bug being fixed.
 */
export function deriveOnboardingStatus(
  e: OnboardingStatusInput,
  hasAvailability: boolean,
  hasLiveSession: boolean,
): OnboardingStatus {
  const consent = e.sms_consent_state ?? null;

  // DECLINED IS TERMINAL and is checked first. Someone who said no — or who
  // texted STOP — must never be swept back into an automatic re-onboard, no
  // matter how incomplete their record looks. Re-pestering someone who declined
  // is both rude and a consent hazard.
  if (consent === 'declined' || consent === 'opted_out') return 'declined';

  const reachableBySms = !!e.contact_phone;
  const reachableByEmail = !!e.contact_email;
  if (!reachableBySms && !reachableByEmail) return 'unreachable';

  // Consent only gates the SMS channel. An email-channel hire never generates an
  // opt-in event, so requiring one would mark every email-only employee as
  // permanently unfinished — the false positive the old N4 comment apologised
  // for. Email reachability satisfies this leg on its own.
  const consentSatisfied = consent === 'confirmed' || consent === 'resubscribed' || reachableByEmail;
  if (!consentSatisfied) {
    // Phone-only and no positive consent yet: either mid-walk or never asked.
    return hasLiveSession ? 'awaiting_consent' : 'not_started';
  }

  // Reachable and consented. The remaining question is purely "can the scheduler
  // actually use this person?" — role + availability. Email is deliberately NOT
  // required: H5 made it optional for a phone-reachable hire, and the walk
  // accepts SKIP.
  if (hasRoleOnFile(e) && hasAvailability) return 'onboarded';

  return hasLiveSession || reachableBySms || reachableByEmail ? 'in_progress' : 'not_started';
}

/**
 * Statuses that SHOULD be swept up by "onboard everyone who hasn't finished".
 *
 * `declined` is excluded on purpose (never re-pester). `unreachable` is excluded
 * because Aegis has no channel to start on — that needs the manager to add a
 * phone or email first, and quietly failing to contact them would look like the
 * feature is broken.
 */
export function isUnfinishedStatus(status: OnboardingStatus): boolean {
  return status === 'not_started' || status === 'awaiting_consent' || status === 'in_progress';
}

/**
 * Manager-facing label. Kept here so Aegis copy and the Homebase tab can never
 * describe the same state with different words.
 */
export const ONBOARDING_STATUS_LABEL: Record<OnboardingStatus, string> = {
  not_started: 'Not started',
  awaiting_consent: 'Waiting on their opt-in',
  in_progress: 'In progress',
  onboarded: 'Onboarded',
  declined: 'Declined',
  unreachable: 'No phone or email on file',
};
