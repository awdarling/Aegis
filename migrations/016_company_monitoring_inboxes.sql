-- 016_company_monitoring_inboxes.sql
--
-- Per-client "observer" inboxes (roadmap item 16, first slice pulled forward).
-- A dedicated Gmail Alexander controls gets BCC'd a copy of EVERY email Aegis
-- sends for that company — a passive audit/troubleshooting trail — WITHOUT being
-- a manager (so it never receives manager authority or steals single-recipient
-- notifications). This is intentionally separate from `company_channels`
-- (which is constrained to 'sms'/'email') and from the `users`/role system.
--
-- Aegis reads this via the service-role client (bypasses RLS). RLS is enabled
-- with a company-scoped policy for any future client/admin-UI access, matching
-- the house pattern. Safe to run more than once.

create table if not exists public.company_monitoring_inboxes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  email text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists company_monitoring_inboxes_company_idx
  on public.company_monitoring_inboxes(company_id);

-- One active row per (company, email) — avoids accidental double-BCC.
create unique index if not exists company_monitoring_inboxes_company_email_uq
  on public.company_monitoring_inboxes(company_id, lower(email));

alter table public.company_monitoring_inboxes enable row level security;

drop policy if exists "Company monitoring inboxes access" on public.company_monitoring_inboxes;
create policy "Company monitoring inboxes access"
  on public.company_monitoring_inboxes
  for all
  using (company_id in (select users.company_id from public.users where users.id = auth.uid()))
  with check (company_id in (select users.company_id from public.users where users.id = auth.uid()));
