-- 023_swap_requests_trade_columns.sql
-- L4b (2026-08-16) — let a two-way TRADE be approved from the Homebase Swaps tab.
--
-- WHY: `swap_requests` has never been able to represent a trade. Its columns
-- describe ONE shift (shift_date / shift_name / role) — the shift the requester
-- is giving up. A two-way trade also has a RETURN shift, and that lived only in
-- the decision-token payload attached to the manager's approval EMAIL.
--
-- Consequences, both real and both fixed by this migration + the L4b code:
--
--   1. The Homebase UI approval path reconstructs its decision from the row, so
--      it had nothing to branch on. It called the ONE-WAY executor
--      unconditionally: approving a trade moved one shift, silently dropped the
--      return leg, marked the request approved, and told the requester they were
--      "off" when they had agreed to work the coworker's shift.
--   2. The row could not even record WHICH KIND of thing it was. The directed
--      path wrote the byte-identical note
--         'Both employees agreed via Aegis. Directed swap.'
--      for a one-way giveaway AND a two-way trade, while
--      `outreach.target_shift_name` — the one field that told them apart — was in
--      scope at the insert and thrown away.
--
-- L4 shipped an interim fix: persist the kind as a bounded marker on `notes`
-- (`[quria:kind=giveaway|pickup|trade]`) and FAIL CLOSED, refusing anything the
-- UI can't prove is one-way. That made it safe. This migration makes it WORK.
--
-- SAFETY: purely additive + nullable + IF NOT EXISTS. No existing row changes,
-- nothing can fail validation, and every current value stays legal. The `kind`
-- CHECK permits NULL so pre-migration rows remain valid.
--
-- ORDERING: RUN THIS BEFORE DEPLOYING THE L4b CODE. Without it the inserts throw
-- (42703, column does not exist) and NO swap request can be created at all —
-- this is the one migration in the batch whose absence breaks an existing
-- workflow rather than just withholding a new one.
--
-- BACKWARD COMPATIBILITY: the code reads the columns FIRST and falls back to the
-- `notes` marker when `kind` is NULL, so any row created between the L4 deploy
-- and this migration still resolves correctly. The backfill below closes that
-- gap for good. `target_shift_*` cannot be backfilled — it was never stored —
-- so a pre-migration TRADE row still can't be approved from the UI and is still
-- refused with the "use the approval email" message. Verified read-only
-- 2026-08-16: ZERO pending_manager rows exist, so in practice this affects
-- nothing.
--
-- HUMAN-GATED: Alexander runs this in the Supabase SQL editor. The agent's
-- Supabase MCP is read-only.

-- 1) The columns ------------------------------------------------------------
ALTER TABLE swap_requests
  ADD COLUMN IF NOT EXISTS kind              text,
  ADD COLUMN IF NOT EXISTS target_shift_date date,
  ADD COLUMN IF NOT EXISTS target_shift_name text,
  ADD COLUMN IF NOT EXISTS target_shift_role text;

-- Domain guard: the three real kinds, or NULL (= a pre-migration row).
ALTER TABLE swap_requests DROP CONSTRAINT IF EXISTS swap_requests_kind_check;
ALTER TABLE swap_requests
  ADD CONSTRAINT swap_requests_kind_check
  CHECK (kind IS NULL OR kind = ANY (ARRAY['giveaway'::text, 'pickup'::text, 'trade'::text]));

COMMENT ON COLUMN swap_requests.kind IS
  'giveaway | pickup | trade. A trade moves TWO assignments and needs '
  'target_shift_*; giveaway/pickup move exactly one. NULL = created before '
  'migration 023; readers fall back to the [quria:kind=...] marker in notes.';
COMMENT ON COLUMN swap_requests.target_shift_date IS
  'TRADE only: the date of the shift the RECEIVER gives back to the requester. '
  'NULL for giveaway/pickup.';

-- 2) Backfill `kind` from the notes marker L4 has been writing ---------------
-- Only touches rows that actually carry the marker; everything else stays NULL
-- and continues to be treated as unknown (and therefore refused in the UI).
UPDATE swap_requests
   SET kind = substring(notes from '\[quria:kind=(giveaway|pickup|trade)\]')
 WHERE kind IS NULL
   AND notes ~ '\[quria:kind=(giveaway|pickup|trade)\]';

-- 3) Index for the manager's Swaps tab (pending rows per company) ------------
CREATE INDEX IF NOT EXISTS idx_swap_requests_company_status
  ON swap_requests (company_id, status);

-- 4) Verify ------------------------------------------------------------------
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'swap_requests'
--    AND column_name IN ('kind','target_shift_date','target_shift_name','target_shift_role');
--
-- SELECT kind, count(*) FROM swap_requests GROUP BY kind ORDER BY 2 DESC;
-- -- expect: a row per kind for anything created since the L4 deploy, plus
-- --         NULL for everything older. No rows should have been lost.
