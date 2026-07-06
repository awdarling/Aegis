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

## 2026-06-10 — `users.role` admin value is `'quria'`, NOT `'quria_admin'` (doc inaccuracy, not DB drift) — **RESOLVED 2026-06-10**
- **Finding (read-only code inspection):** the live platform-admin value of `users.role` is **`'quria'`**, not `'quria_admin'`. Evidence: the Aegis `src/db/types.ts` enum is `'quria' | 'owner' | 'manager'`; every `users.role` check in both repos compares against `'quria'` (e.g. Homebase `src/middleware.ts`, `getCompanyServer.ts`, `access/page.tsx`); and the production admin login works against those `'quria'` checks.
- **`'quria_admin'` is a SEPARATE label**, used only for `activity_log.actor` (Homebase `src/lib/activity.ts`, dashboard/activity UIs) and the Aegis `ContactRole` (inbound-sender classification). It is **never** a `users.role` value. Do not conflate the two.
- The SEC-1 `create-user` fix (Homebase branch `security/create-user-authz`) correctly gates on `'quria'`.
- **RESOLVED 2026-06-10** — updated `02_Database_Schema.md` §1.2 (role column documented as `'quria' | 'owner' | 'manager'`; added an explicit clarification block that `'quria_admin'` is an `activity_log.actor` / Aegis `ContactRole` label only, never a `users.role` value); doc version bumped to v3.1. `TEST_IDENTITIES.md` already corrected on 2026-06-10 (prior session).

## 2026-06-10 — FK `ON DELETE` clauses on `users.id` references were INFERRED, not read from the live DB
- Context: the `DELETE-USER` bug diagnosis (see `DEV_ROADMAP.md` Phase 1) concluded that old users can't be deleted because child records FK-reference `users.id` and block the delete under the default `ON DELETE NO ACTION/RESTRICT`.
- **Caveat for the next builder:** the columns referencing `users.id` were identified from the Homebase type model — `schedules.generated_by` (typed NOT NULL → the strongest structural blocker), `time_off_requests.decided_by` (nullable), and `activity_log` actor/user fields. The **exact `ON DELETE` clause on each FK was NOT read from the live database** (no Supabase egress from the agent sandbox) — it was inferred from column nullability + Postgres defaults.
- **Confirm before building the fix:** query `information_schema` / `pg_constraint` for the actual `ON DELETE` actions on every FK targeting `users.id` (and whether RLS on `public.users` also blocks the anon-client delete). The fix (soft-delete vs. reassign `schedules.generated_by`, `SET NULL` nullable refs, `auth.admin.deleteUser`) depends on the real clauses.

## 2026-06-10 — `policies.policy_value_json` is the ONLY shape the engine parser reads; existing TO rows use text `policy_value` via a separate loader
- **Finding (read against the live sandbox tenant, 2026-06-10):** sandbox has 2 pre-existing policy rows (`max_consecutive_days_off=7`, `min_notice_period_days=7`) that store the value as the TEXT `policy_value` column with `policy_value_json = null`. They work in production because they're consumed by a **separate loader**, `src/lib/time-off-policies.ts` (the TO workflow's own reader). The schedule-engine parser `parseConstraints` (`src/lib/constraints/parser.ts:197`) ignores `policy_value` entirely — it reads ONLY `policy_value_json`, and logs "policy_value is not consulted by the engine parser" when json is null.
- **Implication for the engine vocabulary:** the canonical shape for ANY scheduling-engine policy is `policy_value_json` (bare number, bare boolean, or an object — `parseIntegerInRange`/`parseNumberInRange` accept either a bare number or `{ value: N }`). A row written as `policy_value_json: null` with the value stuffed in the text `policy_value` column will be silently dropped by `parseConstraints` even if `policy_key` is recognized (e.g. `max_consecutive_days_worked`).
- **Risk for Phase 3 Rules-tab UI:** if a Soteria / Rules UI writes a SCHEDULING-engine policy in the same shape the existing TO rows use (text `policy_value` only, `policy_value_json = null`), the engine will silently not enforce it. The split between the two loaders is real and intentional but not obvious from the schema. Pick a canonical `policy_value_json` shape per policy_key family and document it before the Rules UI writes any scheduling row.
- **Verified end-to-end this session:** wrote a temporary `max_consecutive_days_worked` row with `policy_value_json: 5` (bare number); `loadBuildData` + `parseConstraints` correctly produced `settings.maxConsecutiveDaysWorked === 5` via the production code path; row deleted; sandbox restored byte-equivalent.

## 2026-06-10 — `schedule_templates.company_id` UNIQUE constraint dependency
- **Finding (static code inspection, NOT a live DB query):** Homebase `src/lib/hooks/useScheduleTemplate.ts:62-65` writes via `.upsert(payload, { onConflict: 'company_id' })`. That call relies on a UNIQUE (or PRIMARY-KEY-component) constraint on `schedule_templates.company_id` to route the upsert to the existing row instead of inserting a duplicate.
- **Risk if absent in prod:** upsert may fail (constraint not matching `onConflict`) OR silently insert a second row for the same company; either way, template edits would never appear to take effect — which is the on-site TEMPLATE-EDIT-1 symptom ("edits don't take effect / won't save").
- **Action before TEMPLATE-EDIT-1 fix lands:** query `information_schema.table_constraints` + `key_column_usage` for `schedule_templates` on prod (or query Supabase Dashboard) to confirm the `company_id` UNIQUE constraint exists. If missing, that's part of the TEMPLATE-EDIT-1 fix scope. Do NOT touch prod env / DDL from an agent — gated.
- **Related:** the strongest behavioral lead for TEMPLATE-EDIT-1 is the silently-swallowed save error at `useScheduleTemplate.ts:67` (`if (!error && data) { setTemplate(data) }` — error branch does NOTHING; panel closes regardless via `TemplateEditorPanel.tsx:188-190`). Tracked in `DEV_ROADMAP.md` (Session Log 2026-06-10 + Tier-3 `TEMPLATE-EDIT-1`).

## June 11, 2026 — SCHED-DELETE-1 diagnosis (read-only)

### public.schedules — no soft-delete column
- No `deleted_at` / `is_deleted` / `archived`. `status` is free text (not enum), default `'draft'`; live values draft/published, code also writes `'distributed'` (dispatcher.ts:154) and `'approved'`. Soft delete needs gated DDL (`ADD COLUMN deleted_at timestamptz`).

### FK references TO schedules.id — NONE (enforced)
- `pg_constraint` `contype='f'` targeting `schedules` = `[]`. Hard DELETE is referentially safe. `activity_log.entity_id` is a loose uuid (no FK). `aegis_action_tokens` references a schedule only inside `payload` jsonb (`payload->>'schedule_id'`, dispatcher.ts:138) — no column, no FK.
- Corrects the earlier inferred-FK note (clauses were inferred, not read).

### public.schedules RLS — DELETE not role-gated (SECURITY)
- Single permissive policy "Company schedules access", `cmd=ALL`, `USING ((company_id = get_my_company_id()) OR (get_my_role()='quria'))`, `with_check=null`.
- DELETE allowed for ANY authenticated same-company user; owner/quria limit is enforced ONLY by the hidden UI button (page.tsx:969). Fix: deny client DELETE via RLS + route all deletes through a service-role server route.

### public.users.role enum drift
- Live values: `quria | owner | manager`. `quria_admin` is an `activity_log` ACTOR label only, NOT a `users.role` value. `02_Database_Schema.docx` §1.2 ("quria_admin / owner / manager") is wrong; gate on `role==='quria'`. Live: 4 manager, 1 quria, 0 owner.

---

## June 11, 2026 — AEGIS-EMAIL-1 diagnostic

### `public.schedules.status` — `'distributed'` legal but never persisted
- CHECK constraint allows `('draft','published','distributed')`; Aegis `distributeScheduleCore` writes `'published'` after fan-out and overwrites the magic-link path's transient `'distributed'`. **0 rows ever hold `status='distributed'`** in production. The real "distributed" signal is `status='published' AND distributed_at IS NOT NULL`.
- Implication: any guard or report that filters on `status='distributed'` will silently match nothing. The `confirm_distribution` magic-link path's re-distribution guard was effectively defeated by this clobber (re-clicking the link would re-fan-out because the status check could never see `'distributed'`).
- Cross-ref: AEGIS-EMAIL-1 work list #2 (drop the magic-link `confirm_distribution` path; fix the re-distribution guard to key on `distributed_at`, not `status`).

### `public.aegis_action_tokens.issued_at` — DB-defaulted, never app-set
- Column is `timestamptz NOT NULL`; Aegis `generateActionToken` does NOT set it on insert (relies on the DB `DEFAULT now()`). In practice `issued_at` always equals row-insert time — fine, but worth knowing that any audit logic that needs "when did the email mint this token" should read `issued_at` rather than expect an explicitly-passed value. No bug; documenting for the next builder.

### 2026-06-17 — no schema changes this session (TO-RERUN-1 / branding / inbound fix)
- The voice+branding pass, INBOUND-SIG-1, and TO-RERUN-1 (re-check recommendations, in-thread reply, resolution notices, click-guards) added **no migrations and no new columns/tables/enums**. TO-RERUN-1 only re-writes existing `time_off_requests.aegis_recommendation` / `aegis_reasoning` and reads existing tables.
- `aegis_action_tokens` gained a new `action_type` VALUE `'recheck_to'` at the application level (the `ActionType` union in both repos). The DB column is free-text `text`, so no DDL was required — but note this enum-by-convention if a CHECK constraint is ever added to that column.
- Sandbox-only data note (not drift): `SANDBOX_RERUN_SEED.sql` raises the sandbox PM Lifeguard `required_count` 1→2 and deactivates stale `custom_availability` for the 3 test guards. Production untouched.

---

## 2026-06-30 — `company_monitoring_inboxes` table exists (item #16 first slice, undocumented in reference docs)

### `public.company_monitoring_inboxes` (NEW table — confirmed live)
- Columns (all `NOT NULL`): `id uuid`, `company_id uuid`, `email text`, `active boolean`, `created_at timestamptz`.
- Purpose: roadmap item #16 monitoring/observer inboxes. `src/messaging/email.ts` calls `resolveMonitoringEmails(companyId)` (`src/messaging/monitoring.ts`) and BCCs every outbound email for that company to the `active=true` rows (`buildBccList`). **Fail-safe:** lookup error / no rows → empty list → no BCC, send still goes out. So the feature is LIVE but inert for any company with no rows.
- Live data: **Watermark** (`a1b2c3d4-…`) has one active row. **2026-06-30 (corrected):** target is `monitor1@quriasolutions.com` — a FREE **Microsoft 365 shared mailbox** on our own domain (the domain runs on M365 via GoDaddy, NOT Google Workspace; the earlier "use a free Gmail / `quriamonitor1@gmail.com`" plan was abandoned and never created). ⚠️ The row read `monitorone@quriasolutions.com` (a non-existent mailbox → BCCs bounced) until this fix; apply `update public.company_monitoring_inboxes set email='monitor1@quriasolutions.com' where id='c110f0ee-f6e7-47ff-b8ea-666bf4f1c2a4'` if not yet run. Sandbox has none.
- Not represented in `src/db/types.ts` (consistent with the "types file is incomplete" rule). Reference docs (01–06) don't mention this table — fold in on the next doc rewrite (#14).

---

## 2026-07-01 — `swap_requests.decided_by` is a UUID (caused a silent orphan bug)

### `public.swap_requests.decided_by` — `uuid` (nullable)
- Discovered while testing the undirected-swap manager approval. `decided_by` is a **UUID** FK-style column, NOT free text. `initiated_by` (text) and `status` (text) are free text; `decided_by` and `decided_at (timestamptz)` are the decision-audit columns.
- **Bug it caused (now fixed):** `src/webhooks/decision.ts` wrote `decided_by: 'manager'` and `src/workflows/shift-swap.ts` (auto-approve path) wrote `decided_by: 'aegis'` — both strings. Postgres rejects a non-UUID string → the whole UPDATE/INSERT throws, and because the result wasn't error-checked it failed silently. Net effect: the schedule trade executed but the `swap_request` row was never closed (stuck at `pending_manager`, decided_at null). Fix: write `null` (branch `fix/swap-decided-by-uuid`, merged 2026-07-01, re-verified — status now flips to `approved`).
- Lesson: treat `*_by` columns as UUID unless proven text; never write role/name strings to them. If "which manager" matters for swaps later, resolve the approving manager's `users.id` (the swap decision magic-link is currently shared across managers, so we don't know which one clicked → null is correct for now).

---

## 2026-07-01 (session 2) — `public.schedules` can hold MULTIPLE `status='published'` rows per week (data-integrity bug)

### `public.schedules` — no single-published-per-week invariant
- Columns confirmed live: `id, company_id, week_start, week_end, generated_at, generated_by, status, data (jsonb), staffing_report (jsonb), wages_file_url, approved_at, distributed_at, deleted_at, published_at, archived_at, superseded_by`.
- **Discovered:** the sandbox tenant had **3 rows with `status='published'` for overlapping weeks** (ids `669dc428…`, `33813cdd…`, `aa000000…`), none with `superseded_by` or `archived_at` set. The publish/distribute code (`src/workflows/schedule-build.ts`, both the initial-distribute and republish paths) set `status='published'` on the new row but **never demoted the prior published row** — so `superseded_by`/`archived_at` existed in the schema but were unused, and duplicates accumulated.
- **Bug it caused:** an approved shift swap can fail to appear on the schedule the employee sees. The swap-writer (`src/webhooks/decision.ts` → `executeScheduleSwap`) resolves "the newest published schedule covering the date" and updates THAT row; a reader (`query_my_shifts`) can resolve a different published row. With one published row per week they always agree.
- **Fix (branch `fix/pre-demo-bugs`, 2026-07-01, IN REVIEW):** both publish paths now `update({status:'archived', archived_at, superseded_by:<newId>})` on any other `status='published'` non-deleted row for the same `company_id`+`week_start`+`week_end` BEFORE marking the new row published. `executeScheduleSwap`/`executeScheduleTrade` also now `console.warn` instead of silently `return`ing when the schedule can't be resolved or nothing matches.
- **Existing duplicate rows are NOT auto-fixed** by the code change (it only prevents new ones). Collapse the sandbox's existing duplicates during the #18 reset; for a live tenant, a one-time `update … set status='archived', superseded_by=<newest_id> where status='published' and id <> <newest_id>` per week.
- Not represented in `src/db/types.ts` (types file is incomplete — consistent).
