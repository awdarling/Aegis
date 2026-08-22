-- 025_link_users_to_employees.sql
-- Drafted 2026-08-18. HUMAN-GATED — Alexander runs this, in his own terminal.
--
-- ── The problem ─────────────────────────────────────────────────────────────
-- The `users` table has no phone number and no link to `employees`. To text a
-- manager, Aegis string-matches users.email against employees.contact_email —
-- case-SENSITIVELY, in four separately hand-written copies. When it misses it
-- returns null and the text is skipped with no log, no warning, no fallback.
--
-- ── The design (Alexander, 2026-08-18) ──────────────────────────────────────
-- "A manager is still an employee. It's just an employee with a different role
--  in the organization."
--
-- So the PERSON is the employee row. The `users` row is a login plus a set of
-- permissions ATTACHED to that person. Contact information lives in exactly one
-- place — on the employee — and the user row points at it.
--
-- We deliberately do NOT add users.phone. That would create a second phone
-- number for one human, which is exactly the drift Rule 0 forbids.
--
-- ── What this migration adds ────────────────────────────────────────────────
--   users.employee_id            the link. One login ↔ at most one person.
--   employees.schedulable        "may be placed on a schedule." An owner who
--                                never works the floor is a real, contactable
--                                person with this set false.
--   employees.notification_prefs which categories of message this person wants.
--                                Empty {} means "use the default for my role":
--                                an owner gets nothing by default, everyone else
--                                gets everything. An owner can switch categories
--                                on to see what Aegis feels like, then off again.
--
-- ── Safety ──────────────────────────────────────────────────────────────────
-- Additive only. Three new nullable-or-defaulted columns, two indexes, one
-- foreign key. No existing column is altered, no row is rewritten, nothing is
-- dropped. Existing behaviour is unchanged until the code that reads these
-- columns is deployed, and the resolver falls back to today's email matching
-- for any user whose employee_id is still null.
--
-- Run this BEFORE deploying the Phase 2 Aegis branch.
-- Then run the backfill in 025_backfill_users_employee_id.sql as a separate step.

BEGIN;

-- ── 1. Tenancy-safe composite key on employees ──────────────────────────────
-- Lets the users → employees foreign key carry company_id, so the DATABASE
-- refuses to link a login to a person in a different company. `id` is already
-- the primary key, so this adds no meaningful storage and cannot fail on
-- existing data.
ALTER TABLE public.employees
  ADD CONSTRAINT employees_id_company_id_key UNIQUE (id, company_id);

-- ── 2. The link ─────────────────────────────────────────────────────────────
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS employee_id uuid;

COMMENT ON COLUMN public.users.employee_id IS
  'The person this login belongs to. Contact details (phone, email) live on the employee row and are read from there — users has no phone by design (Rule 0: one fact, one place). NULL means this login is not yet linked to a person; Aegis falls back to matching on email and logs a warning.';

-- Composite FK: the linked employee must be in the SAME company as the login.
-- ON DELETE SET NULL nulls only employee_id (Postgres 15+ column-list form);
-- company_id is NOT NULL and is left alone. Verified: this database is
-- PostgreSQL 17.6.
ALTER TABLE public.users
  ADD CONSTRAINT users_employee_id_fkey
  FOREIGN KEY (employee_id, company_id)
  REFERENCES public.employees (id, company_id)
  ON DELETE SET NULL (employee_id);

-- One person has at most one login. Partial, so any number of logins may remain
-- unlinked while the backfill is in progress.
CREATE UNIQUE INDEX IF NOT EXISTS users_employee_id_unique
  ON public.users (employee_id)
  WHERE employee_id IS NOT NULL;

-- ── 3. Schedulable ──────────────────────────────────────────────────────────
-- Distinct from `active`, and deliberately so:
--   active = false   → not here right now. Uncontactable AND unschedulable.
--                      Seasonal staff between summers, someone on leave. The
--                      record is preserved and a manager flips it back on when
--                      they return. (Existing behaviour — unchanged.)
--   schedulable=false→ here, reachable, receives messages, but never placed on
--                      a schedule. An owner, a bookkeeper, an office manager.
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS schedulable boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.employees.schedulable IS
  'May this person be placed on a schedule? Default true. Set false for someone who is present and contactable but never works the floor (an owner, a bookkeeper). Different from active: active=false means not here right now — uncontactable and unschedulable, and reversible when they come back.';

-- ── 4. Notification preferences ─────────────────────────────────────────────
-- Shape (all keys optional; an absent key means "use the default for my role"):
--   { "approvals": bool, "trades": bool, "schedule_posts": bool, "reports": bool }
-- Defaults applied in code (src/messaging/manager-directory.ts):
--   role 'owner'  → every category OFF
--   everyone else → every category ON
-- Safety valve, also in code: if honouring these preferences would leave an
-- ACTION ITEM with nobody to send it to, it is sent to every manager anyway and
-- the override is logged. A request must never silently reach no one.
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.employees.notification_prefs IS
  'Per-category opt-in/out: {"approvals":bool,"trades":bool,"schedule_posts":bool,"reports":bool}. An absent key means use the role default — owners default to OFF for every category, everyone else defaults to ON. An owner can switch a category on to inspect what Aegis feels like, then off again.';

-- Guard the shape so a bad write fails loudly at the database instead of
-- silently changing who gets notified.
ALTER TABLE public.employees
  ADD CONSTRAINT employees_notification_prefs_is_object
  CHECK (jsonb_typeof(notification_prefs) = 'object');

-- ── 5. Lookup index ─────────────────────────────────────────────────────────
-- The resolver's hot path is "every manager/owner for this company, with their
-- person record" — and it must ignore revoked logins.
CREATE INDEX IF NOT EXISTS users_company_role_active_idx
  ON public.users (company_id, role)
  WHERE access_revoked_at IS NULL;

COMMIT;

-- ── VERIFICATION — run this after. ──────────────────────────────────────────
-- Expect: 3 rows for the new columns, and the employees rows showing
-- schedulable = true and notification_prefs = {} for everyone (defaults).
--
--   SELECT table_name, column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND (table_name = 'users'     AND column_name = 'employee_id'
--      OR  table_name = 'employees' AND column_name IN ('schedulable', 'notification_prefs'))
--   ORDER BY table_name, column_name;
--
-- And confirm nothing was linked yet (the backfill is a separate step):
--
--   SELECT count(*) AS total_logins,
--          count(employee_id) AS linked,
--          count(*) - count(employee_id) AS still_unlinked
--   FROM public.users;
--
-- Expect on Watermark today: total_logins 4, linked 0, still_unlinked 4.
