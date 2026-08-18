-- 025_backfill_users_employee_id.sql
-- Drafted 2026-08-18. HUMAN-GATED — Alexander runs this, in his own terminal.
-- RUN 025_link_users_to_employees.sql FIRST. This is step 2 of 2.
--
-- Links each existing login to the person it belongs to, where that can be
-- established beyond doubt. It is deliberately conservative: it links ONLY when
-- exactly one person in the same company has that email address. An ambiguous
-- or missing match is left NULL and reported, for a human to decide.
--
-- Nothing is deleted and no contact detail is changed. The only column written
-- is users.employee_id, and only where it is currently NULL.
--
-- ── What this will do on Watermark today (checked 2026-08-18) ───────────────
--   Carolyn Ringler  → linked
--   Jack McCorkle    → linked
--   Sandbox Manager  → linked (sandbox tenant)
--   Bubba Ganush     → NOT linked. A revoked test account; being deleted
--                      separately. See 025_cleanup_test_manager.sql.
--   Xander Darling   → NOT linked, and correctly so. role='quria' — a platform
--                      admin is not an employee of a client. His contact details
--                      already live in quria_staff (+1 616 328 0114), which is
--                      where they belong.

BEGIN;

-- ── STEP 1 — look before you leap. Read this output, then continue. ─────────
-- Lists every login and what the backfill would do with it.
SELECT
  u.name                                   AS login_name,
  u.email,
  u.role,
  (u.access_revoked_at IS NOT NULL)        AS revoked,
  m.match_count,
  m.matched_person,
  CASE
    WHEN u.employee_id IS NOT NULL         THEN 'already linked — skipped'
    WHEN u.role = 'quria'                  THEN 'platform admin — deliberately not linked'
    WHEN m.match_count = 1                 THEN 'WILL LINK'
    WHEN m.match_count = 0                 THEN 'no person with that email — needs a human'
    ELSE                                        'AMBIGUOUS: several people share that email — needs a human'
  END                                      AS what_happens
FROM public.users u
LEFT JOIN LATERAL (
  SELECT count(*) AS match_count,
         min(e.name) FILTER (WHERE true) AS matched_person
  FROM public.employees e
  WHERE e.company_id = u.company_id
    AND lower(trim(e.contact_email)) = lower(trim(u.email))
) m ON true
ORDER BY u.company_id, u.role, u.email;

-- ── STEP 2 — the backfill itself. ───────────────────────────────────────────
-- Only links where exactly ONE person in the SAME company has that email.
-- Case- and whitespace-insensitive, unlike the code it replaces.
-- Skips platform admins and anything already linked.
UPDATE public.users u
SET employee_id = sub.employee_id
FROM (
  SELECT u2.id AS user_id, min(e.id) AS employee_id
  FROM public.users u2
  JOIN public.employees e
    ON e.company_id = u2.company_id
   AND lower(trim(e.contact_email)) = lower(trim(u2.email))
  WHERE u2.employee_id IS NULL
    AND u2.role IN ('manager', 'owner')
  GROUP BY u2.id
  HAVING count(*) = 1
) sub
WHERE u.id = sub.user_id;

COMMIT;

-- ── VERIFICATION — run this after. ──────────────────────────────────────────
-- Expect, on Watermark today: 3 linked, and the only unlinked rows are
-- Xander Darling (quria, correct) and Bubba Ganush (revoked test account, being
-- deleted). If any REAL working manager appears as unlinked, that is the list of
-- people Aegis still cannot text — fix them in Homebase → Access → Link to
-- person, or create their employee record first.
--
--   SELECT u.name, u.email, u.role,
--          (u.access_revoked_at IS NOT NULL) AS revoked,
--          e.name  AS linked_person,
--          e.contact_phone,
--          CASE WHEN e.contact_phone IS NOT NULL THEN 'can be texted'
--               WHEN u.employee_id IS NOT NULL   THEN 'linked, but no phone on file'
--               ELSE                                  'NOT LINKED — email only'
--          END AS reachability
--   FROM public.users u
--   LEFT JOIN public.employees e ON e.id = u.employee_id
--   ORDER BY u.company_id, u.role, u.email;
--
-- And the one-line summary:
--
--   SELECT count(*) FILTER (WHERE role IN ('manager','owner') AND access_revoked_at IS NULL) AS live_managers,
--          count(*) FILTER (WHERE role IN ('manager','owner') AND access_revoked_at IS NULL AND employee_id IS NOT NULL) AS linked
--   FROM public.users;
--
-- Expect: live_managers 3, linked 3 once Bubba is deleted. (2 Watermark + 1 sandbox.)


-- ── OPTIONAL — mark an owner as "never rostered". ───────────────────────────
-- Not part of the backfill; run it only when there IS such a person. Replace the
-- email. This is the switch that lets an owner be a real, contactable person who
-- never appears on a schedule.
--
--   UPDATE public.employees
--   SET schedulable = false
--   WHERE company_id = 'PUT-THE-COMPANY-ID-HERE'
--     AND lower(trim(contact_email)) = lower(trim('owner@theirclub.com'));
--
-- Verify: SELECT name, active, schedulable, notification_prefs
--         FROM public.employees WHERE schedulable = false;
--
-- Their notification preferences default to "an owner hears nothing" the moment
-- their login has role='owner'. To let them watch one category — say the weekly
-- reports — for a while:
--
--   UPDATE public.employees
--   SET notification_prefs = notification_prefs || '{"reports": true}'::jsonb
--   WHERE id = 'THEIR-EMPLOYEE-ID';
