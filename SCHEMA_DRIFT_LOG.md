# Schema Drift Log

Running log of discoveries where the actual production schema differs from what's in `/mnt/project/*.docx`. Append-only — when these get resolved into refreshed reference docs (post-Aegis-launch), check items off but leave the entries for history.

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

## How to use this log

When the post-launch doc-refresh sprint runs:
1. Read this log top-to-bottom
2. For each finding, update the relevant section of `02_Database_Schema.docx` (or other doc)
3. Mark the entry resolved with a date stamp: `RESOLVED YYYY-MM-DD — updated 02_Database_Schema.docx`
4. Do not delete entries — historical record of how the schema evolved

## When to append

Any time a future Claude Code session or live debugging surfaces a difference between the docs and the database. Two-minute task. Format:
