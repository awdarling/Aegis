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

### Watermark monitoring inbox (`company_monitoring_inboxes`)
| Email | Active | Row id | Notes |
|---|---|---|---|
| **monitor1@quriasolutions.com** | true | `c110f0ee-f6e7-47ff-b8ea-666bf4f1c2a4` | Roadmap item #16 (first slice) is **BUILT + LIVE**: `messaging/email.ts` BCCs every outbound Watermark email to the active rows here (`resolveMonitoringEmails` → `buildBccList`). **2026-06-30 (corrected):** target is **monitor1@quriasolutions.com** — a FREE **Microsoft 365 shared mailbox** on our own domain (awdarling@ has Full Access; visible in Outlook). The same-day plan to use a free Gmail (`quriamonitor1@gmail.com`) was **ABANDONED and never created**. ⚠️ The live row read `monitorone@quriasolutions.com` (a NON-EXISTENT mailbox → BCCs were bouncing) until this fix; run `update public.company_monitoring_inboxes set email='monitor1@quriasolutions.com' where id='c110f0ee-f6e7-47ff-b8ea-666bf4f1c2a4'` if not already applied. Receive-only passive audit copy; never a manager, never an authority. ⚠️ **Watermark PRODUCTION tenant** — edits are production writes. |

---

## Sandbox Tenant

**company_id**: `00000000-0000-0000-0000-000000000001`
**Aegis email channel**: sandbox@aegis.quriasolutions.com
**Purpose**: end-to-end testing of email/SMS workflows without touching production Watermark data

> **Correction (2026-06-09):** earlier docs implied Bubba Ganush had been the sandbox manager and was "repointed" to Watermark. That framing is wrong. `public.users.id` is 1:1 with `auth.users.id` — one auth user, one `users` row, one company. The sandbox simply never had its own manager `users` row; Bubba's single row has always lived on whichever company it was last set to. As of 2026-06-09 the sandbox has a dedicated manager (below), so Bubba's row can stay on Watermark and sandbox manager-side testing works without juggling the same auth user between tenants.

### Sandbox managers
| Name | Notification email (`public.users.email`) | Login email (`auth.users`) | Role | Notes |
|---|---|---|---|---|
| Sandbox Manager (`3aa0b57d-047a-473b-9e2a-7a00f9191341`) | **sandbox-manager@quriasolutions.com — ⚠️ NOT a real mailbox; notifications go into a void (OPEN)** | sandbox-manager@quriasolutions.com | manager | Dedicated sandbox manager (own auth user / own `users` row, est. 2026-06-09). **2026-06-30 (corrected):** the planned change to a free Gmail (`quriatesting@gmail.com`) was **ABANDONED and never created** (hit Google's phone-verification cap). The live `public.users.email` still reads **sandbox-manager@quriasolutions.com**, which has **NO mailbox** (it's only an auth/login username), so Aegis manager-approval emails (read from `public.users.email` by `notifyManagersByEmail`) are delivered **nowhere**. **⚠️ ACTION before testing the sandbox approval flow:** point this at a real receiving inbox — recommended a FREE M365 **shared mailbox** on our domain (same method as `monitor1@`), e.g. `sandbox-mgr@quriasolutions.com`, then `update public.users set email='sandbox-mgr@quriasolutions.com' where id='3aa0b57d-047a-473b-9e2a-7a00f9191341'`. **Homebase login is unchanged** — it uses `auth.users.email` (still sandbox-manager@quriasolutions.com + password); only where Aegis *delivers* mail needs to move. |

> **Email infrastructure — CORRECTED (2026-06-30):** the earlier "must use a free Gmail" premise was **WRONG**. `@quriasolutions.com` does NOT run on Google Workspace — it runs on **Microsoft 365, managed via GoDaddy** (Exchange Online; tenant admin `awdarling@quriasolutions.com`). The "custom-domain paywall" was Google trying to manage a Google *account* whose username happened to be a quriasolutions.com address — not our actual mail. We can create **FREE M365 shared mailboxes** on our own domain at no per-seat cost (as long as one licensed mailbox exists — `awdarling@` is licensed). Aegis still *sends* from `…@aegis.quriasolutions.com` via SendGrid (separate, unaffected); manager/monitoring inboxes only need to RECEIVE, which shared mailboxes do. **New convention: one FREE M365 shared mailbox per client/role on `@quriasolutions.com`** (e.g. `monitor1@`, `sandbox-mgr@`), accessed from `awdarling@`'s Outlook via Full Access. The free-Gmail plan (`quriatesting@` / `quriamonitor1@gmail.com`) is **ABANDONED — those accounts were never created.**

### Sandbox employees — CURRENT (verified against live DB 2026-06-30)
| Name | employee_id | Email | Qualified roles | Notes |
|---|---|---|---|---|
| Sam Rivera | 11111111-1111-1111-1111-111111111111 | aegisscheduler@gmail.com | guard, Lifeguard | **Real inbox Alexander controls.** Primary test employee (TO / availability / swap requester). |
| Riley Brooks | 22222222-2222-2222-2222-222222222222 | lightningmakigga@gmail.com | guard, Lifeguard | **Real inbox Alexander controls.** Swap candidate / second test employee. (Same inbox also = Watermark's temp "Bubba Ganush" manager — reused across tenants.) |
| Casey Kim | 44444444-4444-4444-4444-444444444444 | casey.demo@example.com | Lifeguard, guard | Demo placeholder — NOT a real inbox; fills the roster for builds/coverage. |
| Jordan Lee | 33333333-3333-3333-3333-333333333333 | jordan.demo@example.com | guard, Lifeguard | Demo placeholder — not a real inbox. |
| Morgan Tate | 55555555-5555-5555-5555-555555555555 | morgan.demo@example.com | Headguard, Lifeguard, guard | Demo placeholder — not a real inbox. |
| Taylor Quinn | 66666666-6666-6666-6666-666666666666 | taylor.demo@example.com | guard, Lifeguard | Demo placeholder — not a real inbox. |

> **Superseded roster (pre-2026-06-30):** the sandbox was re-seeded with the six employees above. The earlier identities — **Shmubba Sploosh** (`e1684385-ab46-472d-82b8-9009cd705bde`, aegisscheduler@gmail.com) and **Test Guard A/B** (`aaaa1111…`, `bbbb2222…`, example.com) — are no longer the live sandbox roster. aegisscheduler@gmail.com now maps to **Sam Rivera**; the swap-candidate real inbox is now **Riley Brooks** (lightningmakigga@gmail.com) rather than a Test Guard. Treat the live DB as source of truth.

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
