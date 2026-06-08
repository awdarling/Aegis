# QURIA SOLUTIONS — Supplemental Reference

**Gaps, Internals & Deep Detail — Read alongside Documents 1–5**

**Version 2.0 — June 8, 2026**

*Replaces the V1 supplemental. The former "Schedule Engine — Known Issues & Redesign Notes" section is obsolete: the engine was rebuilt as Engine V2 (2.0.0) in late May 2026. See §5 for V2 internals and §9 for current limitations.*

---

## 1. shift_types vs shift_requirements (engine coupling)

The engine reads two tables to enumerate work:

- **`shift_types`** — the named shifts that run on each day (AM Weekend, PM, Flex…), with `start/end_time`, `days_active`, `active`. Drives the **outer** loop of `buildCanvas`.
- **`shift_requirements`** — per shift, how many of which role are needed (`role`, `required_count`, `days_active`, `shift_type_id`, plus the NOT-NULL `accepted_roles` the engine doesn't yet read). Drives the **inner** loop: one `CanvasSlot` per required head.

A `CanvasSlot` therefore carries both `shift_type_id` and `shift_requirement_id`. Both tables must be populated for a build to produce slots. `accepted_roles` must be set on every `shift_requirements` INSERT (mirror `role` for single-role slots) — its NOT NULL constraint will reject writes otherwise (audit Soteria's `add_shift` and any seed script).

---

## 2. Database Migrations (both directories)

Migrations run manually in the Supabase SQL Editor. Use `ADD COLUMN IF NOT EXISTS`; verify columns via `information_schema` before writing. **Two directories exist, both with a `015` file** (naming collision):

**`migrations/` (root):** `001_create_company_channels`, `002_payroll_integrations`, `003_time_off_aegis_fields`, `015_aegis_action_tokens` (single-use expiring tokens behind email Approve/Deny links).

**`supabase/migrations/`:** `015_engine_foundation` — adds `policies.policy_value_json jsonb`, dedups `(company_id, policy_type, policy_key)` (keep highest `version`, tiebreak `created_at DESC`), deletes a known duplicate gender policy, then adds `UNIQUE (company_id, policy_type, policy_key)`. **Required for the constraint parser to function** — without `policy_value_json`, every policy row is dropped as `null_json`.

Historical migrations from earlier reference (009 billing columns, 010 events, 011 employee `sex`, 012 partial time off, 013 custom_availability, 014 billing_model & price_id) predate this set; the engine-era schema is best read from §1–5 of the Database Schema doc, not the migration history.

---

## 3. Intent Classification — full detail

`src/ai/claude.ts` holds `EMPLOYEE_INTENTS` and `MANAGER_INTENTS` and the classifier system prompt (intents + examples + extraction schemas). Returns `{ intent, confidence: high|medium|low, extracted }`.

- **Confidence:** high = act; medium = may ask one clarifying question; low = clarification request.
- **`veteran_only_dates` extraction** (`build_schedule`): `[{start_date:'YYYY-MM-DD', end_date:'YYYY-MM-DD'}]`. The classifier prompt **injects today's date** so relative ranges ("Memorial Day weekend", "this Friday") resolve correctly. Year-drift (resolving to the wrong year) is a recurring bug class — every classifier prompt must inject the current date, timezone-aware via `Intl.DateTimeFormat('en-CA', { timeZone: companyTimezone })`.

---

## 4. Soteria (Homebase internal assistant) — actions & system prompt

`/api/soteria` (chat) and `/api/soteria/execute` (write). Model claude-sonnet-4-6, max_tokens 8192. Emits **exactly one** `<action>` block per response (parser breaks on multiples; truncation from low max_tokens silently breaks parsing). `<memory>` blocks auto-save to `soteria_memory`. Server strips both before display; client has a fallback for truncated openers.

System prompt sections (in order): today's date → identity → company context (employee list, shift list) → capabilities → action-type list → one-action rule → memory instructions → availability-notes processing → partial-day time format rules → roster-upload instructions → schedule-build trigger.

**Action payloads (corrections vs old reference):**

- `add_conflict` — `{ employee_id_1, employee_id_2, reason?, severity?: 'avoid' | 'never' }` — **values are `avoid`/`never`, not `soft`/`hard`** (must match the `employee_conflicts` CHECK). Verify the Homebase Conflicts tab write path uses the same.
- `add_shift` — `{ shift_name, role, required_count, start_time, end_time, days_active }` — the executor **must also populate `accepted_roles`** (NOT NULL); mirror `role` for single-role slots.
- `update_policy` — `{ policy_type, policy_key, policy_value_json, description? }` — for engine-read policies the structured value goes in `policy_value_json` (the engine ignores `policy_value` and `policy_type`).
- Other actions unchanged: `add_employee`, `update_employee`, `delete_employee`, `import_employees`, `update_profile`, `delete_shift`, `delete_policy`, `trigger_schedule_build`, `batch_create_time_off`, `update_availability`, `set_custom_availability`.

Partial-day time rules (system-prompt-enforced): HH:MM only; every `partial_days` entry needs both `start_time` and `end_time`; "no work after X" → `X`–`23:59`; "no work before X" → `00:00`–`X`; "between X and Y" → `X`–`Y`.

---

## 5. Engine V2 — internals

Pipeline (see Aegis ref §2 for the file map): `buildCanvas → fill loop (buildEligibility + slot filter + rankCandidates) → resolveBannedPairConflict → enforceAttributeMixForShift → veteran swap → gap recount`. Deterministic; no LLM. `runScheduleBuild` returns the `ScheduleData` written to `schedules.data`.

**Ranking (`rankCandidates`)** sort order: primary-role match → fewer soft conflicts (`avoid` pairs already on the shift) → hours fairness (scaled by `hoursFairnessWeight`) → veteran preference (when active) → name (deterministic tiebreak).

**Cascade (`resolveBannedPairConflict`)**: when placing an employee would co-schedule a `never` pair, try a direct swap first; else cascade with hop-limited backtracking (`MAX_CASCADE_HOPS = 5`). The cascade must refuse any hop that would create a *second* banned pair (`legalToPlace`/`hasHardBannedPair`). The 5-hop boundary and hours-constrained cascade paths are acknowledged lower-priority gaps.

**Attribute mix (`enforceAttributeMixForShift`)**: post-fill swap pass enforcing per-attribute minimums (e.g. a gender minimum per shift) within `scope` (`all_shifts`/`shift_type`/`specific_shift`). Unsatisfiable → a `FlaggedIssue {type:'unsatisfied_attribute_mix'}` with a `buildAttributeShortageReason` description. Reads `employees.sex` (present in DB, absent from `src/db/types.ts`).

**Dispositions (`dispositions.ts`)**: shared classifier producing `DispositionReasonCode` (`not_qualified`, `on_time_off`, `max_hours_reached`, `in_conflict`, `availability_mismatch`, `doubles_blocked`, `eligible_but_unchosen`) for every gap's `per_employee_dispositions` — the canonical "why wasn't X scheduled?" answer.

**Week bounds (`getWeekBounds(offset, weekStartDay)`)**: `weekStartDay` from the `week_start_day` policy (default `sunday`; Watermark `monday`). Targets `this`/`next` week relative to today.

**Debug log lines (Railway):** `[schedule] using custom availability for {name}`, `[schedule] veteran-only restriction active for {date}`, `[schedule-build] applying veteran preference: {mode}`, `[schedule-build] veteran-only date ranges: [...]`. Absence of expected lines usually means intent extraction missed the parameter — check the classifier response.

---

## 6. Homebase — supplemental detail

**Auth/route protection:** Supabase Auth (email/password); `middleware.ts` gates all `/(app)/` routes on a valid session, redirecting to `/login`. `useCompany` (`src/lib/hooks/useCompany.ts`) provides `company`, `user`, `COMPANY_ID`, `loading`; `useQuria` provides `isQuria`. **RLS gotcha:** a missing `public.users` row (or `id` not matching `auth.users.id`) returns empty everywhere → infinite loading.

**Rules tab** (`policies` table): key-value rules grouped by `policy_type`; the structured engine value lives in `policy_value_json`. This is where Watermark's `week_start_day='monday'` and any `attribute_mix` minimums are set. (Rules tab UI work + Watermark policy migration are open roadmap items.)

**Onboarding tab:** lists employees without a completed onboarding session; "Onboard Selected/All" triggers the Aegis opt-in fan-out.

**`/api/notify-day-closure`:** per affected employee, POSTs to `AEGIS_URL/webhooks/sms` with the manager phone as `From` and a formatted closure body; Aegis classifies `notify_day_closure` and sends the actual notice.

**`/api/soteria/validate-schedule` / `validate-assignment`:** internal Claude-backed validators (with `withAnthropicRetry`) used when a manager reviews a schedule — separate from the chat route.

**CSS theme:** custom variables only (never hardcoded hex). Accent `#F97316`; `--bg-surface-1/2/3`, `--text-primary/secondary/muted/disabled`, `--border-default/subtle`, `--status-{ready|blocked|pending}-{bg|text|border}`, `--radius-{sm|md|xl}`, `--font-{body|display}`. Class patterns: `btn btn-primary/secondary/sm`, `badge badge-{ready|blocked|pending}`, `form-group/label/input/select`, `empty-state`.

---

## 7. Quria Solutions Website (Netlify)

Static site at quriasolutions.com (separate repo, drag-and-drop deploy of a `./deploy/` snapshot to Netlify; git auto-deploy deferred). Pages: `/`, `/aegis`, `/homebase`, `/services`, `/privacy`, `/terms`, `/sms-consent` (A2P compliance page, added May 2026 — verifiable by Twilio reviewers). **DNS must stay on Netlify with SendGrid MX + DKIM/SPF records intact** — moving DNS without migrating those breaks Aegis email.

---

## 8. Shapes & lifetimes

- **`InboundMessage`**: `{ body, sender, recipient, channel, raw_subject, thread_id, company_id }`.
- **`VerifiedContact`**: `{ role, employee_id|null, company_id, manager_id|null, channel, sender, recipient }` (also carries `name`, `user_id`, `matched_identifier` in some paths).
- **Engine output shapes** (`ScheduleData`/`ScheduleAssignment`/`ScheduleGap`/`FlaggedIssue`/`EmployeeDisposition`): see Database Schema doc §5.
- **Session expiry:** onboarding sessions 48h; pending TO/availability confirmations 1h (availability *manager-approval* pending: 24h).
- **Timezone:** `companies.timezone` (IANA; Watermark `America/Detroit`). Week bounds computed in local tz; availability/TO overlap uses plain `YYYY-MM-DD` string comparison (timezone-naive — only matters for shifts crossing midnight). **Never `new Date('YYYY-MM-DD')` for display** — use `split('-')` + `new Date(y, m-1, d)`.

---

## 9. Engine V2 — current limitations & banked items

The engine is deployed and dry-run-validated, **not bug-free**. Open items:

- **ENGINE-1 (live bug):** the builder silently skips an eligible employee at Watermark (Aaron Barrigan, Headguard, fully available). Engine-eligibility bug, not a UI↔Supabase sync issue (the engine reads Supabase directly via the service role). Leading suspects: `qualified_roles` missing/miscased "Headguard", or `max_weekly_hours` 0/null. Diagnose via the gap's `per_employee_dispositions`. *Not yet fixed.*
- **`conflict_resolution_preference`** is parsed into `EngineSettings` but not yet consulted anywhere.
- **`doubles_policy='emergency_only'`** currently behaves like `never` (the build path has no emergency context).
- **Cascade**: 5-hop limit and hours-constrained cascade paths are acknowledged gaps; the "refuse a hop that creates a second banned pair" check has a unit test banked.
- **Role Groups (unbuilt):** `shift_requirements.accepted_roles` exists (NOT NULL) but the engine matches on `role` only. Role Groups (a slot fillable by any of several roles, e.g. Flex = Headguard OR Lifeguard) is the structural fix for Watermark's Afternoon Headguard gaps. Build contract-first: engine eligibility (qualify if the employee fills ANY accepted role) + a preference rule for which role to assign, before any Homebase Shifts-tab UI.
- **max-consecutive-days-worked** constraint: flagged (Jack worked all 7 days in a dry-run, legal under current rules) but not built.
- **`gender_requirement`** policy row is dormant (`policy_value_json = null`).

*Manual workaround while gaps exist: Homebase manual schedule builder (availability/TO/custom-availability all visible in the Data tab).*

---

## 10. Known Homebase data-write bug

- **SCHED-EDIT-1 (live bug):** manual shift edits on the Homebase Schedule page change the *displayed* assignment card but do not persist the corrected `shift_name`/`start_time`/`end_time` into `schedules.data.assignments`. Result: `distribute_schedule` sends the stale (pre-move) shift details — e.g. an employee moved Monday-morning → Flex is emailed Flex's name with the Monday-morning hours. A UI-to-data write gap, not an engine bug. *Not yet fixed.*
