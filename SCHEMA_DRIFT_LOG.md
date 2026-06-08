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

## How to use this log

When the post-launch doc-refresh sprint runs:
1. Read this log top-to-bottom
2. For each finding, update the relevant section of `02_Database_Schema.docx` (or other doc)
3. Mark the entry resolved with a date stamp: `RESOLVED YYYY-MM-DD — updated 02_Database_Schema.docx`
4. Do not delete entries — historical record of how the schema evolved

## When to append

Any time a future Claude Code session or live debugging surfaces a difference between the docs and the database. Two-minute task. Format:
