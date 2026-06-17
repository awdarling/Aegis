# Test & Production Identities

Reference for who/what is configured in each tenant. Append-only — when identities are retired, mark as inactive but leave the record.

**Security note**: This file is committed to the repo. Do NOT put passwords, API keys, or auth tokens here. Credentials live in a password manager. This file is for IDs, email addresses, role mappings, and routing.

---

## Watermark Country Club (Production) — LIVE since June 5, 2026

**company_id**: `a1b2c3d4-e5f6-7890-abcd-ef1234567890`
**Aegis SMS number**: +16167477953
**Aegis email channel**: aegis@aegis.quriasolutions.com (inbound ECDSA signature verification live; `SKIP_SENDGRID_VERIFICATION=false`)
**Timezone**: America/Detroit

### Managers (Homebase users)
| Name | Email | Phone | Role | Notes |
|---|---|---|---|---|
| Carolyn Ringler | c45ringler@gmail.com | +16168223809 | manager | production manager |
| Jack McCorkle | jackmc419@icloud.com | +16165519476 | manager | production manager |
| Bubba Ganush | lightningmakigga@gmail.com | (see Supabase) | manager | **TEMPORARY** — see note below |
| Alexander Darling | awdarling@quriasolutions.com | +16163280114 | quria | not an employee; employee intents won't work from this address without test setup |

> **Role value note (2026-06-10):** Alexander's `users.role` is **`quria`** (the platform-admin value; the live enum is `'quria' | 'owner' | 'manager'`). `'quria_admin'` is a SEPARATE label used only for `activity_log.actor` and the Aegis `ContactRole` (inbound-sender classification) — it is NOT a `users.role` value. (Previously listed here as `quria_admin`; corrected.)

> **Bubba Ganush status (June 5, 2026; corrected 2026-06-09):** Bubba's `public.users` row sits on Watermark with `role=manager` so Alexander receives a copy of every TO and availability manager-notification during launch monitoring. The earlier phrasing ("repointed from the sandbox company") implied he had been the sandbox manager — he hadn't. `public.users.id` is 1:1 with `auth.users.id`, so this single auth user has always pointed at exactly one company; the sandbox simply never had its own manager row until 2026-06-09 (see Sandbox section). **Remove this manager row after launch monitoring** (LAUNCH FAST-FOLLOW); a dedicated sandbox manager now exists, so Bubba's row can stay on Watermark until removal without breaking sandbox testing.

### Test employees on Watermark (CLEANUP after launch)
| Name / identifier | Email | Role | Notes |
|---|---|---|---|
| aegisscheduler test employee | aegisscheduler@gmail.com | (test) | Set up on Watermark for launch-day end-to-end TO + availability tests (June 5). **Remove from Watermark roster after launch** (FAST-FOLLOW). Also exists as the sandbox employee contact (see below). |

> **Stray pending test TO (CLEANUP):** at least one pending test time-off row exists on Watermark from launch-day testing and is visible to managers in the Time Off tab. Clear the pending test row(s); do NOT delete the legitimate seed/fixture rows (the ~May 22 batch).

---

## Sandbox Tenant

**company_id**: `00000000-0000-0000-0000-000000000001`
**Aegis email channel**: sandbox@aegis.quriasolutions.com
**Purpose**: end-to-end testing of email/SMS workflows without touching production Watermark data

> **Correction (2026-06-09):** earlier docs implied Bubba Ganush had been the sandbox manager and was "repointed" to Watermark. That framing is wrong. `public.users.id` is 1:1 with `auth.users.id` — one auth user, one `users` row, one company. The sandbox simply never had its own manager `users` row; Bubba's single row has always lived on whichever company it was last set to. As of 2026-06-09 the sandbox has a dedicated manager (below), so Bubba's row can stay on Watermark and sandbox manager-side testing works without juggling the same auth user between tenants.

### Sandbox managers
| Name | Email | Role | Notes |
|---|---|---|---|
| Sandbox Manager | sandbox-manager@quriasolutions.com | manager | Dedicated sandbox manager login established 2026-06-09 (own auth user / own `users` row). Used to verify S3 in-tab TO approval round-trip in the sandbox tenant. |

### Sandbox employees
| Name | employee_id | Email | Role | Notes |
|---|---|---|---|---|
| Shmubba Sploosh | e1684385-ab46-472d-82b8-9009cd705bde | aegisscheduler@gmail.com | Lifeguard | Primary test employee for TO/availability/swap flows |
| Test Guard A | aaaa1111-0000-0000-0000-000000000001 | testguarda@example.com | Lifeguard | Added 2026-06-09 for sandbox engine + workflow tests. Safe to use in any sandbox harness; do NOT email a real inbox. |
| Test Guard B | bbbb2222-0000-0000-0000-000000000002 | testguardb@example.com | Lifeguard | Added 2026-06-09 alongside Test Guard A. Same usage notes. |

### Sandbox seed data
| Table | Notes |
|---|---|
| shift_requirements | PM Lifeguard 15:00-21:00 all days, accepted_roles=ARRAY['Lifeguard'] (seeded June 4 for BUG-2). **`required_count` is raised 1→2 by `SANDBOX_RERUN_SEED.sql` for the TO-RERUN-1 flip-test** (3 lifeguards: one off OK, two off = gap). The seed includes a revert back to 1. |
| time_off_requests | Pre-existing seed: employee 00000000-0000-0000-0000-000000000010, dates 2026-07-15 to 2026-07-17, status approved (unknown origin, test fixture data) |
| time_off_requests | **Transient test fixture** — request id `13759531-86fe-43fa-a200-dfb9b2bf3339` (Shmubba Sploosh, 2026-06-20) seeded 2026-06-09 to verify S3 in-tab approve round-trip. Safe to clean up at any time. |
| policies | max_consecutive_days_off=7, min_notice_period_days=7 (TO-R1 setup) |

---

## Process for adding a new test identity

### To add a new manager (with Homebase access)
1. Create the auth user via Supabase Dashboard → Authentication → Users → Add user → Email + password, mark email as confirmed
2. INSERT into public.users with `id` = the auth user's UUID (from the dashboard), `company_id` = target tenant, `role` = 'manager', `email` and `name` populated
3. Test login at homebase-nine-phi.vercel.app

> Reminder: `public.users.id` is a FK to `auth.users.id` and is 1:1 — one auth user maps to exactly one `users` row / one company. Re-pointing an existing auth user (as was done with Bubba) moves them between tenants rather than adding a second membership.

### To add a new test employee
1. INSERT into public.employees with required fields: name, primary_role, qualified_roles, contact_email and/or contact_phone, active=true, sex (CHECK constraint: 'male' or 'female')
2. If they will receive email: ensure the company has a row in company_channels for channel_type='email'
3. Document the new identity in this file under the appropriate tenant section

### To add a new tenant (sandbox or production)
1. Create company row in public.companies
2. Create company_channels row(s) for email and/or SMS routing (column is `channel_value`)
3. Create at least one manager via the process above
4. Seed minimum viable shift_types AND shift_requirements (otherwise the engine produces no slots — see BUG-2 history; remember `accepted_roles` is NOT NULL)
5. Set up policies as needed (the engine reads `policy_value_json`; set `week_start_day` if the tenant builds on a non-Sunday)
6. Configure Stripe billing_model if production tenant
7. Document in this file

---

## Inactive / retired identities

(none yet — Bubba's Watermark manager row and the aegisscheduler Watermark test employee are slated for removal post-launch; move them here when removed.)
