-- ============================================================================
-- SANDBOX_RERUN_SEED.sql  —  TO-RERUN-1 test scenario
-- ============================================================================
-- Sets up the sandbox so that ONE guard off is still fine, but TWO guards off
-- on the same day creates a coverage gap. That's the scenario that proves a
-- "Re-run check" flips a recommendation from APPROVE to DON'T-APPROVE after a
-- competing request is approved (the TO-REC-STALE problem).
--
-- The sandbox has exactly 3 active Lifeguards (Shmubba Sploosh, Test Guard A,
-- Test Guard B) and one PM Lifeguard shift. Raising its required_count to 2:
--   • 1 guard off  -> 2 available, need 2  -> feasible  -> "approve"
--   • 2 guards off -> 1 available, need 2  -> GAP       -> "don't approve"
--
-- SANDBOX TENANT ONLY (company_id 0000...0001). Do NOT run on production
-- Watermark. Run in Supabase (sandbox), then follow WORKFLOW_TEST_PLAN.md.
-- Re-runnable: safe to run again before re-testing.
-- ============================================================================

-- 0. Make all 3 guards genuinely available. Deactivate any leftover custom /
--    rotating availability (e.g. the June-13 rotating-feature test data on
--    Shmubba that quietly removed him on weekends + alternating weeks — that, not
--    a bug, is what made earlier re-checks look wrong: the real pool was 2, not 3).
UPDATE custom_availability
SET active = false
WHERE company_id = '00000000-0000-0000-0000-000000000001'
  AND employee_id IN (
    'e1684385-ab46-472d-82b8-9009cd705bde',  -- Shmubba Sploosh
    'aaaa1111-0000-0000-0000-000000000001',  -- Test Guard A
    'bbbb2222-0000-0000-0000-000000000002'   -- Test Guard B
  );

-- 1. Tighten coverage: PM Lifeguard now needs 2 of 3 guards.
UPDATE shift_requirements
SET required_count = 2
WHERE company_id = '00000000-0000-0000-0000-000000000001'
  AND shift_name = 'PM'
  AND role = 'Lifeguard';

-- 2. Clear any leftover test time-off for the 3 sandbox lifeguards so the
--    scenario starts from a clean slate. (Sandbox tenant only.)
DELETE FROM time_off_requests
WHERE company_id = '00000000-0000-0000-0000-000000000001'
  AND employee_id IN (
    'e1684385-ab46-472d-82b8-9009cd705bde',  -- Shmubba Sploosh  (aegisscheduler@gmail.com)
    'aaaa1111-0000-0000-0000-000000000001',  -- Test Guard A     (testguarda@example.com)
    'bbbb2222-0000-0000-0000-000000000002'   -- Test Guard B     (lightningmakigga@gmail.com)
  );

-- 3. Verify the setup (optional — should show required_count = 2 and 3 guards).
-- SELECT shift_name, role, required_count FROM shift_requirements
--   WHERE company_id = '00000000-0000-0000-0000-000000000001';

-- ============================================================================
-- REVERT (after testing) — restore the original PM Lifeguard requirement of 1:
--   UPDATE shift_requirements SET required_count = 1
--   WHERE company_id = '00000000-0000-0000-0000-000000000001'
--     AND shift_name = 'PM' AND role = 'Lifeguard';
-- ============================================================================
