// ── Durable availability-change request ledger ────────────────────────────────
//
// Time Off (time_off_requests) and Swaps (swap_requests) each have a durable table
// the Homebase tab lists + approves from. Availability had none — the pending
// change lived only in aegis_memory. This module owns the availability_change_requests
// ledger so the Homebase "Availability" tab can see + decide changes with full
// who-approved-it attribution, WITHOUT changing how availability is applied
// (apply still runs through applyAvailabilityDecision / applyCustomAvailabilityDecision).
//
// Design note — the row is self-contained. `proposed_change` stores the entire
// apply snapshot (the same shape the manager magic-link token carries), so any
// surface (Homebase tab, reply-YES, email button) can apply the decision from the
// row alone with no dependence on the transient aegis_memory pending.

import { supabase } from '../db/client';
// Type-only import (erased at compile) — avoids a runtime circular import with
// employee-onboarding, which imports the insert helper below.
import type { AvailabilitySlot, RotationSpec } from './employee-onboarding';

export type AvailabilityChangeKind = 'permanent' | 'date_limited' | 'rotating';

// The self-contained apply snapshot persisted in proposed_change. Structurally the
// same as employee-onboarding's PendingManagerAvailApproval (minus expires_at) so
// the object can be passed straight through.
export interface AvailabilityChangeSnapshot {
  employee_id: string;
  employee_name: string;
  company_id: string;
  current_availability: AvailabilitySlot[];
  proposed_availability: AvailabilitySlot[];
  availability_raw: string;
  employee_sender: string;
  employee_recipient: string;
  employee_channel: 'sms' | 'email';
  thread_id?: string | null;
  raw_subject?: string | null;
  custom_end_date?: string | null;
  rotation?: RotationSpec | null;
}

export interface AvailabilityChangeRow {
  id: string;
  company_id: string;
  employee_id: string;
  status: 'pending' | 'approved' | 'denied' | 'withdrawn';
  change_kind: AvailabilityChangeKind;
  proposed_change: AvailabilityChangeSnapshot;
  prior_snapshot: AvailabilitySlot[] | null;
  decided_by: string | null;
  decided_at: string | null;
  requested_at: string;
}

export function resolveChangeKind(
  s: Pick<AvailabilityChangeSnapshot, 'custom_end_date' | 'rotation'>,
): AvailabilityChangeKind {
  if (s.rotation) return 'rotating';
  if (s.custom_end_date) return 'date_limited';
  return 'permanent';
}

function buildSummary(s: AvailabilityChangeSnapshot, kind: AvailabilityChangeKind): string {
  if (kind === 'rotating' && s.rotation) {
    return `${s.employee_name} wants a rotating availability change (${s.rotation.cycle_weeks}-week cycle)`;
  }
  if (kind === 'date_limited' && s.custom_end_date) {
    return `${s.employee_name} wants a temporary availability change through ${s.custom_end_date}`;
  }
  return `${s.employee_name} wants to update their weekly availability`;
}

/**
 * Insert a durable pending row for a confirmed availability change.
 *
 * Newest-wins for PERMANENT (Alexander, 2026-08-04): a permanent change wholesale-
 * replaces the weekly availability, so an older pending permanent request is stale.
 * We withdraw any existing pending permanent row for this employee first (the
 * uq_avail_change_one_pending_permanent partial unique index also enforces this at
 * the DB level, so a missed withdraw would throw instead of silently duplicating).
 * date_limited / rotating overrides are ADDITIVE and may coexist — never withdrawn.
 *
 * Returns the new row id, or null if the insert failed (the caller keeps working —
 * the aegis_memory + email path still function; only the Homebase-tab mirror is lost).
 */
export async function insertPendingAvailabilityChange(params: {
  snapshot: AvailabilityChangeSnapshot;
  sourceChannel: 'sms' | 'email';
}): Promise<string | null> {
  const { snapshot, sourceChannel } = params;
  const kind = resolveChangeKind(snapshot);

  if (kind === 'permanent') {
    const { error: supErr } = await supabase
      .from('availability_change_requests')
      .update({ status: 'withdrawn', decided_at: new Date().toISOString() })
      .eq('employee_id', snapshot.employee_id)
      .eq('change_kind', 'permanent')
      .eq('status', 'pending');
    if (supErr) {
      console.error('[avail-change] supersede (withdraw prior pending permanent) failed:', supErr.message);
      // Fall through — the insert below would still throw on the unique index if a
      // pending permanent truly remains, which is the correct fail-loud behavior.
    }
  }

  const { data, error } = await supabase
    .from('availability_change_requests')
    .insert({
      company_id: snapshot.company_id,
      employee_id: snapshot.employee_id,
      status: 'pending',
      change_kind: kind,
      proposed_change: snapshot,
      prior_snapshot: snapshot.current_availability ?? [],
      aegis_summary: buildSummary(snapshot, kind),
      raw_request: snapshot.availability_raw ?? '',
      source_channel: sourceChannel,
    })
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('[avail-change] insert failed:', error.message);
    return null;
  }
  return (data as { id: string } | null)?.id ?? null;
}

export type AvailabilityApplyOutcome = { status: 'applied' | 'already_decided' };

/**
 * Guarded pending-only flip of the ledger row — the universal idempotency guard.
 *
 * Every decision surface (Homebase tab, reply-YES, email magic-link) routes its
 * decision through applyAvailabilityDecision / applyCustomAvailabilityDecision, and
 * those call this FIRST. Because the flip only succeeds on a still-pending row, two
 * surfaces (a tab click + a stale email button) can never double-apply the same
 * change: the second flip returns false and the apply short-circuits. Returns true
 * when this call is the one that flipped the row.
 */
export async function flipChangeRequestGuarded(
  id: string,
  decision: 'approved' | 'denied',
  decidedByUserId: string | null,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('availability_change_requests')
    .update({ status: decision, decided_at: new Date().toISOString(), decided_by: decidedByUserId ?? null })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) {
    console.error('[avail-change] guarded flip failed:', error.message);
    return false;
  }
  return !!data;
}

export async function loadAvailabilityChangeRow(id: string): Promise<AvailabilityChangeRow | null> {
  const { data, error } = await supabase
    .from('availability_change_requests')
    .select('id, company_id, employee_id, status, change_kind, proposed_change, prior_snapshot, decided_by, decided_at, requested_at')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.error('[avail-change] load failed:', error.message);
    return null;
  }
  return (data as AvailabilityChangeRow | null) ?? null;
}
