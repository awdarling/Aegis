-- ============================================================================
-- B1 — Stand up a SECOND sandbox tenant ("Quria Sandbox Two")
-- Purpose: prove tenant-aware outbound Reply-To + threading + strict inbound
--          routing with ZERO cross-talk between two tenants.
--
-- ⚠️ SANDBOX ONLY. Do NOT run against the live Watermark tenant
--    (a1b2c3d4-e5f6-7890-abcd-ef1234567890).
-- ⚠️ Supabase MCP is read-only — Alexander runs this (SQL editor / service role).
-- All columns verified against information_schema on 2026-07-26.
-- Idempotent: WHERE NOT EXISTS guards make re-runs safe (company_channels has
--   NO unique constraint, so a naive re-insert would create a DUPLICATE
--   channel_value row — which breaks resolveCompanyId's .maybeSingle()).
--
-- Tenant B:
--   company_id  : 00000000-0000-0000-0000-000000000002   (mirrors sandbox ...0001)
--   Aegis email : sandbox2@aegis.quriasolutions.com       (LOWERCASE — required)
--
-- 🔑 ROUTING NOTE: the inbound webhook lowercases the recipient before matching,
--    so channel_value MUST be lowercase or inbound mail to this tenant is dropped.
-- 🔑 SendGrid: this address is on the EXISTING aegis.quriasolutions.com subdomain
--    (same as Watermark's aegis@ and the sandbox's sandbox@), which already has an
--    MX → SendGrid Inbound Parse route catching ALL local-parts on that host. So
--    sandbox2@aegis.quriasolutions.com needs NO new SendGrid/DNS setup. (A brand-
--    new SUBDOMAIN would; a new local-part on this subdomain does not.)
-- ============================================================================

begin;

-- 1) Company row -------------------------------------------------------------
insert into public.companies (id, name, timezone, onboarding_complete)
values ('00000000-0000-0000-0000-000000000002', 'Quria Sandbox Two', 'America/Detroit', true)
on conflict (id) do nothing;

-- 2) Per-tenant email channel (the Reply-To routing target) ------------------
insert into public.company_channels (company_id, channel_type, channel_value)
select '00000000-0000-0000-0000-000000000002', 'email', 'sandbox2@aegis.quriasolutions.com'
where not exists (
  select 1 from public.company_channels
  where channel_type = 'email' and channel_value = 'sandbox2@aegis.quriasolutions.com'
);

-- 3) Test employee (a real inbox you control) --------------------------------
--    Reuses Riley's inbox as a DIFFERENT person in tenant B. This makes the
--    zero-cross-talk proof strongest: ONE physical inbox, two tenants — a reply
--    to tenant A's address must resolve to Riley(A), a reply to tenant B's
--    address must resolve to Robin(B). Swap the email for a distinct inbox if
--    you'd rather keep them fully separate.
insert into public.employees
  (company_id, name, primary_role, qualified_roles, contact_email, sex, aegis_access, active)
select '00000000-0000-0000-0000-000000000002', 'Robin Vale', 'Lifeguard',
       array['Lifeguard'], 'lightningmakigga@gmail.com', 'female', 'employee', true
where not exists (
  select 1 from public.employees
  where company_id = '00000000-0000-0000-0000-000000000002'
    and contact_email = 'lightningmakigga@gmail.com'
);

-- 4) Minimal schedulable structure (OPTIONAL) --------------------------------
--    Only needed if you also want to build/distribute a schedule for tenant B.
--    NOT required for the pure Reply-To / threading / routing proof.
insert into public.shift_types (company_id, name, start_time, end_time, days_active, active)
select '00000000-0000-0000-0000-000000000002', 'PM Lifeguard',
       '15:00:00', '21:00:00', '{0,1,2,3,4,5,6}'::integer[], true
where not exists (
  select 1 from public.shift_types
  where company_id = '00000000-0000-0000-0000-000000000002' and name = 'PM Lifeguard'
);

insert into public.shift_requirements (company_id, role, required_count, shift_type_id, accepted_roles)
select '00000000-0000-0000-0000-000000000002', 'Lifeguard', 1, st.id, array['Lifeguard']
from public.shift_types st
where st.company_id = '00000000-0000-0000-0000-000000000002' and st.name = 'PM Lifeguard'
  and not exists (
    select 1 from public.shift_requirements sr
    where sr.company_id = '00000000-0000-0000-0000-000000000002'
      and sr.shift_type_id = st.id and sr.role = 'Lifeguard'
  );

commit;

-- 5) MANAGER (optional — only for manager-side workflow tests) ----------------
-- Not needed for the routing/threading/cross-talk proof (the employee round-trip
-- covers it). If you want a manager for tenant B:
--   (a) Create the auth user first in Supabase Dashboard → Authentication → Users
--       (email = a mailbox you receive at, e.g. a FREE M365 shared mailbox
--        sandbox2-mgr@quriasolutions.com; mark email confirmed).
--   (b) Then insert the public.users row with id = that auth user's UUID:
--   insert into public.users (id, company_id, role, email, name)
--   values ('<AUTH_USER_UUID>', '00000000-0000-0000-0000-000000000002',
--           'manager', 'sandbox2-mgr@quriasolutions.com', 'Sandbox Two Manager');
--   (public.users.id is a FK to auth.users.id — the auth user MUST exist first.)

-- 6) Verify ------------------------------------------------------------------
select c.name, ch.channel_type, ch.channel_value
from public.companies c
join public.company_channels ch on ch.company_id = c.id
where c.id = '00000000-0000-0000-0000-000000000002';

select name, primary_role, contact_email, aegis_access
from public.employees
where company_id = '00000000-0000-0000-0000-000000000002';
