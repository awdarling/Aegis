-- 021_employees_sms_consent_state.sql
-- N3 (2026-08-14) — durable, denormalized SMS consent flag on `employees`.
--
-- WHY: outbound SMS was reaching employees who never opted in. Consent lived
-- only as activity_log events (employee_opt_in_confirmed / _declined /
-- employee_opted_out / employee_resubscribed), which the send layer never read.
-- This adds a denormalized cache the send chokepoint (messaging/consent.ts →
-- canSmsEmployee) can consult with one indexed read. The activity_log remains
-- the SOURCE OF RECORD; this column is kept in lockstep by
-- setEmployeeConsentState at every consent-event site + seeded by the backfill
-- below.
--
-- SAFETY: additive + nullable + IF NOT EXISTS. NULL means "no consent on record"
-- and is treated as BLOCKED (fail closed) by canSmsEmployee — so even if the
-- backfill is skipped, no employee is ever texted without a positive consent
-- state. RUN THIS (both the ALTER and the BACKFILL) BEFORE deploying the N3 code,
-- otherwise every already-opted-in employee reads NULL and falls back to email
-- until the backfill runs.
--
-- HUMAN-GATED: Alexander runs this in the Supabase SQL editor. The agent's
-- Supabase MCP is read-only.

-- 1) The columns -------------------------------------------------------------
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS sms_consent_state text,
  ADD COLUMN IF NOT EXISTS sms_consent_updated_at timestamptz;

-- Domain guard: only the five known states, or NULL (= none on record).
-- Idempotent-ish: drop-if-exists then add, so re-running is safe.
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_sms_consent_state_check;
ALTER TABLE employees
  ADD CONSTRAINT employees_sms_consent_state_check
  CHECK (sms_consent_state IS NULL OR sms_consent_state IN
    ('none','confirmed','declined','opted_out','resubscribed'));

-- Partial index for the hot lookup (send chokepoint filters by id+company; this
-- just keeps the consent read cheap on large rosters). Optional but cheap.
CREATE INDEX IF NOT EXISTS idx_employees_sms_consent_state
  ON employees (company_id, sms_consent_state);

-- 2) Backfill from the activity_log (latest consent event per employee wins) --
-- DISTINCT ON picks the newest event per employee_id; map its action → state.
WITH latest AS (
  SELECT DISTINCT ON (entity_id)
         entity_id AS employee_id,
         action,
         created_at
  FROM activity_log
  WHERE entity_type = 'employee'
    AND entity_id IS NOT NULL
    AND action IN (
      'employee_opt_in_confirmed',
      'employee_opt_in_declined',
      'employee_opted_out',
      'employee_resubscribed'
    )
  ORDER BY entity_id, created_at DESC
)
UPDATE employees e
SET sms_consent_state = CASE latest.action
      WHEN 'employee_opt_in_confirmed' THEN 'confirmed'
      WHEN 'employee_opt_in_declined'  THEN 'declined'
      WHEN 'employee_opted_out'        THEN 'opted_out'
      WHEN 'employee_resubscribed'     THEN 'resubscribed'
    END,
    sms_consent_updated_at = latest.created_at
FROM latest
WHERE e.id = latest.employee_id;

-- 3) Verify (read-only — expect ~31 confirmed + 2 declined on Watermark as of
--    2026-08-14; every other employee stays NULL = blocked/fail-closed):
--   SELECT sms_consent_state, count(*) FROM employees GROUP BY 1 ORDER BY 1;
