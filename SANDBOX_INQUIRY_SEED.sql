-- ============================================================================
-- OPTIONAL: richer sandbox schedule for testing EMPLOYEE self-service questions
-- (e.g. "when do I work this week?", "who am I working with Saturday?").
--
-- Sandbox tenant ONLY (00000000-0000-0000-0000-000000000001). Never touches Watermark.
--
-- It gives every day (June 7 – July 5, 2026) an AM Lifeguard shift staffed by
-- Shmubba Sploosh + Test Guard B, plus Test Guard A on the PM shift. So Shmubba
-- now has real shifts to ask about, and a coworker (Test Guard B) on the same shift.
--
-- NOTE: this means Shmubba/Test Guard B are "already working" — so if you later
-- want the CLEAN coverage demo back (where they're open candidates), just re-run
-- SANDBOX_COVERAGE_SEED.sql, which resets to Test Guard A only.
-- ============================================================================

DELETE FROM schedules
WHERE company_id = '00000000-0000-0000-0000-000000000001'
  AND week_start = '2026-06-07'
  AND week_end   = '2026-07-05';

INSERT INTO schedules (company_id, week_start, week_end, status, data, generated_at, generated_by)
SELECT
  '00000000-0000-0000-0000-000000000001',
  '2026-06-07'::date,
  '2026-07-05'::date,
  'published',
  jsonb_build_object(
    'assignments',
    (SELECT jsonb_agg(x) FROM (
       SELECT jsonb_build_object(
         'date', to_char(d,'YYYY-MM-DD'),
         'employee_id','aaaa1111-0000-0000-0000-000000000001','employee_name','Test Guard A',
         'shift_name','PM Lifeguard','role','Lifeguard','start_time','15:00:00','end_time','21:00:00','hours',6) AS x
       FROM generate_series('2026-06-07'::date,'2026-07-05'::date, interval '1 day') d
       UNION ALL
       SELECT jsonb_build_object(
         'date', to_char(d,'YYYY-MM-DD'),
         'employee_id','e1684385-ab46-472d-82b8-9009cd705bde','employee_name','Shmubba Sploosh',
         'shift_name','AM Lifeguard','role','Lifeguard','start_time','09:00:00','end_time','15:00:00','hours',6)
       FROM generate_series('2026-06-07'::date,'2026-07-05'::date, interval '1 day') d
       UNION ALL
       SELECT jsonb_build_object(
         'date', to_char(d,'YYYY-MM-DD'),
         'employee_id','bbbb2222-0000-0000-0000-000000000002','employee_name','Test Guard B',
         'shift_name','AM Lifeguard','role','Lifeguard','start_time','09:00:00','end_time','15:00:00','hours',6)
       FROM generate_series('2026-06-07'::date,'2026-07-05'::date, interval '1 day') d
     ) s),
    'gaps','[]'::jsonb
  ),
  now(),
  'aegis';
