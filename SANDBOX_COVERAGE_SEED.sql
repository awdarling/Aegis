-- ============================================================================
-- Sandbox coverage-test seed
-- Scoped ENTIRELY to the SANDBOX tenant (company_id 00000000-0000-0000-0000-000000000001).
-- This does NOT touch Watermark (the live club). Safe to run, and safe to re-run.
--
-- After running this, you can test emergency coverage end-to-end using only your
-- own inboxes: call out "Test Guard A", and "Shmubba Sploosh" (your aegisscheduler
-- gmail) will be the top candidate to accept.
-- ============================================================================

-- 1) Remove any prior copy of this test schedule so the script is safe to re-run.
DELETE FROM schedules
WHERE company_id = '00000000-0000-0000-0000-000000000001'
  AND week_start = '2026-06-07'
  AND week_end   = '2026-07-05';

-- 2) Publish a schedule where Test Guard A works a PM Lifeguard shift every day
--    (June 7 – July 5, 2026). Test Guard A is the person who "calls out".
--    Shmubba and Test Guard B are intentionally NOT scheduled, so they are eligible
--    coverage candidates.
INSERT INTO schedules (company_id, week_start, week_end, status, data, generated_at, generated_by)
SELECT
  '00000000-0000-0000-0000-000000000001',
  '2026-06-07'::date,
  '2026-07-05'::date,
  'published',
  jsonb_build_object(
    'assignments',
    (SELECT jsonb_agg(jsonb_build_object(
       'date',          to_char(d, 'YYYY-MM-DD'),
       'employee_id',   'aaaa1111-0000-0000-0000-000000000001',
       'employee_name', 'Test Guard A',
       'shift_name',    'PM Lifeguard',
       'role',          'Lifeguard',
       'start_time',    '15:00:00',
       'end_time',      '21:00:00',
       'hours',         6
     ))
     FROM generate_series('2026-06-07'::date, '2026-07-05'::date, interval '1 day') AS d),
    'gaps', '[]'::jsonb
  ),
  now(),
  'aegis';

-- 3) Make Shmubba Sploosh available every day, full window, so he qualifies as a
--    candidate for any shift. (His inbox, aegisscheduler@gmail.com, is the one you
--    control — that's how you'll test the "reply YES" accept step.)
DELETE FROM availability
WHERE company_id = '00000000-0000-0000-0000-000000000001'
  AND employee_id = 'e1684385-ab46-472d-82b8-9009cd705bde';

INSERT INTO availability (company_id, employee_id, day_of_week, start_time, end_time)
SELECT '00000000-0000-0000-0000-000000000001',
       'e1684385-ab46-472d-82b8-9009cd705bde',
       g, '00:01:00', '23:59:00'
FROM generate_series(0, 6) AS g;
