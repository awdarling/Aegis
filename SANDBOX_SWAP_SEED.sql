-- ============================================================
-- SANDBOX_SWAP_SEED.sql — clean published schedule for testing shift swaps
-- ============================================================
-- Sandbox company ONLY (Quria Sandbox, 00000000-0000-0000-0000-000000000001).
-- Drops a clean published schedule for the week of Jun 22–28, 2026 set up for a
-- TWO-WAY TRADE (the redesigned swap):
--   • Shmubba Sploosh (aegisscheduler@gmail.com) — PM Lifeguard, Sat Jun 27
--   • Test Guard B  (lightningmakigga@gmail.com) — PM Lifeguard, Fri Jun 26
--
-- Both are Lifeguard-qualified and fully available, so a trade in EITHER
-- direction validates. To test a DIRECTED trade, Shmubba emails Aegis:
--   "Swap my Saturday PM shift for Test Guard B's Friday PM."
-- A completed trade rewrites this schedule, so RE-RUN this whole file before
-- each test to reset. Safe: sandbox tenant only; seeding notifies no one
-- (published_at is set, distributed_at stays null).
-- ============================================================

begin;

-- Reset: clear any existing sandbox schedule for that week.
delete from schedules
where company_id = '00000000-0000-0000-0000-000000000001'
  and week_start = '2026-06-22';

with sb as (
  select id, name from employees
  where company_id = '00000000-0000-0000-0000-000000000001'
    and contact_email = 'aegisscheduler@gmail.com' limit 1
), tg as (
  select id, name from employees
  where company_id = '00000000-0000-0000-0000-000000000001'
    and contact_email = 'lightningmakigga@gmail.com' limit 1
)
insert into schedules
  (company_id, week_start, week_end, generated_at, generated_by, status, published_at, data, staffing_report)
select
  '00000000-0000-0000-0000-000000000001',
  '2026-06-22', '2026-06-28',
  now(), 'aegis', 'published', now(),
  jsonb_build_object(
    'assignments', jsonb_build_array(
      jsonb_build_object(
        'date', '2026-06-27', 'employee_id', sb.id::text, 'employee_name', sb.name,
        'shift_name', 'PM', 'role', 'Lifeguard', 'start_time', '13:00:00', 'end_time', '21:00:00', 'hours', 8
      ),
      jsonb_build_object(
        'date', '2026-06-26', 'employee_id', tg.id::text, 'employee_name', tg.name,
        'shift_name', 'PM', 'role', 'Lifeguard', 'start_time', '13:00:00', 'end_time', '21:00:00', 'hours', 8
      )
    ),
    'gaps', '[]'::jsonb,
    'flagged_issues', '[]'::jsonb
  ),
  '{}'::jsonb
from sb, tg;

commit;
