# Test & Production Identities

Reference for who/what is configured in each tenant. Append-only — when identities are retired, mark as inactive but leave the record.

**Security note**: This file is committed to the repo. Do NOT put passwords, API keys, or auth tokens here. Credentials live in a password manager. This file is for IDs, email addresses, role mappings, and routing.

---

## Watermark Country Club (Production)

**company_id**: `a1b2c3d4-e5f6-7890-abcd-ef1234567890`
**Aegis SMS number**: +16167477953
**Aegis email channel**: aegis@aegis.quriasolutions.com
**Timezone**: America/Detroit

### Managers (Homebase users)
| Name | Email | Phone | Role |
|---|---|---|---|
| Carolyn Ringler | c45ringler@gmail.com | +16168223809 | manager |
| Jack McCorkle | jackmc419@icloud.com | +16165519476 | manager |
| Bubba Ganush | lightningmakigga@gmail.com | (see Supabase) | manager (also used as sandbox manager — same auth user) |
| Alexander Darling | awdarling@quriasolutions.com | +16163280114 | quria_admin |

---

## Sandbox Tenant

**company_id**: `00000000-0000-0000-0000-000000000001`
**Aegis email channel**: sandbox@aegis.quriasolutions.com
**Purpose**: end-to-end testing of email/SMS workflows without touching production Watermark data

### Sandbox managers
| Name | Email | Notes |
|---|---|---|
| Bubba Ganush | lightningmakigga@gmail.com | Same auth user as Watermark; inserted into public.users as manager for sandbox company |

### Sandbox employees
| Name | employee_id | Email | Role | Notes |
|---|---|---|---|---|
| Shmubba Sploosh | e1684385-ab46-472d-82b8-9009cd705bde | aegisscheduler@gmail.com | Lifeguard | Primary test employee for TO/availability/swap flows |

### Sandbox seed data
| Table | Notes |
|---|---|
| shift_requirements | PM Lifeguard 15:00-21:00 all days, accepted_roles=ARRAY['Lifeguard'] (seeded June 4 for BUG-2) |
| time_off_requests | Pre-existing seed: employee 00000000-0000-0000-0000-000000000010, dates 2026-07-15 to 2026-07-17, status approved (unknown origin, test fixture data) |
| policies | max_consecutive_days_off=7, min_notice_period_days=7 (TO-R1 setup) |

---

## Process for adding a new test identity

### To add a new manager (with Homebase access)
1. Create the auth user via Supabase Dashboard → Authentication → Users → Add user → Email + password, mark email as confirmed
2. INSERT into public.users with `id` = the auth user's UUID (from the dashboard), `company_id` = target tenant, `role` = 'manager', `email` and `name` populated
3. Test login at homebase-nine-phi.vercel.app

### To add a new test employee
1. INSERT into public.employees with required fields: name, primary_role, qualified_roles, contact_email and/or contact_phone, active=true, sex (CHECK constraint: 'male' or 'female')
2. If they will receive email: ensure the company has a row in company_channels for channel_type='email'
3. Document the new identity in this file under the appropriate tenant section

### To add a new tenant (sandbox or production)
1. Create company row in public.companies
2. Create company_channels row(s) for email and/or SMS routing
3. Create at least one manager via the process above
4. Seed minimum viable shift_requirements (otherwise scheduling won't work — see BUG-2 history)
5. Set up policies as needed (min/max hours, time off rules, etc.)
6. Configure Stripe billing_model if production tenant
7. Document in this file

---

## Inactive / retired identities

(none yet)
