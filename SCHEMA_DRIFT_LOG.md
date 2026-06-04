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

## How to use this log

When the post-launch doc-refresh sprint runs:
1. Read this log top-to-bottom
2. For each finding, update the relevant section of `02_Database_Schema.docx` (or other doc)
3. Mark the entry resolved with a date stamp: `RESOLVED YYYY-MM-DD — updated 02_Database_Schema.docx`
4. Do not delete entries — historical record of how the schema evolved

## When to append

Any time a future Claude Code session or live debugging surfaces a difference between the docs and the database. Two-minute task. Format:
