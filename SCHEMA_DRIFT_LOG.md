# Schema Drift Log

Running log of discoveries where the actual production schema differs from what's in `/mnt/project/*.docx`. Append-only — when these get resolved into refreshed reference docs, check items off but leave the entries for history.

---

## June 4, 2026 — discovered during TO-R sandbox session

### `public.policies`
- `category` column does NOT exist — actual column is `policy_type` (enum)
- `value` column renamed to `policy_value`
- Undocumented column: `version` (int, default 1)
- Undocumented column: `policy_value_json` (jsonb, nullable)
- `policy_type` enum values currently in use: `'coverage'`, `'custom'`, `'time_off'`, `'hours'`, `'fairness'`, `'eligibility'`, `'overtime'`
- Activity log convention for policy changes: action is `'policy_added'` (not `'policy_created'` as initial Homebase code attempted)

### `public.shift_requirements`
- Undocumented column: `accepted_roles` (text[], NOT NULL constraint) — tied to planned Role Groups feature, column added ahead of feature work
- Undocumented column: `shift_type_id` (uuid, nullable) — almost certainly FK to `shift_types.id`
- For single-role slots, `accepted_roles` mirrors `role`: `ARRAY['Lifeguard']` when `role = 'Lifeguard'`

### `public.users`
- `id` has FK constraint to `auth.users.id` — must create the auth user first via Supabase Dashboard before inserting into `public.users`. Reference docs imply this but don't make it explicit.

---

## June 4, 2026 (session 2) — additional discoveries during BUG-1 hotfix and sandbox seeding

### `public.time_off_requests`
- NO `created_at` column exists. The timestamp columns are `requested_at` (NOT NULL, when employee submitted) and `decided_at` (when manager approved/denied). Any code that previously assumed a generic `created_at` column will fail with `42703 column does not exist`.
- Implication: ORDER BY clauses, audit queries, and any reporting view that joins on `created_at` need to use `requested_at` instead.

### `public.shift_requirements` (additional findings beyond first June 4 entry)
- `accepted_roles` has a **NOT NULL** constraint. Every INSERT into this table must populate it. For single-role slots, mirror the role: `accepted_roles = ARRAY[role]`. For multi-role flex slots (future Role Groups feature), it's the set of acceptable roles. **Any code path that creates shift requirements without setting this column will fail.** Audit Soteria's `add_shift` action and any setup wizard or seed script.
- `shift_type_id` (uuid, nullable). Purpose unverified. Likely FK to `shift_types.id`. Unknown whether the scheduler currently joins on this column or whether code paths populate it. Worth a code audit before assuming nullable means safely ignorable.

---
## June 4, 2026 (session 3) — email-launch column verification

### public.company_channels
- Column is `channel_value` (text, NOT NULL), NOT `channel_address` as documented
  in 02_Database_Schema.docx §4.4. Queries using channel_address fail 42703.
  TENANT-1 From-address lookup must select channel_value. No channel_address exists.

### public.aegis_memory
- Undocumented column `memory_type` (text, NOT NULL) — §4.2 omits it. Every INSERT
  must set memory_type or hit a NOT NULL violation. Audit pending-TO and onboarding
  writes before modifying (BUG-5).

### public.time_off_requests
- Confirmed: requested_at NOT NULL; decided_at/decided_by nullable; no created_at
  column. start_date/end_date are `date` (docs say text) — serialize to YYYY-MM-DD.

### public.shift_requirements
- Confirmed: accepted_roles ARRAY NOT NULL, shift_type_id uuid nullable.
  start_time/end_time are `time` (docs say text HH:MM:SS) — serialize to HH:MM:SS.

---

## June 8, 2026 — v3.0 doc-refresh: resolutions + new findings

### Resolutions (folded into the v3.0 reference set on June 8, 2026)
All of the following are now reflected in the refreshed docs. Entries left in place per the append-only rule.

- `policies` columns (`policy_type`, `policy_value`, `policy_value_json`, `version`) — RESOLVED 2026-06-08 — updated 02_Database_Schema §3.5 + 04_Aegis_Reference §2.4 (constraint vocabulary). Note: engine parser reads ONLY `policy_key` + `policy_value_json`; it ignores `policy_type` and `policy_value`.
- `shift_requirements.accepted_roles` (NOT NULL) + `shift_type_id` (nullable) — RESOLVED 2026-06-08 — updated 02 §2.2 + 06 §1. Confirmed Engine V2 does NOT read `accepted_roles` (Role Groups unbuilt); eligibility matches on `role` via `qualified_roles`.
- `time_off_requests` no `created_at`; `requested_at`/`decided_at`; `start_date`/`end_date` are `date` — RESOLVED 2026-06-08 — updated 02 §1.6.
- `company_channels.channel_value` (not `channel_address`) — RESOLVED 2026-06-08 — updated 02 §4.4.
- `aegis_memory.memory_type` NOT NULL (`'pattern'|'preference'|'override'|'observation'`) — RESOLVED 2026-06-08 — updated 02 §4.2.
- `employee_conflicts.severity` is `'avoid'|'never'` (not `soft`/`hard`) — RESOLVED 2026-06-08 — updated 02 §3.3 + 03 §2.3 + 06 §4 (Soteria `add_conflict`).
- `users.id` FK→`auth.users.id` (create auth user first) — RESOLVED 2026-06-08 — updated 02 §1.2.

### New findings (this audit, NOT yet otherwise resolved)

- **`src/db/types.ts` is incomplete relative to the live DB.** The generated types file OMITS `employees.sex` (Migration 011; read by the engine `attribute_mix` constraint) and `shift_requirements.accepted_roles` (NOT NULL). The types file under-reports real NOT NULL columns — do NOT treat it as the schema of record. Always verify writes against `information_schema.columns`. (Captured in 02 §intro + §7 and 05 §2/§5.)
- **`employees` column drift:** the wage column is `individual_wage` (not `wage`); `aegis_access` (`'manager'|'employee'|'blocked'|null`) exists — the employee's permission level when *messaging* Aegis, distinct from being a notification-receiving manager. (Captured in 02 §1.3.)
- **`schedules.status` has only `'draft'|'published'`** (no `'distributed'` value as old docs implied); distribution is tracked by the `distributed_at` timestamp. `generated_at`/`generated_by` (not `created_at`/`built_by`); `data` jsonb holds `{assignments, gaps, flagged_issues?}` (canonical key `assignments`, never `shifts`); also `staffing_report`, `wages_file_url`, `approved_at`. (Captured in 02 §2.3.)
- **`events` table expanded** beyond old docs: `event_type` enum now includes `schedule`, `time_off`, `staffing`, `manager_pref` alongside the original set; new columns `end_date`, `description`, `staffing_notes`, `shift_overrides`, `created_by`, `updated_at`. `closure` drops the date from the engine canvas. (Captured in 02 §2.4.)
- **Two migration directories both numbered `015`:** `migrations/015_aegis_action_tokens.sql` (root) and `supabase/migrations/015_engine_foundation.sql`. Naming collision; no functional conflict. (Captured in 02 §6 + 06 §2.)

### Still OPEN (needs a future audit)

- **`policy_type` enum conflict unresolved.** The June 4 session-1 entry observed live values (`coverage`/`custom`/`time_off`/`hours`/`fairness`/`eligibility`/`overtime`); `src/db/types.ts` declares a different union (`time_off`/`scheduling`/`swaps`/`coverage`/`emergency`/`general`). The two disagree and the live CHECK/enum has not been definitively re-read. Engine ignores `policy_type` so scheduling is unaffected, but read `information_schema` before relying on it elsewhere.
- **Carried-forward tables not re-verified June 8:** `companies`, `users`, `roles`, `wage_rates`, `swaps`, `activity_log`, `soteria_memory`, `aegis_action_tokens`. Tagged `[carried-forward]` in 02. Confirm column lists in a future audit.

---

## June 9, 2026 — cross-repo type drift audit (PART B) + type reconciles

Audit of shared shapes defined in BOTH repos (Aegis `src/workflows/schedule-build.ts` producer vs Homebase `src/lib/types.ts` consumer). Note: this is *code type* drift, not DB-vs-docs drift, but logged here as the running drift record. No live `information_schema` read this session — sandbox has no network egress to Supabase (verified: `fetch failed`).

### Reconciled NOW (Homebase, tsc-clean)
- **`FlaggedIssue`** — Homebase had `{type:string, severity, message, metadata?}`; Aegis emits a discriminated union (`unsatisfied_attribute_mix` | `unsatisfied_sex_coverage`) with `date` + `description` and NO `severity`/`message`. The coverage variant has no `shift_name` and carries `time_window`/`missing_sex`/`on_duty` in metadata. Homebase's type **replaced with a mirror of Aegis's union** (safe — nothing consumed the old shape). Keep the two in lockstep. **Doc-folded RESOLVED 2026-06-09 — 02_Database_Schema §5 now documents the discriminated union (both variants) and 04_Aegis_Reference §2.1/§2.2 note the union + the both-variant email renderer.** (The separate "two FlaggedIssue formats coexist in `schedules.data`" entry below remains a LIVE caveat — not resolved.)
- **`ScheduleData.summary`** — was required `string` in Homebase, but the Aegis engine writes `{assignments, gaps, flagged_issues?}` and never sets `summary` (only Homebase's Soteria-review save path does). Made **optional**; the lone reader already null-guards.
- **`ScheduleGap`** — Homebase modelled only 6 core fields; the engine also writes `description`, `start_time`, `end_time` (and `per_employee_dispositions`). Added `description?`/`start_time?`/`end_time?` (optional) to Homebase. `per_employee_dispositions` deliberately NOT ported (needs the `EmployeeDisposition` type from Aegis — do when a disposition UI is built).

### Found, NOT yet reconciled (present for go / defer)
- **`src/db/types.ts` STILL omits `employees.sex` (NOT NULL CHECK 'male'|'female') and `shift_requirements.accepted_roles` (NOT NULL text[]).** Confirmed this session. The targeted 2-column add to the `Row` types is correct but **ripples into ~15 `smoke.ts` engine-test fixtures** (object literals would need the new required fields) → tsc fails. Left as-is to keep the repo green; the add + fixture update is presented for Alexander's go (don't sweep db/types blind). Engine currently reads `employees.sex` via a `readAttr` cast that works around the missing type.
- **`StaffingReport` has no shared type.** Aegis `buildStaffingReport` returns an inline object typed `Record<string, unknown>`; Homebase defines the `StaffingReport` interface and consumes specific fields. Shapes AGREE on the consumed fields (coverage_rate, top_contributors, overtime_risk, gap_summary, special_notes_applied, aegis_notes), so no active bug — but the producer additionally emits `closed_dates` + `shift_override_mismatches` (not in Homebase's type), and Homebase declares `bottom_contributors?` (not produced by Aegis). Recommend a shared `StaffingReport` contract. Medium effort — deferred, present for go.
- **`ScheduleAssignment`** — Homebase has optional `employee_photo?`; Aegis omits it. Benign (optional; engine never produces it, Homebase enriches on its side). No action.
- **Homebase has NO `src/db/types.ts`** — all types live in `src/lib/types.ts`. The Homebase `CLAUDE.md` previously cited the nonexistent path; corrected this session. Engine-only types (`CanvasSlot`, `WeekState`, `EmployeeDisposition`, `DispositionReasonCode`) are NOT duplicated in Homebase — bounds the drift surface.

### Stale reference-doc sections (for the next doc-refresh — STOP-and-present, not swept)
- ~~`gender_requirement` documented DORMANT (doc 04 §2.4, doc 06 §9) but is LIVE and being replaced by the `sex_coverage` concurrent_coverage model. Update on next doc pass.~~ **RESOLVED 2026-06-09 — updated 04_Aegis_Reference §2.4 (constraint vocabulary now lists `concurrent_coverage`/`sex_coverage` validate-and-flag; gender rule documented LIVE, not dormant) + 06_Supplemental_Reference §5 (added `evaluateSexCoverage` internals) + §9 (per-shift swap now inert/decision-pending) + 02_Database_Schema §1.3 (sex column read by the live concurrent_coverage rule).**
- The Soteria system prompt (`homebase/src/app/api/soteria/route.ts` ~§attribute_mix) documents only the per-shift `attribute_mix` model (scope all_shifts/shift_type/specific_shift); add the `concurrent_coverage` scope once the policy flip lands. **PARTIALLY RESOLVED 2026-06-09 — the reference docs (03 §3, 06 §6) now note the Soteria prompt still carries only the per-shift scopes; the *code* change to the prompt itself remains open and is tracked as Phase 3 (Rules) work. This is a code edit, not a doc edit — left for that build.**

---

## How to use this log

When the post-launch doc-refresh sprint runs:
1. Read this log top-to-bottom
2. For each finding, update the relevant section of `02_Database_Schema.docx` (or other doc)
3. Mark the entry resolved with a date stamp: `RESOLVED YYYY-MM-DD — updated 02_Database_Schema.docx`
4. Do not delete entries — historical record of how the schema evolved

## When to append

Any time a future Claude Code session or live debugging surfaces a difference between the docs and the database. Two-minute task. Format:

## 2026-06-09 — two FlaggedIssue formats coexist in schedules.data
- NEW (post-ENGINE-2): { type:'unsatisfied_sex_coverage', date, metadata:{on_duty[], missing_sex, time_window}, description }
- LEGACY (pre-ENGINE-2 builds, e.g. week_start 2026-06-01): { type:'unsatisfied_attribute_mix', shift_name, metadata:{value, actual, required, attribute, per_employee_dispositions[]}, description }
- The discriminated-union type + Homebase CoverageFlags handle only 'unsatisfied_sex_coverage'; legacy entries silently don't render (harmless for past schedules, no crash — component filters rather than switches). Caution: any future exhaustive switch on FlaggedIssue.type must handle/ignore the legacy variant, or normalize old rows in a migration. Low priority.

## 2026-06-09 (session 5) — `shift_requirements.accepted_roles` now READ by the engine (Role Groups draft)
- Context for the June-4 finding above (`accepted_roles` text[], NOT NULL, mirrors `role` as `ARRAY['<role>']` for single-role slots): the engine previously ignored this column; the **Role Groups draft** (branch `role-groups-engine`) now reads it to drive eligibility (`qualifiesForSlot` = `qualified_roles ∩ accepted_roles ≠ ∅`) and the assigned-role preference (`resolveAssignedRole`). Canvas falls back to `[role]` when absent/empty, matching the documented single-role mirror — so behavior is unchanged for tenants without role groups.
- **`src/db/types.ts` caveat:** `accepted_roles` was added to the hand-written `shift_requirements.Row` as **OPTIONAL (`string[] | null`)**, even though the live column is NOT NULL. This was deliberate for the contract-first engine build — making it required immediately breaks ~15 `ShiftRequirement` fixtures in `src/lib/engine/__tests__/smoke.ts` (and a couple of scripts). **Action when Role Groups ships:** migrate those fixtures to set `accepted_roles` and flip the type to required `string[]` to match the DB. Until then the type understates the NOT NULL guarantee. Tracked in DEV_ROADMAP (Role Groups, session-5 log).

## 2026-06-09 (session 7) — no NEW production schema surprise this session
- **No new production schema drift was discovered this session.** The Phase-1 batch (security audit, schedule download, Role Groups draft) ran read-only against fixtures and against the engine on feature branches; no live `information_schema` read produced a new finding. Stating this explicitly so the next session doesn't have to re-derive it.
- **Branch-only state on `role-groups-engine` (unchanged since session 5; restated for clarity):** the engine on that branch reads `shift_requirements.accepted_roles` for eligibility (`qualified_roles ∩ accepted_roles ≠ ∅`) plus a `resolveAssignedRole` preference rule, and the canvas falls back to `[role]` when the column is absent/empty — matching the documented single-role mirror convention. `src/db/types.ts` on that branch still types `accepted_roles` as OPTIONAL while the live column is NOT NULL — **drift deliberately introduced on the branch**. Merge gates remain: (a) flip `accepted_roles` to required `string[]` in `db/types.ts` and migrate the ~15 engine fixtures, and (b) ratify the `resolveAssignedRole` preference rule (wage / coverage-counting implications) before it goes live.
- **On `main` the engine still matches on `slot.role` only** — unchanged. No production behavior change from the branch work.

## 2026-06-10 — `users.role` admin value is `'quria'`, NOT `'quria_admin'` (doc inaccuracy, not DB drift)
- **Finding (read-only code inspection):** the live platform-admin value of `users.role` is **`'quria'`**, not `'quria_admin'`. Evidence: the Aegis `src/db/types.ts` enum is `'quria' | 'owner' | 'manager'`; every `users.role` check in both repos compares against `'quria'` (e.g. Homebase `src/middleware.ts`, `getCompanyServer.ts`, `access/page.tsx`); and the production admin login works against those `'quria'` checks.
- **`'quria_admin'` is a SEPARATE label**, used only for `activity_log.actor` (Homebase `src/lib/activity.ts`, dashboard/activity UIs) and the Aegis `ContactRole` (inbound-sender classification). It is **never** a `users.role` value. Do not conflate the two.
- The SEC-1 `create-user` fix (Homebase branch `security/create-user-authz`) correctly gates on `'quria'`.
- **Reference docs to correct in the next refresh (NOT touched this pass — docs 01–06 are out of scope here):** `02_Database_Schema` §1.2 lists the `users.role` admin value as `'quria_admin'` → should be `'quria'`; `TEST_IDENTITIES.md` listed Alexander Darling as `'quria_admin'` → corrected to `'quria'` on 2026-06-10 (this session).
