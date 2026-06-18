-- ============================================================
-- SANDBOX_PUBLISH_SEED.sql — test data for Publish + Republish (items 9 + 12)
-- ============================================================
-- Run this in the SANDBOX tenant ONLY, AFTER applying migration 016 in sandbox.
-- It sets up the current week (Sun 2026-06-14 .. Sat 2026-06-20, which contains
-- today 2026-06-17) with:
--   * an already-PUBLISHED schedule (the "old" one), and
--   * a DRAFT alternate for the SAME week in which ONE employee's shift changed.
--
-- That lets you test republish in one click: open Schedule → the published one is
-- the primary "this week" card, the draft shows under "Alternate version for this
-- week" with a "Publish & Replace" button. Clicking it should:
--   - notify ONLY Shmubba (his Monday shift moved 15:00→16:00) at his real inbox
--     aegisscheduler@gmail.com; Test Guard A is unchanged and is NOT emailed,
--   - archive the old schedule (archived_at + superseded_by set, published_at NULL),
--   - clear ONLY the old schedule's staffing_report.estimated_wages,
--   - publish the new schedule (published_at + distributed_at set).
--
-- Re-runnable: it deletes its own fixed-id rows first.
-- ============================================================

-- Fixed ids so the seed is idempotent and the verification queries are stable.
--   OLD (published): 5ed0...0001     NEW (draft alternate): 5ed0...0002
delete from public.schedules
  where id in ('5ed00000-0000-0000-0000-000000000001',
               '5ed00000-0000-0000-0000-000000000002');

-- OLD — the currently published schedule for the week.
insert into public.schedules
  (id, company_id, week_start, week_end, generated_at, generated_by, status,
   published_at, distributed_at, data, staffing_report)
values (
  '5ed00000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '2026-06-14', '2026-06-20',
  now() - interval '2 days', 'aegis', 'published',
  now() - interval '2 days', now() - interval '2 days',
  jsonb_build_object(
    'assignments', jsonb_build_array(
      jsonb_build_object('date','2026-06-15','employee_id','e1684385-ab46-472d-82b8-9009cd705bde','employee_name','Shmubba Sploosh','shift_name','PM Lifeguard','role','Lifeguard','start_time','15:00','end_time','21:00','hours',6),
      jsonb_build_object('date','2026-06-16','employee_id','aaaa1111-0000-0000-0000-000000000001','employee_name','Test Guard A','shift_name','PM Lifeguard','role','Lifeguard','start_time','15:00','end_time','21:00','hours',6)
    ),
    'gaps', jsonb_build_array(),
    'flagged_issues', jsonb_build_array()
  ),
  jsonb_build_object('estimated_wages', jsonb_build_object('total_estimated', 180), 'engine_version', 'seed')
);

-- NEW — the draft alternate for the SAME week. Shmubba's Monday shift moved to
-- 16:00 (CHANGED); Test Guard A's Tuesday shift is identical (UNCHANGED).
insert into public.schedules
  (id, company_id, week_start, week_end, generated_at, generated_by, status,
   published_at, distributed_at, data, staffing_report)
values (
  '5ed00000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  '2026-06-14', '2026-06-20',
  now(), 'aegis', 'draft',
  null, null,
  jsonb_build_object(
    'assignments', jsonb_build_array(
      jsonb_build_object('date','2026-06-15','employee_id','e1684385-ab46-472d-82b8-9009cd705bde','employee_name','Shmubba Sploosh','shift_name','PM Lifeguard','role','Lifeguard','start_time','16:00','end_time','21:00','hours',5),
      jsonb_build_object('date','2026-06-16','employee_id','aaaa1111-0000-0000-0000-000000000001','employee_name','Test Guard A','shift_name','PM Lifeguard','role','Lifeguard','start_time','15:00','end_time','21:00','hours',6)
    ),
    'gaps', jsonb_build_array(),
    'flagged_issues', jsonb_build_array()
  ),
  jsonb_build_object('estimated_wages', jsonb_build_object('total_estimated', 170), 'engine_version', 'seed')
);

-- ── Verification (run AFTER clicking "Publish & Replace" in Homebase) ─────────
-- Expect: old row archived_at NOT NULL, superseded_by = NEW id, published_at NULL,
-- staffing_report has NO 'estimated_wages' key; new row published_at NOT NULL,
-- distributed_at NOT NULL, archived_at NULL.
--
-- select id, status, published_at is not null as published, archived_at is not null as archived,
--        superseded_by, distributed_at is not null as distributed,
--        staffing_report ? 'estimated_wages' as has_wages
-- from public.schedules
-- where id in ('5ed00000-0000-0000-0000-000000000001','5ed00000-0000-0000-0000-000000000002');
--
-- And the change notification activity:
-- select action, summary from public.activity_log
-- where company_id='00000000-0000-0000-0000-000000000001'
--   and action in ('schedule_republished','schedule_superseded','schedule_change_notified')
-- order by created_at desc limit 10;
