-- 022_time_off_cancelled_status.sql
-- L3 (2026-08-16) — allow an employee-initiated CANCELLATION of an already-
-- approved time-off request to be recorded as a real status.
--
-- WHY: L3 lets an employee cancel approved time off by text. The live CHECK
-- constraint, verified read-only 2026-08-16, is:
--
--     time_off_requests_status_check
--       CHECK (status = ANY (ARRAY['pending','approved','denied']))
--
-- so there is no honest value to write. The three alternatives were considered
-- and rejected:
--
--   • DELETE the row — destroys a record the MANAGER already approved and saw.
--     That is a direct Rule 0 violation ("one fact, one place: what the manager
--     sees is the truth"): the manager's Homebase view would silently lose an
--     approval they granted, with no trace but an activity_log line.
--   • Write 'denied' — semantically false. 'denied' means the manager refused.
--     A manager reviewing history would read the employee's own cancellation as
--     their own rejection.
--   • Leave it 'approved' and track cancellation elsewhere — two facts, two
--     places; every existing `.eq('status','approved')` reader would keep
--     blocking the day the employee just freed.
--
-- 'cancelled' is also the value `swap_requests.status` already uses for the
-- same concept (see src/db/types.ts), so this makes the two tables consistent
-- rather than introducing new vocabulary.
--
-- SAFETY: this only WIDENS the allowed set. No existing row changes, no column
-- is added or dropped, and nothing can fail validation — every current value
-- ('pending' | 'approved' | 'denied') remains legal. It is reversible by
-- re-adding the old constraint, provided no 'cancelled' rows exist yet.
--
-- ORDERING: RUN THIS BEFORE DEPLOYING THE L3 CODE. Without it, the cancel
-- confirmation would fail at the UPDATE with a check-constraint violation
-- (23514) — the employee would be asked "are you sure?", say yes, and get an
-- error. The code fails closed and tells them to contact their manager rather
-- than claiming success, but the feature simply does not work until this runs.
--
-- READERS AUDITED for the new value (all `.eq('status','approved')`, so a
-- cancelled row correctly stops blocking):
--   src/lib/schedule-simulator.ts loadApprovedTimeOff
--   src/workflows/schedule-build.ts (toMap + fairness memory)
--   src/workflows/shift-swap.ts validateSwap + buildSwapCandidates
--   src/workflows/emergency-coverage.ts
--   src/lib/time-off-policies.ts computeTimeOffViolations
-- The two readers that do NOT filter on status are fixed in the L3 code:
--   src/workflows/time-off.ts handleQueryMyTimeOff  (labelled every unknown
--     status "Pending — awaiting your manager"; now labels 'cancelled')
--   src/workflows/operational-query.ts              (table description string)
-- Homebase has its own readers in the other repo — see the L3 delivery doc.
--
-- HUMAN-GATED: Alexander runs this in the Supabase SQL editor. The agent's
-- Supabase MCP is read-only.

-- 1) Widen the domain --------------------------------------------------------
ALTER TABLE time_off_requests
  DROP CONSTRAINT IF EXISTS time_off_requests_status_check;

ALTER TABLE time_off_requests
  ADD CONSTRAINT time_off_requests_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'cancelled'::text]));

COMMENT ON COLUMN time_off_requests.status IS
  'pending | approved | denied | cancelled. ''cancelled'' is set ONLY by the '
  'employee withdrawing their own already-approved request (L3, by SMS, behind '
  'an explicit yes/no confirmation). A manager refusing a request is ''denied''. '
  'Every scheduling reader filters status=''approved'', so a cancelled day is '
  'immediately schedulable again.';

-- 2) Verify (expect the 4-value CHECK, and no rows changed) ------------------
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid = 'public.time_off_requests'::regclass
--    AND conname  = 'time_off_requests_status_check';
--
-- SELECT status, count(*) FROM time_off_requests GROUP BY status ORDER BY 2 DESC;
