import { supabase } from '../db/client';

// ── The SMS consent gate (Rule 0b — one consent check, one function) ──────────
//
// N3 (2026-08-14): outbound SMS was reaching employees who never opted in. The
// opt-in gate lived ONLY inside onboarding (the in-flight session's
// `opt_in_confirmed`); the shared send layer had no recipient identity and no
// durable per-employee consent flag, so every non-onboarding workflow texted a
// phone-holder regardless of consent once EMAIL_ONLY=false.
//
// This module is the ONE place that answers "may we SMS this employee?". Every
// outbound SMS path routes through it (via sendSms's employee_id gate). One
// answer, one function — a caller that reimplements the check is a bug waiting
// to disagree with its siblings.
//
// SOURCE OF RECORD vs. CACHE (Rule 0). The audit trail of consent lives, as it
// always has, in `activity_log` (employee_opt_in_confirmed / _declined /
// employee_opted_out / employee_resubscribed). Those events are the record. The
// `employees.sms_consent_state` column this module reads is a DENORMALIZED CACHE
// of "the latest consent event for this employee", kept in lockstep by
// setEmployeeConsentState at each of the four event sites and seeded from the
// activity_log by the migration backfill. The column exists purely so the send
// chokepoint can answer the question with one indexed read instead of scanning
// the log on every send.
//
// FAIL CLOSED. Unknown / missing / errored state is treated as "not consented"
// — no SMS. Legal fallback to email happens naturally in the notifier paths when
// this returns false.

// Domain of employees.sms_consent_state. NULL is treated as 'none'.
//  - none        : no consent event on record (never invited, or invite unanswered)
//  - confirmed   : replied YES to the onboarding opt-in invitation
//  - declined    : replied NO to the opt-in invitation
//  - opted_out   : texted STOP (carrier-suppressed too; this is the app-visible mirror)
//  - resubscribed: texted START/UNSTOP after an opt-out
export type SmsConsentState =
  | 'none'
  | 'confirmed'
  | 'declined'
  | 'opted_out'
  | 'resubscribed';

// The single predicate: only a confirmed or resubscribed employee may be texted.
// declined and opted_out are hard blocks even when a phone exists.
export function stateAllowsSms(state: string | null | undefined): boolean {
  return state === 'confirmed' || state === 'resubscribed';
}

// May we send an automated SMS to this employee right now? Reads the durable
// consent cache on `employees`. Any DB error → false (fail closed): we never
// send when we cannot prove consent.
export async function canSmsEmployee(company_id: string, employee_id: string): Promise<boolean> {
  if (!employee_id) return false;
  const { data, error } = await supabase
    .from('employees')
    .select('sms_consent_state')
    .eq('company_id', company_id)
    .eq('id', employee_id)
    .maybeSingle();

  if (error) {
    console.error(
      `[consent] consent lookup failed for employee ${employee_id} — blocking SMS (fail closed):`,
      error.message
    );
    return false;
  }
  const state = (data as { sms_consent_state: string | null } | null)?.sms_consent_state ?? null;
  return stateAllowsSms(state);
}

// Keep the denormalized consent cache in lockstep with the activity_log consent
// events. Call this immediately after logging each consent event (onboarding
// YES/NO, STOP, START). Best-effort: a cache-write failure is logged but never
// throws — the activity_log event remains the source of record, and the next
// event (or a re-run of the backfill) heals the cache. Company-scoped so a write
// can never cross tenants.
export async function setEmployeeConsentState(
  company_id: string,
  employee_id: string,
  state: SmsConsentState
): Promise<void> {
  if (!employee_id) return;
  const { error } = await supabase
    .from('employees')
    .update({ sms_consent_state: state, sms_consent_updated_at: new Date().toISOString() })
    .eq('company_id', company_id)
    .eq('id', employee_id);
  if (error) {
    console.error(
      `[consent] failed to persist consent state '${state}' for employee ${employee_id} ` +
        `(activity_log remains the source of record):`,
      error.message
    );
  }
}
