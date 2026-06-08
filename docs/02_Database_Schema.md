# QURIA SOLUTIONS — Database Schema Reference

**Version 3.0 — June 8, 2026 — Supabase PostgreSQL**

*Reflects Schedule Engine V2, the Watermark production launch (June 5, 2026), and all SCHEMA_DRIFT_LOG findings through June 4, 2026.*

---

## Database Overview

All data is stored in Supabase (PostgreSQL). Row Level Security (RLS) is enabled on all tables, and company isolation is enforced via a `company_id` column on every tenant-scoped table. The Supabase service role key bypasses RLS and is used by both Homebase server-side routes and Aegis; the anon key (which respects RLS) is used by Homebase client-side code.

| Setting | Value |
|---|---|
| Supabase URL | lpxbpfipanmvwiapriwt.supabase.co |
| Auth system | Supabase Auth — email/password, Magic Link |
| RLS | Enabled on all tables — `company_id` isolation |
| Service role | Used by Homebase API routes and Aegis (bypasses RLS) |
| Anon key | Used by Homebase client-side (respects RLS) |

### Schema verification status

Tables marked **[verified]** were checked column-by-column against `src/db/types.ts` on June 8, 2026. Tables marked **[carried-forward]** are reproduced from prior reference docs and were **not** re-verified in this pass — verify against `information_schema.columns` before writing to them.

**Important — `src/db/types.ts` is itself incomplete relative to the live database.** The audit confirmed the generated types file omits at least two columns that exist (NOT NULL) in production: `employees.sex` and `shift_requirements.accepted_roles`. Treat `src/db/types.ts` as a convenience, not as the source of truth. Before any INSERT/UPDATE, run:

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = '...';
```

---

## 1. Core Tables

### 1.1 companies **[carried-forward]**

One row per client business. All tenant-scoped tables reference this via `company_id`.

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| name | text | company display name |
| timezone | text | IANA tz string (Watermark: `America/Detroit`) |
| billing_email | text | billing contact |
| stripe_customer_id | text | Stripe customer ID (live mode) |
| stripe_subscription_id | text | subscription model only |
| stripe_price_id | text | Stripe Price ID stored per company |
| subscription_status | text | active / inactive / paid / trialing / past_due |
| subscription_price | integer | amount in **cents** (211700 = $2,117.00) |
| subscription_period_end | timestamptz | renewal date (subscription model) |
| cancel_at_period_end | boolean | scheduled cancellation flag |
| subscription_notes | text | internal notes |
| billing_model | text | `subscription` / `one_time` (DEFAULT `subscription`, CHECK) |

### 1.2 users **[carried-forward]**

Homebase login accounts (managers/owners/quria_admin). **`id` is both the primary key and a foreign key to `auth.users.id`** — you cannot insert a `users` row without first creating the matching Supabase Auth user, and the relationship is 1:1 (one `users` row per auth user, therefore one company per auth login).

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK, **= auth.users.id** |
| company_id | uuid | FK → companies |
| email | text | login email |
| name | text | display name |
| role | text | quria_admin / owner / manager |
| avatar_url | text | optional |
| created_at | timestamptz | |

*Manager email notifications (time-off, availability) fan out by querying THIS table for `role IN ('manager','owner')` — not the `employees` table.*

### 1.3 employees **[verified]**

Every employee at a client company. Separate from `users` — employees may not have Homebase logins.

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| company_id | uuid | FK → companies |
| name | text | full name |
| primary_role | text | main role (Lifeguard, Headguard, Manager, etc.) |
| qualified_roles | text[] | all roles this employee can fill — engine matches `slot.role` against this |
| max_weekly_hours | number | scheduling cap (a value of 0/null will exclude the employee at the slot-level hours filter) |
| contact_phone | text \| null | E.164 |
| contact_email | text \| null | |
| active | boolean | soft-delete flag; engine drops `active = false` first |
| created_at | timestamptz | |
| individual_wage | number \| null | **column is `individual_wage`, not `wage`**; overrides role rate when set |
| is_veteran | boolean \| null | veteran-preference scheduling |
| aegis_access | 'manager' / 'employee' / 'blocked' \| null | the employee's permission level when *messaging* Aegis — NOT the same as being a notification-receiving manager |
| sex | 'male' / 'female' | **present in DB (Migration 011), read by the engine's `attribute_mix` constraint, but MISSING from `src/db/types.ts`** |

### 1.4 availability **[verified]**

Regular weekly availability. One row per available day-of-week window.

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| employee_id | uuid | FK → employees |
| company_id | uuid | |
| day_of_week | number | 0 = Sunday … 6 = Saturday |
| start_time | text | HH:MM |
| end_time | text | HH:MM |

*Default when a day is toggled ON in Homebase is 00:01–23:59 (full day). The engine requires an availability window that fully contains the shift window (`slot.start >= avail.start AND slot.end <= avail.end`).*

### 1.5 custom_availability **[verified]**

Temporary availability overrides — `date_limited` (specific period) or `rotating` (repeating weekly cycle). Overrides normal availability while active.

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| employee_id | uuid | |
| company_id | uuid | |
| type | 'date_limited' / 'rotating' | |
| end_date | text \| null | YYYY-MM-DD — when override expires |
| cycle_weeks | number \| null | rotating only |
| cycle_start_date | text \| null | rotating only |
| patterns | Json | pattern array (shape depends on type) |
| active | boolean | soft-delete flag |
| created_at | timestamptz | |

### 1.6 time_off_requests **[verified]**

Employee time-off requests. Full-day and partial-day with precise windows.

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| employee_id | uuid | |
| company_id | uuid | |
| start_date | date | serialize as YYYY-MM-DD |
| end_date | date | serialize as YYYY-MM-DD |
| reason | text \| null | |
| status | 'pending' / 'approved' / 'denied' | |
| requested_at | timestamptz | **NOT NULL — always set on insert; omitting it fails** |
| decided_at | timestamptz \| null | when manager approved/denied |
| decided_by | uuid \| null | manager user id |
| aegis_recommendation | 'approve' / 'deny' / 'neutral' \| null | |
| aegis_reasoning | text \| null | |
| time_off_type | 'full_day' / 'partial' \| null | |
| partial_days | PartialDayDetail[] \| null | jsonb |

**There is NO `created_at` column.** The timestamps are `requested_at` (submission) and `decided_at` (decision). Any code/query assuming `created_at` fails with `42703 column does not exist`.

---

## 2. Scheduling Tables

The schedule engine reads **two** distinct shift tables. `shift_types` enumerates the named shifts that run on each day (the outer loop of the canvas); `shift_requirements` defines, per shift, how many of which role are needed (the per-slot inner loop).

### 2.1 shift_types **[verified]**

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| company_id | uuid | |
| name | text | e.g. AM Weekend, PM, Flex |
| start_time | text | |
| end_time | text | |
| days_active | number[] | day_of_week values |
| active | boolean | soft-delete flag |
| created_at | timestamptz | |

### 2.2 shift_requirements **[verified]**

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| company_id | uuid | |
| shift_name | text | display name |
| role | text | required role for this slot |
| required_count | number | how many of this role |
| start_time | text | HH:MM:SS (`time`) |
| end_time | text | HH:MM:SS (`time`) |
| days_active | number[] | day_of_week values |
| shift_type_id | uuid \| null | links a requirement to its `shift_types` row |
| accepted_roles | text[] | **NOT NULL in DB; MISSING from `src/db/types.ts`.** Added ahead of the unbuilt Role Groups feature. Engine V2 does **not** read it yet — eligibility uses `role` only. Every INSERT must populate it (mirror `role`: `ARRAY[role]` for single-role slots) or the write fails. |

### 2.3 schedules **[verified]**

One row per generated schedule week.

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| company_id | uuid | |
| week_start | text | YYYY-MM-DD |
| week_end | text | YYYY-MM-DD |
| generated_at | timestamptz | |
| generated_by | 'aegis' / 'manager' | |
| status | 'draft' / 'published' | **only two values** — distribution is tracked by the `distributed_at` timestamp, not a status |
| data | Json | the `ScheduleData` object (see §5) — canonical key is **`assignments`**, not `shifts` |
| staffing_report | Json \| null | |
| wages_file_url | text \| null | |
| approved_at | timestamptz \| null | |
| distributed_at | timestamptz \| null | set when distribute fires |

### 2.4 events (Special Notes) **[verified]**

Special dates affecting scheduling.

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| company_id | uuid | |
| title | text | |
| date | text \| null | YYYY-MM-DD |
| end_date | text \| null | YYYY-MM-DD (multi-day events) |
| description | text \| null | |
| event_type | enum | holiday / special_event / party / fundraiser / closure / custom / schedule / time_off / staffing / manager_pref |
| staffing_notes | text \| null | free-text staffing guidance; also marks a date `is_priority` for slot ordering |
| shift_overrides | Json \| null | per-event shift adjustments applied before the build |
| created_by | 'manager' / 'aegis' / 'soteria' | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

*`event_type = 'closure'` drops the entire date from the canvas (no assignments, no gaps). Other event types do not block assignment.*

---

## 3. Workforce Tables

### 3.1 roles **[carried-forward]**

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| company_id | uuid | |
| name | text | role name |
| color | text | hex color for UI badges |
| created_at | timestamptz | |

### 3.2 wage_rates **[carried-forward]**

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| company_id | uuid | |
| role | text | role name |
| rate | numeric | hourly rate |
| created_at | timestamptz | |

### 3.3 employee_conflicts **[verified]**

Employee pairs that should not be scheduled together.

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| company_id | uuid | |
| employee_id_1 | uuid | |
| employee_id_2 | uuid | |
| reason | text \| null | |
| severity | 'avoid' / 'never' | **values are `avoid`/`never`, NOT `soft`/`hard`** |
| created_at | timestamptz | |

*`never` = hard banned pair: the engine refuses to co-schedule and invokes `resolveBannedPairConflict` (swap-first, cascade-fallback, ≤ 5 hops). `avoid` = soft tiebreaker key in candidate ranking.*

### 3.4 swaps **[carried-forward]**

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| company_id | uuid | |
| requester_id | uuid | employee requesting |
| target_id | uuid | employee asked |
| shift_date | text | YYYY-MM-DD |
| shift_name | text | |
| status | text | pending / accepted / denied / manager_approved |
| created_at | timestamptz | |

### 3.5 policies **[verified]**

Company rules. The schedule engine's constraint parser reads this table.

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| company_id | uuid | |
| policy_key | text | **column is `policy_key`, not `key`** — the parser keys on this |
| policy_value | text | legacy scalar value — **ignored by the engine parser** |
| policy_value_json | Json \| null | the structured value the engine reads; a NULL here causes the parser to drop the row |
| policy_type | enum | `time_off` / `scheduling` / `swaps` / `coverage` / `emergency` / `general` per `src/db/types.ts` — **but the engine parser ignores `policy_type` entirely** |
| description | text \| null | |
| version | number | |
| created_at | timestamptz | |

*Migration 015 added a UNIQUE constraint on `(company_id, policy_type, policy_key)`. The constraint parser (`src/lib/constraints/parser.ts`) reads only `policy_key` + `policy_value_json`; see the Aegis reference (§ constraint vocabulary) for the full key-to-engine mapping.*

> **Drift note:** the June 4 SCHEMA_DRIFT_LOG observed `policy_type` values in the live DB (`coverage`, `custom`, `time_off`, `hours`, `fairness`, `eligibility`, `overtime`) that differ from the `src/db/types.ts` union above. The two sources disagree; the live CHECK/enum has not been definitively re-read. Because the engine ignores `policy_type`, this does not affect scheduling — but verify against `information_schema` before relying on `policy_type` values for anything else.

---

## 4. System Tables

### 4.1 activity_log **[carried-forward]**

Audit trail for all system actions.

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| company_id | uuid | |
| actor | text | aegis / manager / soteria / system / quria_admin |
| action | text | e.g. time_off_created, schedule_built, availability_updated |
| entity_type | text | employee / schedule / time_off_request / availability / … |
| entity_id | uuid \| null | |
| summary | text | human-readable description |
| metadata | jsonb | structured before/after data |
| created_at | timestamptz | |

### 4.2 aegis_memory **[verified]**

Persistent store for Aegis — onboarding sessions, pending confirmations, operational context.

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| company_id | uuid | |
| memory_type | 'pattern' / 'preference' / 'override' / 'observation' | **NOT NULL — every insert must set it** (pending-TO, pending-availability, and onboarding writes use `observation`) |
| content | text | JSON string payload |
| source | text \| null | identifies the record, e.g. `onboarding:{employee_id}`, availability-confirm/approval source keys |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### 4.3 soteria_memory **[carried-forward]**

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| company_id | uuid | |
| memory_type | text | preference / decision / context / feedback (distinct from `aegis_memory`'s set) |
| content | text | |
| source | text | |
| created_at | timestamptz | |

### 4.4 company_channels **[verified]**

Maps inbound channels to companies; routes incoming SMS/email to the correct tenant, and supplies the per-tenant From/Reply address.

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| company_id | uuid | |
| channel_type | 'sms' / 'email' | |
| channel_value | text | **column is `channel_value`, NOT `channel_address`** |
| created_at | timestamptz | |

*Watermark: `sms` → +16167477953, `email` → aegis@aegis.quriasolutions.com.*

### 4.5 aegis_action_tokens **[carried-forward — not re-verified]**

Single-use, expiring tokens backing email-mode action buttons (e.g. the manager TO Approve/Deny magic-links). Created by `migrations/015_aegis_action_tokens.sql`. Column list not captured in the June 8 audit — verify before use.

---

## 5. Engine Data Shapes (contents of `schedules.data`)

Engine V2 writes a single `ScheduleData` object into `schedules.data`. These TypeScript interfaces are defined in `src/workflows/schedule-build.ts` and `src/lib/engine/`.

```ts
interface ScheduleData {
  assignments: ScheduleAssignment[];
  gaps: ScheduleGap[];
  flagged_issues?: FlaggedIssue[];
}

interface ScheduleAssignment {
  date: string;            // YYYY-MM-DD
  employee_id: string;
  employee_name: string;
  shift_name: string;
  role: string;
  start_time: string;
  end_time: string;
  hours: number;
}

interface ScheduleGap {
  date: string;
  shift_name: string;
  role: string;
  required_count: number;
  filled_count: number;
  reason: string;          // stable short bucket (binding-constraint category)
  description: string;     // manager-facing rich diagnostic
  per_employee_dispositions: EmployeeDisposition[];
  start_time?: string;
  end_time?: string;
}

interface FlaggedIssue {
  type: 'unsatisfied_attribute_mix';
  date: string;
  shift_name: string;
  description: string;
  metadata: Record<string, unknown>;
}

type DispositionReasonCode =
  | 'not_qualified' | 'on_time_off' | 'max_hours_reached'
  | 'in_conflict' | 'availability_mismatch'
  | 'doubles_blocked' | 'eligible_but_unchosen';

interface EmployeeDisposition {
  employee_id: string;
  name: string;
  reason: DispositionReasonCode;
}
```

*`per_employee_dispositions` on each gap names every qualified candidate and why they were not placed — the primary diagnostic for "why was X not scheduled?" questions.*

---

## 6. Migrations on disk

There are **two** migration directories, and both contain a file numbered `015` (a naming collision to be aware of):

**`migrations/` (repo root):**

| File | Purpose |
|---|---|
| 001_create_company_channels.sql | creates `company_channels` |
| 002_payroll_integrations.sql | creates `time_clock_integrations`, `payroll_integrations` |
| 003_time_off_aegis_fields.sql | adds `aegis_recommendation`, `aegis_reasoning` to `time_off_requests` |
| 015_aegis_action_tokens.sql | creates `aegis_action_tokens` (email action-button tokens) |

**`supabase/migrations/`:**

| File | Purpose |
|---|---|
| 015_engine_foundation.sql | (1) `ADD COLUMN IF NOT EXISTS policies.policy_value_json jsonb`; (2) delete a known duplicate gender policy + generic dedup of `(company_id, policy_type, policy_key)` keeping highest `version` (tiebreak `created_at DESC`); (3) `ADD CONSTRAINT policies_company_type_key_unique UNIQUE (company_id, policy_type, policy_key)`. Without this migration the constraint parser drops every policy row (`null_json`). |

---

## 7. SCHEMA_DRIFT_LOG resolution

This v3.0 folds in and resolves the following entries logged June 4, 2026:

- `policies`: `policy_type`/`policy_value`/`policy_value_json`/`version` columns (§3.5)
- `shift_requirements.accepted_roles` (NOT NULL) and `shift_type_id` (§2.2)
- `time_off_requests` has no `created_at`; uses `requested_at`/`decided_at` (§1.6)
- `company_channels.channel_value` (not `channel_address`) (§4.4)
- `aegis_memory.memory_type` NOT NULL (§4.2)
- `employee_conflicts.severity` is `avoid`/`never` (§3.3)

**New drift recorded in this pass:** `src/db/types.ts` is incomplete relative to the live DB — it omits `employees.sex` and `shift_requirements.accepted_roles`. The types file must not be treated as the schema of record.

*Outstanding for the next audit: confirm column lists for `companies`, `users`, `roles`, `wage_rates`, `swaps`, `activity_log`, `soteria_memory`, and `aegis_action_tokens` (all carried-forward above), and definitively re-read the live `policy_type` CHECK/enum.*
