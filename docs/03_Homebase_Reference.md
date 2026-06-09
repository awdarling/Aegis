# HOMEBASE — Product Reference

**Features, Capabilities & Workflows**

**Version 3.0 — June 8, 2026**

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

Filter by All/Pending/Approved/Denied. Each request shows employee, role, dates, reason, partial summary, Aegis recommendation badge, Approve/Deny (or status) + delete. Partial requests show an orange summary; multi-day per-day variations expand. The "Log Request" modal supports single/multi day, full/partial, by-shift or custom-hours, per-day config, and a reason.

*The Aegis assessment block shows the coverage recommendation. Policy-rule violations (notice period, consecutive days) are computed and shown in the Aegis manager **email**, but are **not yet surfaced in this tab's UI** (TO-R4). **As of the sprint close (2026-06-09) the in-tab approve/deny path now matches the magic-link path:** both go through the shared `decideTimeOffRequest` helper (`src/lib/time-off/decide.ts`) via `POST /api/time-off-decision` — a guarded pending-only update that sets `decided_by` (from the server auth cookie), notifies the employee, and surfaces a manager-facing toast acknowledgment. The earlier gap (in-tab approvals didn't notify or set `decided_by`) is resolved.*

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

Excel (`/api/schedule/download/excel`) and PDF/print (`/api/schedule/download/pdf`). Delete is quria_admin/owner only (permanent).

---

## 5. Activity, Access, Billing

- **Activity** — full audit trail with actor/action/date filters and natural-language before/after diffs (employee edits, wage/policy changes, TO events, availability changes, schedule built/distributed, opt-in events).
- **Access** — managers view users (read-only) and manage Aegis access for employees; owners can revoke manager access; managers cannot add/remove users or change roles.
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
