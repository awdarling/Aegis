// H7 — pending-session interruptibility.
//
// A message that arrives DURING a pending interactive session (an emergency-
// coverage "awaiting names" thread, an unconfirmed shift-swap, etc.) but that
// clearly names a DIFFERENT actionable request must not be swallowed by the
// pending handler. Alexander's go-live principle: while one workflow is in
// progress, other workflows stay fireable. This mirrors the time-off-confirm
// MOVED_ON re-route (see handlePendingTimeOffConfirmation): classify the reply;
// if it's a real other intent, the CALLER clears its own pending state and
// re-routes; only a genuine decline / no-op keeps the pending handler's normal
// behaviour.
//
// Kept in its own tiny module (not intent-router) so the pending handlers can
// import it without dragging in the whole router — avoiding a heavy / circular
// import — and so it is trivially unit-testable.

import { classifyIntent } from '../ai/claude';
import { supabase } from '../db/client';
import type { InboundMessage, VerifiedContact } from '../security/types';

// Manager intents that carry an explicit ACTION verb ("approve …", "build …",
// "distribute …"). Safe to yield to even when the pending handler was about to
// read the reply as a name to contact, because a bare name ("Kori") never
// classifies as one of these. This is what lets "approve Sam's swap" mid-
// coverage interrupt without a plain "Kori" being mistaken for a command.
export const INTERRUPTING_MANAGER_ACTION_INTENTS = new Set<string>([
  'approve_time_off',
  'deny_time_off',
  'recheck_time_off',
  'approve_swap',
  'deny_swap',
  'build_schedule',
  'distribute_schedule',
  'initiate_onboarding',
  'add_employee',
  'request_emergency_coverage',
  'broadcast_message',
  'homebase_edit',
  'notify_day_closure',
]);

// Manager QUERY intents ("who's free Saturday?"). These interrupt too, but ONLY
// on branches where the reply cannot be a name to contact (a "no names /
// declining" branch, or a yes/no batch prompt) — a bare name can occasionally
// look like a query, so we do NOT yield to these while still expecting names.
export const INTERRUPTING_MANAGER_QUERY_INTENTS = new Set<string>([
  'operational_query',
  'query_my_shifts',
  'query_my_time_off',
]);

// Employee intents that clearly change the subject away from a pending (unsent)
// confirmation — e.g. an unconfirmed shift-swap. general_question / operational
// chit-chat are deliberately excluded: a fumbled yes/no often lands there and
// should re-ask, not re-route.
export const INTERRUPTING_EMPLOYEE_INTENTS = new Set<string>([
  'submit_time_off',
  // L3 — a cancel raised mid-confirmation must YIELD rather than be read as
  // "scrap the pending one". The two are different requests and only the word
  // "cancel" is shared.
  'cancel_time_off',
  // W-2 (C-2) — same shape: "cancel the swap" raised mid-confirmation yields
  // to the swap withdraw path.
  'cancel_swap',
  'query_my_shifts',
  'query_my_time_off',
  'update_availability',
  'initiate_swap',
]);

// Classify a mid-session reply, injecting the TENANT's local timezone (hard
// rule — never server UTC), exactly as handlePendingTimeOffConfirmation does.
export async function classifyInterruptIntent(
  message: InboundMessage,
  contact: VerifiedContact
): Promise<string> {
  const { data } = await supabase
    .from('companies')
    .select('timezone')
    .eq('id', contact.company_id)
    .single();
  const timezone =
    (data as { timezone: string | null } | null)?.timezone ?? 'America/New_York';
  const classification = await classifyIntent(message.body, contact.role, '', timezone);
  return classification.intent;
}

// Manager-side: returns the interrupting intent (so the caller can log it) or
// null. `allowQueries` gates the QUERY set — pass false while a reply could
// still be a name to contact (coverage "awaiting names" with names present),
// true on the decline / batch-decision branches.
export async function managerInterruptIntent(
  message: InboundMessage,
  contact: VerifiedContact,
  opts: { allowQueries: boolean }
): Promise<string | null> {
  const intent = await classifyInterruptIntent(message, contact);
  const hit =
    INTERRUPTING_MANAGER_ACTION_INTENTS.has(intent) ||
    (opts.allowQueries && INTERRUPTING_MANAGER_QUERY_INTENTS.has(intent));
  return hit ? intent : null;
}

// Employee-side: returns the interrupting intent or null.
export async function employeeInterruptIntent(
  message: InboundMessage,
  contact: VerifiedContact
): Promise<string | null> {
  const intent = await classifyInterruptIntent(message, contact);
  return INTERRUPTING_EMPLOYEE_INTENTS.has(intent) ? intent : null;
}
