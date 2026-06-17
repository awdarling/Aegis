# HOMEBASE — Product Reference

**Features, Capabilities & Workflows**

**Version 3.2 — June 16, 2026**

> **v3.2 changelog (2026-06-16):** §2.2 (Time Off) gains the **"Re-run check"** button (TO-RERUN-1) for re-running Aegis's coverage recommendation on a PENDING request against current approvals, plus the cross-channel **resolution / click-guard** behavior (named "already decided" guard, "✓ Resolved" thread reply). New §8 documents the **Aegis magic-link landing pages** — the Quria-dark rebrand (`renderActionResultPage`), the softened "already used" message, and the email-card `recheck_to` → reply-in-thread flow. §1 (Home) cross-refs the new `/internal/recompute-to-recommendation` + `/internal/recheck-to-reply` bridge endpoints.
>
> **v3.1 changelog (2026-06-10):** §4.3 `xlsx → exceljs` swap is DONE (styled Excel + PDF both render via shared `buildScheduleGrid`) — removed from the Tier-2 "nice-to-have" framing; new open item logged for a download FORMAT rework + template-builder polish. §5 records the live create-user authz fix (owner/quria only, owner pinned to own `company_id`, role capped at creator's privilege; four `/api/*` routes now carry the standard cookie+`company_id` guard) and adds a KNOWN BUG: revoking/deleting a PRE-EXISTING user silently fails (FK-blocked).

---

## Overview

Homebase is a Next.js 14 (App Router) web app on Vercel — the manager-facing control platform. TypeScript, Supabase for data, Anthropic claude-sonnet-4-6 for the embedded Soteria assistant. It is the operating environment that lets the Aegis AI manager function: structure data, define rules, review AI output, retain oversight.

| Aspect | Value |
|---|---|
| Repo | github.com/awdarling/Homebase (`~/Desktop/homebase`) |
| Production URL | homebase-nine-phi.vercel.app (dead preview: `homebase-liart` — never use) |
| Auth | Supabase Auth (email/password), middleware-gated `/(app)/` routes |
| Database | Supabase via `@supabase/supabase-js` (anon key client-side, service role server-side) |
| AI | claude-sonnet-4-6 via `/api/soteria`, max_tokens 8192 |
| Styling | custom CSS variables, dark theme, accent `#F97316` |

Navigation: Home, Data (9 sub-tabs), Rules, Schedule, Activity, Access, Billing. Soteria is a floating panel on every page.

---

## 1. Home Page

System-state overview: active employee count, pending time-off count, current/next-week schedule status, blocked/attention items, and a recent `activity_log` feed (Aegis/Soteria/human avatars; quria_admin styled distinctly; routing-noise entries containing `-> intent:` are filtered out).

---

## 2. Data Tab (9 sub-tabs)

Employees, Roles, Shifts, Time Off, Swaps, Conflicts, Wage Rates, Special Notes, Onboarding.

### 2.1 Employees

Table columns: Employee (name/avatar, active badge), Veteran badge, Custom-Availability indicator (orange check opens the modal), Sex (MALE/FEMALE), Role (primary), Also Qualifies (secondary `qualified_roles`), Availability (day pills), Email, Phone, Wage, Actions. The edit modal covers name, primary role, also-qualifies multi-select, sex, custom-availability, 7-day availability toggles (default 00:01–23:59 when ON), email/phone/wage, veteran toggle, max weekly hours.

*Data notes: the wage column maps to `employees.individual_wage`; `sex` (male/female) is read by the engine's attribute-mix constraint; `qualified_roles` is what the engine matches a shift's `role` against — a missing/miscased role here is the most common cause of an employee being skipped by the builder.*

### 2.2 Time Off

Filter by All/Pending/Approved/Denied. Each request shows employee, role, dates, reason, partial summary, Aegis recommendation badge, Approve/Deny (or status) + delete. Each **PENDING** request also carries a **"Re-run check"** button (alongside Approve/Deny). Partial requests show an orange summary; multi-day per-day variations expand. The "Log Request" modal supports single/multi day, full/partial, by-shift or custom-hours, per-day config, and a reason.

*The Aegis assessment block shows the coverage recommendation. Policy-rule violations (notice period, consecutive days) are computed and shown in the Aegis manager **email**, but are **not yet surfaced in this tab's UI** (TO-R4). **As of the sprint close (2026-06-09) the in-tab approve/deny path now matches the magic-link path:** both go through the shared `decideTimeOffRequest` helper (`src/lib/time-off/decide.ts`) via `POST /api/time-off-decision` — a guarded pending-only update that sets `decided_by` (from the server auth cookie), notifies the employee, and surfaces a manager-facing toast acknowledgment. The earlier gap (in-tab approvals didn't notify or set `decided_by`) is resolved.*

#### Re-run check (TO-RERUN-1)

A request's recommendation is computed at submit time and can go **stale** when other requests are approved afterward (TO-REC-STALE). The **"Re-run check"** button (`TimeOffTab.tsx` → `handleRecheck`, shown only on PENDING rows, disabled while any re-check is in flight; label flips to "Re-checking…") re-runs Aegis's coverage check against everything **currently** approved. It `POST`s `{ timeOffRequestId }` to `/api/time-off/recompute` (same cookie-session + `company_id` scope gate as `/api/time-off-decision`; read-only w.r.t. the decision — Aegis only rewrites `aegis_recommendation` / `aegis_reasoning`), which bridges to Aegis `/internal/recompute-to-recommendation`. The refreshed recommendation badge updates and a manager-facing notice/toast reports the result (e.g. *"Re-checked against everything currently approved — Aegis now recommends: Don't approve (2 coverage gaps if approved now)."*; or, with no shift schedule on file, *"…there's no shift schedule set up to measure coverage against, so the recommendation is unchanged."*). Unlike the single-use email button (see §8), the in-tab button can be re-run as many times as needed.

#### Resolution & click-guards (cross-channel)

`decideTimeOffRequest` (used by **both** the in-tab approve/deny and the magic-link approve/deny) is a **guarded, pending-only** update — if the row is no longer pending it makes no change and returns a definitive note that **names who decided it and when**: *"This request was already approved by Carolyn on Jun 17 — nothing changed."* Re-running an **already-decided** request (via the email `recheck_to` button) short-circuits with *"already decided — no re-check needed."* This is what keeps two managers (or a magic-link + in-tab race) from double-acting on the same request.

**Cross-repo "✓ Resolved" reply (Aegis side):** when a request is approved or denied through *any* channel, Aegis posts a "✓ Resolved" reply into each manager's original email thread so everyone who got the action card sees the outcome and the buttons no longer act. The decision itself, `decided_by`, the employee notification, and the activity-log entry are all written Homebase-side; the thread reply is Aegis's follow-up. (Documented here as the visible cross-repo behavior; the reply logic itself lives in the Aegis repo.)

### 2.3 Roles / Shifts / Conflicts / Wage Rates / Swaps

- **Roles** — create/edit/delete with display colors.
- **Shifts** — manages **both** engine inputs: `shift_types` (named shift windows + days) and `shift_requirements` (role + required count per shift). Any requirement write must set `accepted_roles` (NOT NULL; mirror `role` for single-role slots). The engine does not yet read `accepted_roles` (Role Groups unbuilt).
- **Conflicts** — log employee pairs with severity **`avoid` (soft) or `never` (hard)** — not soft/hard. `never` triggers the engine's cascade resolver.
- **Wage Rates** — role-based default hourly rates.
- **Swaps** — view/manage swap requests.

### 2.4 Special Notes (events)

Log holidays, events, closures. `event_type` includes holiday/special_event/party/fundraiser/closure/custom and the newer schedule/time_off/staffing/manager_pref. `closure` makes the engine skip that whole date; `staffing_notes` can mark a date priority; `shift_overrides` adjust shifts for an event.

### 2.5 Onboarding

Lists employees without a completed onboarding session; "Onboard Selected/All" triggers the Aegis SMS/email opt-in fan-out.

---

## 3. Rules Tab

Manages the `policies` table — the structured rules Engine V2 reads. Rules are grouped by `policy_type`; the engine-readable value lives in `policy_value_json` (the engine ignores the legacy `policy_value` scalar and ignores `policy_type` for parsing). Add/edit/delete with activity logging. This is where Watermark's `week_start_day = 'monday'` and any attribute/coverage minimums are configured — Watermark's gender rule is now the facility-wide `sex_coverage` (`scope=concurrent_coverage`, validate-and-flag), having replaced the old per-shift `attribute_mix` swap. See the Aegis reference §2.4 for the full constraint vocabulary and accepted `policy_key` aliases.

*Rules-tab UI build-out and the Watermark policy migration remain open roadmap items.*

---

## 4. Schedule Page

Two modes: viewing Engine-V2-built schedules and manual building.

### 4.1 Viewer

Shows current/next week. Each day lists filled `assignments` and any `gaps` (each gap carries `per_employee_dispositions` explaining why each qualified employee wasn't placed). Status badges: draft / published (distribution is tracked by `distributed_at`, not a status value). Day closure: a manager can close/reopen a day (confirmation modal) → triggers per-employee Aegis closure notifications.

**Coverage flags (`CoverageFlags`, `src/components/schedule/CoverageFlags.tsx`).** Renders the engine's `unsatisfied_sex_coverage` flags from `schedule.data.flagged_issues` as a "Coverage to review" list of manager action items — each showing the date, time window, which sex is missing, and who was on duty. Unlike a gap (an unfilled slot), a coverage flag is a *fully-staffed* schedule that still leaves a window with no guard of a required sex on the floor, so there is no single slot to "fill" — it surfaces as a review item, the safety mechanism for the flag-don't-force `sex_coverage` model. The component **only** renders `unsatisfied_sex_coverage` (it filters, so legacy `unsatisfied_attribute_mix` flags don't render — harmless, no crash). It is mounted in **three** views in `schedule/page.tsx`: the **HistoryReportDetail** (past-schedule report), the **current-week view**, and the **UpcomingCard preview** (the next-week Preview & Edit). The same coalesced flag also renders in the Aegis manager schedule-preview email.

### 4.2 Manual builder

Managers can assign employees to slots by hand — the workaround while engine gaps (e.g. ENGINE-1's structural Junior-Lifeguard miss) are open.

> **SCHED-EDIT-1 — RESOLVED (2026-06-09, Homebase `f28cb30`, live-verified).** Previously, moving an employee between shifts updated the displayed card but did not persist the corrected `shift_name`/`start_time`/`end_time` into `schedules.data.assignments`, so `distribute_schedule` read stale hours. The fix introduces a shared pure resolver (`src/lib/schedule/resolveAssignment.ts` + `hours.ts`) called at both the move handler (live UI correctness) and the `ScheduleReviewPanel.save()` persist chokepoint: a move now recomputes the full assignment from the target slot (sibling-copy within the same shift_name+date; fall back to **`shift_types`** for empty targets — confirmed to match `buildCanvas`) and recomputes hours. A manual move now round-trips the corrected hours to `schedules.data.assignments`. (Live `distribute` against real data remains gated by distribution rules + DELIV-1, but the data axis is correct.)

### 4.3 Download & delete

Excel (`/api/schedule/download/excel`) and PDF/print (`/api/schedule/download/pdf`). Both walk the same shared `buildScheduleGrid`, so the two outputs stay in lockstep. Delete is `quria`/`owner` only (permanent).

> **`xlsx → exceljs` swap — DONE 2026-06-09.** The previous SheetJS community build silently dropped cell styles (only the text reached the file); the renderer is now `exceljs`-based and styling (dark header, red `UNFILLED` gap cells, grey merged `CLOSED` column, frozen panes) reaches the produced `.xlsx`. The earlier Tier-2 "nice-to-have" item is closed; the work is in production via PR-merge (Homebase `main` is protected — see Dev Guide §4). **Live-data verification gated by `DOWNLOAD-500`** (Excel AND PDF currently 500 on real Watermark data — the throw is in the *shared* `buildScheduleGrid`, prime suspect a null/empty `employee_name` likely produced by a SCHED-EDIT-1-era manual edit; PRE-EXISTING, separate bug — see `DEV_ROADMAP.md` Phase 1).
>
> **Open follow-up (this doc; logged 2026-06-10):** **download FORMAT rework + template-builder polish (single effort)** — the produced grid should match the schedule builder's visual layout (headers, role grouping, color treatment) and the template editor should be polished alongside (the two are coupled — same column/row model). This is the layout/UX pass, distinct from the renderer swap.

---

## 5. Activity, Access, Billing

- **Activity** — full audit trail with actor/action/date filters and natural-language before/after diffs (employee edits, wage/policy changes, TO events, availability changes, schedule built/distributed, opt-in events).
- **Access** — managers view users (read-only) and manage Aegis access for employees; owners can revoke manager access; managers cannot add/remove users or change roles.
  - **Create-user authz (SEC-1, live 2026-06-10).** The `/api/create-user` route is now gated server-side: only `owner` or `quria` may create users (managers get 403); `owner` is **pinned to their own `company_id`** (a body-supplied `company_id` is ignored — no cross-tenant create); `quria` may target any company; the new user's `role` is **capped at the creator's privilege** (`quria` > `owner` > `manager`). Sole caller is the signed-in Access UI, so the sign-in gate breaks no automated path.
  - **Also live (2026-06-10):** four previously-unguarded `/api/*` routes now carry the standard cookie + `company_id` guard — `soteria-validate-assignment`, `soteria-validate-schedule`, `payroll/test-payroll-provider`, `payroll/test-timeclock`. Per-endpoint table in `SECURITY_AUDIT_API.md` (Homebase branch `security/api-auth-audit`, merged via PR).
  - **KNOWN BUG — DELETE-USER (DIAGNOSED 2026-06-10, NOT YET FIXED):** revoking/deleting a **pre-existing** user from the Access page silently fails. `handleRevoke` uses the anon/browser client, **swallows the returned error**, and deletes only `public.users`. *New* users delete fine (no linked rows); *old* users are blocked by FK constraints referencing `users.id` — notably `schedules.generated_by` (NOT NULL), `time_off_requests.decided_by`, and `activity_log` — so with the default `ON DELETE NO ACTION/RESTRICT` the delete fails and the UI appears to do nothing. (Even a successful delete leaves the `auth.users` row — no `auth.admin.deleteUser` call — so the email can't be re-added.) **Needs a soft-delete-vs-reassign decision** (the NOT-NULL `schedules.generated_by` can't be `SET NULL`) + a server route (service-role) that surfaces the error and handles the linked records deliberately, plus `auth.admin.deleteUser`. Full diagnosis in `DEV_ROADMAP.md` Phase 1. Caveat (logged in `SCHEMA_DRIFT_LOG.md` 2026-06-10): the exact `ON DELETE` clauses were inferred from column nullability + Postgres defaults — confirm against `information_schema` / `pg_constraint` before building.
- **Billing** — Stripe; behavior keyed on `companies.billing_model`. Watermark is `one_time` (price `211700` cents = $2,117.00, status `paid` → "Payment Complete", no renewal/cancel). Subscription tenants get start/manage/cancel. Webhook at `/api/stripe/webhook` (branches on session mode); amounts in cents; test-mode customers/prices do not exist in live mode.

---

## 6. Soteria AI Panel

Floating assistant on every page. Reads employees/availability/TO/shifts/policies; executes writes (employee CRUD, roster import, availability, custom availability, time off, shifts, policies, conflicts, schedule-build trigger) — each behind a confirm card. **Emits exactly one `<action>` per response** (multiples break the parser; truncation from low max_tokens silently breaks it — keep 8192). Supports PDF/Excel/Word/CSV uploads; ReactMarkdown + remark-gfm. See the Supplemental reference §4 for action payloads (note `add_conflict` uses `avoid`/`never`, and `add_shift` must set `accepted_roles`).

---

## 7. Key technical gotchas (Homebase)

- **RLS:** a missing `public.users` row, or `users.id` not exactly matching `auth.users.id`, returns empty everywhere → infinite loading. Diagnostic: join `auth.users`↔`public.users` on email and compare ids.
- **Dates:** never `new Date('YYYY-MM-DD')` for display (UTC-midnight shifts the date back a day in US tz) — use `split('-')` + `new Date(y, m-1, d)`.
- **Env:** after changing Vercel env vars, redeploy manually. `AEGIS_URL` must be the Railway production URL; outbound Homebase→Aegis links must point at `homebase-nine-phi.vercel.app`.
- **Schema / types:** Homebase's TypeScript types live in **`src/lib/types.ts`**. There is **no `src/db/types.ts` in this repo** — that path is the *Aegis* engine's generated types file (and it is itself incomplete: it omits `employees.sex` and `shift_requirements.accepted_roles`). Don't trust any types file as the schema of record; verify column names against `information_schema` before writes. `src/lib/types.ts` also holds the consumer copy of `FlaggedIssue` (the discriminated union mirrored from Aegis — keep the two in lockstep) and `ScheduleData`.

---

## 8. Aegis magic-link landing pages

When a manager clicks an **Approve / Deny / Re-run check** button (or any action button) in an Aegis email, the link lands on Homebase's `/api/aegis-action` route, which serves a small HTML result page. The whole experience is built from a **single** helper, `renderActionResultPage({ title, message, tone })` in `src/app/api/aegis-action/route.ts`, so every state shares one look.

**Branding (BRANDING).** The pages are the **Quria dark** look: `#0d0d0d` background, a card with a black header bar that carries a same-origin `/aegis-icon.jpg` logo + "Aegis" wordmark and an orange (`#f97316`) underline. A status dot + heading take the tone color — `success` = green (`#4ade80`), `error`/denied = red (`#f87171`), `info` = orange (`#f97316`). The flow:

- **GET (confirmation page, `info`/orange)** — describes the action ("Approve X's time-off request for …?", "Re-run Aegis's coverage check on …") with a single **Confirm** button that POSTs the token.
- **POST success (`success`/green)** — "All set" + the handler's human message.
- **Error pages (`error`/red)** — `invalid`, `expired`, `consumed`, `failed`. The **"already used"** (`consumed`) copy was softened to reassure rather than alarm: *"This link has already been used — your last action went through, so nothing was missed. Check your inbox or Homebase to confirm where it stands."*

**Re-run check by email (`recheck_to`).** The email action card's re-check button dispatches `recheck_to` (`src/lib/aegis-actions/dispatcher.ts` → `handleRecheckTimeOff`), which calls Aegis `/internal/recheck-to-reply`. That endpoint recomputes the recommendation **and replies in the original email thread** with a refreshed action card. Because the recompute + reply run in the **background**, the landing page returns instantly: *"On it — I'm re-checking this against everything currently approved and will reply in that request's email thread in a moment. Check your inbox."* (If the request was already decided, it short-circuits with the "already decided — no re-check needed" note instead.) Unlike the in-tab button, the **email** re-check token is **single-use** — one click per emailed card.

**Bridge endpoints.** The `AegisInternalEndpoint` union (`src/lib/aegis-internal.ts`) gained two members for these flows: `/internal/recompute-to-recommendation` (the in-tab "Re-run check", §2.2) and `/internal/recheck-to-reply` (the email card's re-check). Both ride the same `postToAegisInternal` bridge (`AEGIS_URL` + `AEGIS_INTERNAL_SECRET`) as the existing `/internal/notify-to-decision`, `/internal/distribute-schedule`, and the two availability-decision endpoints.
