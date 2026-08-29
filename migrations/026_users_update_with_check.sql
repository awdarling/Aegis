-- 026 — N-5: stop a login from rewriting its own role / company_id.
--
-- STATUS: already APPLIED to the production database by Alexander on 2026-08-26
-- (verified in pg_policies: with_check non-null). This file exists so a fresh
-- tenant/database gets the same rule automatically (DRIFT_REGISTER §E12).
-- Idempotent. No data changes.
--
-- Why: the users UPDATE policy was `using (id = auth.uid())` with NO WITH CHECK,
-- so a login could write ANY column of its own row — including role and
-- company_id (self-promotion). Harmless while no route writes users with a user
-- token; a live hole the moment routes move onto the caller's own token (S-1).

drop policy if exists "Users can update own profile" on public.users;

create policy "Users can update own profile"
  on public.users
  for update
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and role = public.get_my_role()
    and company_id = public.get_my_company_id()
    and (access_revoked_at is not distinct from (select u.access_revoked_at from public.users u where u.id = auth.uid()))
  );
