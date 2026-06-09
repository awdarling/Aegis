# AEGIS — Product Reference

**Features, Capabilities & Workflows**

**Version 3.0 — June 8, 2026**

*Reflects Schedule Engine V2 (2.0.0), the inbound signature-verification security layer, and the live email workflows verified at the Watermark production launch (June 5, 2026).*

---

## Overview

Aegis is the AI assistant manager — a Node.js/Express/TypeScript application on Railway. It communicates with employees and managers over SMS (Twilio) and email (SendGrid), classifies inbound messages by intent, and performs autonomous workforce-management operations. The schedule-building core is **deterministic TypeScript (Engine V2)** — it does **not** call an LLM during a build.

| Aspect | Value |
|---|---|
| Repo | github.com/awdarling/Aegis (`~/Desktop/Aegis`) |
| Production URL | aegis-production-3220.up.railway.app |
| Stack | Node.js + Express + TypeScript, auto-deploy on push to `main` |
| AI (intent + response only) | Anthropic claude-sonnet-4-6, max_tokens 8192 |
| SMS | Twilio — +16167477953, Messaging Service MG••• — redacted (Messaging Service SID; see Railway env) |
| Email | SendGrid — inbound `aegis@aegis.quriasolutions.com` (Watermark), outbound from apex `aegis@quriasolutions.com` |
| Database | Supabase (service role key — bypasses RLS) |
| Retry | `withAnthropicRetry` — 3 attempts, 1s/2s on 529 overload |

---

## 1. Message Routing Architecture

All inbound messages (SMS and email) flow through one pipeline before reaching intent handlers.

### 1.1 Inbound channels

- **SMS:** `POST /webhooks/sms` — Twilio webhook, body parsed with `qs`.
- **Email:** `POST /webhooks/email` — SendGrid Inbound Parse (multipart form).
- Both normalize to an `InboundMessage`: `{ body, sender, recipient, channel: 'sms'|'email', raw_subject, thread_id, company_id }`.

### 1.2 Inbound security — SendGrid signature verification ("wax seal") — NEW

Shipped and verified live June 5, 2026. Inbound email is authenticated before processing.

- `src/middleware/capture-raw-body.ts` buffers the exact raw request bytes (stream-replay so `multer` can still parse the multipart form afterward). Runs on **every** inbound email.
- `src/middleware/verify-signature.ts` order of precedence:
  1. If `SKIP_SENDGRID_VERIFICATION=true` → bypass (local testing only; **production is `false`**).
  2. Else if `SENDGRID_WEBHOOK_PUBLIC_KEY` is set → ECDSA-verify via `@sendgrid/eventwebhook` (`EventWebhook.convertPublicKeyToECDSA` + `verifySignature(key, rawBody, sig, ts)`) against headers `x-twilio-email-event-webhook-signature` and `x-twilio-email-event-webhook-timestamp`. Missing/invalid → **403**.
  3. Else fall back to the SendGrid inbound IP allowlist (159.26.*).
- Wired in `src/webhooks/email.ts` as `captureRawBody → verifySignature → upload.any()`.
- SendGrid setup: an Inbound Parse **security policy** (signature-only) is attached to the parse host `aegis.quriasolutions.com`; `send_raw=false` is preserved so the handler still receives parsed fields. Verified by the live log line `[sendgrid-verify] ECDSA signature verified { bodyBytes: N }` (bodyBytes == content-length confirms exact raw capture).
- *Fast-follow:* add a timestamp-freshness/replay window and remove the now-dead IP-allowlist fallback once stable.

### 1.3 Email body cleaning

Before routing, email bodies are cleaned: `stripEmailBody()` cuts quoted reply content (`On … wrote:`, `--- Original Message ---`, `From:` …) and `stripHtmlTags()` removes HTML. Company routing resolves `company_id` from `company_channels` (matching the inbound address against `channel_value`). Thread tracking uses the `Message-ID` header stored as `thread_id`.

### 1.4 Identity verification

Every inbound message is identity-checked before processing, producing a `VerifiedContact { role, employee_id, company_id, manager_id, channel, sender, recipient }`:

1. Sender phone/email matches an `employees` row (`contact_phone`/`contact_email`).
2. Sender matches a `users` row (manager/owner/quria_admin).
3. Sender has an active onboarding session.
4. None → `"I don't recognize this number. If you believe this is an error, please contact your manager."`

### 1.5 HELP / INFO compliance

Checked **before** identity verification (works for unrecognized numbers): replies with the STOP/support compliance message immediately.

### 1.6 Intent classification

After identity verification, Claude classifies the message. Returns JSON with `intent`, `confidence` (high/medium/low), and extracted data. **The classifier system prompt must inject today's date** (timezone-aware via `Intl.DateTimeFormat('en-CA', { timeZone: companyTimezone })`) — year-drift on relative dates ("June 5" → wrong year) is a recurring bug class.

**Employee intents:** `submit_time_off`, `query_my_time_off`, `update_availability`, `initiate_swap`, `respond_swap_accept`, `respond_swap_decline`, `emergency_coverage`, `confirm_pending`, `deny_pending`, `general_query`.

**Manager intents** (employee set plus): `build_schedule`, `distribute_schedule`, `approve_time_off`, `deny_time_off`, `query_schedule`, `homebase_edit`, `notify_day_closure`, `initiate_onboarding`.

---

## 2. Schedule Engine V2 (the deterministic core)

`ENGINE_VERSION = '2.0.0'`. A generic, multi-tenant, **deterministic** engine: given identical input rows it produces identical output, with no LLM call during the build. Its behavior on any client is determined entirely by that client's Supabase data through a finite **constraint vocabulary**. Adding a client is a data operation, not a code change.

### 2.1 File structure

| File | Purpose |
|---|---|
| `src/workflows/schedule-build.ts` | Orchestrator: load data, parse target week, apply shift overrides, call `runScheduleBuild`, persist the `schedules` row, dispatch manager-facing results. Defines `ScheduleAssignment`/`ScheduleGap`/`ScheduleData` and the **`FlaggedIssue` discriminated union** (`unsatisfied_attribute_mix` \| `unsatisfied_sex_coverage`). |
| `src/lib/engine/types.ts` | Engine-internal types: `CanvasSlot`, `CandidatePool`, `WeekState`. |
| `src/lib/engine/week-bounds.ts` | `getWeekBounds(offset, weekStartDay)` — derives the 7-day window. |
| `src/lib/engine/canvas.ts` | `buildCanvas(...)` — one `CanvasSlot` per required head per requirement per active date; honors closures; orders priority-first then date/time ASC. |
| `src/lib/engine/eligibility.ts` | Date-level `buildEligibility` + predicates `isQualifiedForRole`, `isAvailableForShift`, `isBlockedByTOForSlot`, `isVeteranOnlyDate`, `shiftsOverlap`, `sameDayDoubleReason`. |
| `src/lib/engine/ranker.ts` | `rankCandidates(...)` — sorted-pool selection. |
| `src/lib/engine/cascade.ts` | `resolveBannedPairConflict(...)` — swap-first / cascade-fallback for hard banned pairs (depth ≤ `MAX_CASCADE_HOPS = 5`). |
| `src/lib/engine/attribute-mix.ts` | `enforceAttributeMixForShift(...)` + `buildAttributeShortageReason(...)` — post-fill per-shift attribute-mix swap pass; emits `unsatisfied_attribute_mix` flags. **Inert for Watermark** (no `attribute_mix` constraint under the flipped policy); retained as a generic capability, fate pending (see §2.4). |
| `src/lib/engine/sex-coverage.ts` | `evaluateSexCoverage(...)` — facility-wide **concurrent_coverage** evaluator. Validate-and-flag only (never mutates `weekState`): per date, segments the timeline at shift boundaries over `population_roles`, flags any required attribute value absent from each on-duty block, and coalesces time-contiguous same-missing-value segments into one `unsatisfied_sex_coverage` flag. |
| `src/lib/engine/dispositions.ts` | `classifyEmployeeForSlot`, `formatDispositionList`, `REASON_LABELS`, `REASON_ORDER` — per-candidate "why not placed" classifier shared by gap diagnostics and attribute-mix reasons. |
| `src/lib/constraints/parser.ts` | `parseConstraints(policies)` → `ParsedConstraints` (hard constraints + `EngineSettings` + dropped/malformed list). |
| `src/lib/constraints/types.ts` | Constraint vocabulary + `EngineSettings` + `DEFAULT_ENGINE_SETTINGS`. |

Supporting modules retained from V1: `src/lib/to-window.ts` (`buildTOMap`, `isBlockedByTO`), `src/lib/custom-availability.ts` (`resolveAvailabilityForWeek`), `src/lib/schedule-simulator.ts` (coverage simulation, `computeWageEstimate`).

### 2.2 Build pipeline — `runScheduleBuild(data, settings, veteranMode, veteranOnlyDates, weekStart, weekEnd)`

Pure engine entry point (`src/workflows/schedule-build.ts:819`):

1. **Canvas** — `buildCanvas` enumerates slots from `shift_types` (outer, named shift per active day) × `shift_requirements` (inner, one slot per required head per role). Closure events drop whole dates. Priority dates (from event `staffing_notes` / certain `event_type`s) sort first.
2. **Fill loop** — per slot, `buildEligibility` applies the **date-level** hard filter; then a **slot-level** filter; then `rankCandidates(...)[0]` chooses.
3. **Cascade** — hard banned-pair conflicts (`employee_conflicts.severity='never'`) trigger `resolveBannedPairConflict` (swap first, then hop-limited cascade ≤ 5).
4. **Attribute mix (per-shift, conditional)** — `enforceAttributeMixForShift` runs a post-fill swap pass to satisfy any `attribute_mix` minimums; unmet → `unsatisfied_attribute_mix` flag. **Empty/inert for Watermark** under the flipped sex policy (no `attribute_mix` constraint produced).
5. **Veteran swap** — `at_least_one` mode swaps in a veteran when none present.
6. **Concurrent coverage (validate-and-flag)** — `evaluateSexCoverage` runs on the *final* assignment state for each `concurrent_coverage` constraint; emits coalesced `unsatisfied_sex_coverage` flags. No swap. (This is Watermark's live sex rule.)
7. **Gap recount** — unfilled heads become `ScheduleGap`s, each carrying `per_employee_dispositions` (every qualified candidate + why they weren't placed).

Output `ScheduleData { assignments, gaps, flagged_issues? }` is written to `schedules.data` (canonical key `assignments`). `flagged_issues` is the `FlaggedIssue` discriminated union; the manager-facing email renderer (`schedule-build-email.ts`) handles **both** variants — the current `unsatisfied_sex_coverage` (renders date / time window / missing sex / on-duty) and the legacy `unsatisfied_attribute_mix` — so historical and current schedules both render.

### 2.3 Eligibility (the "why was X not scheduled?" path)

Date-level (`buildEligibility`) removes, in order: `!active` → veteran-only-date non-veteran → `!isQualifiedForRole(slot.role)` → availability does not contain shift window → approved time off blocks the slot.

Slot-level (in the fill loop) additionally rejects: already assigned to this shift; same-day double (`sameDayDoubleReason`; hard time-overlap always rejected, non-overlapping doubles allowed only if `doublesPolicy='allow'`); weekly hours would exceed `max_weekly_hours`; hard banned pair already on the shift (`hasHardBannedPair`).

> The engine matches an employee to a slot by `isQualifiedForRole(employee, slot.role)` against `qualified_roles`. **It does not read `shift_requirements.accepted_roles`** — Role Groups is not built. A skipped employee almost always failed `isQualifiedForRole` (role missing/miscased in `qualified_roles`) or the `max_weekly_hours` filter (0/null caps them out). Read the gap's `per_employee_dispositions` to see the exact `DispositionReasonCode`.

### 2.4 Constraint vocabulary (`src/lib/constraints/`)

The parser reads **only** `policies.policy_key` and `policies.policy_value_json` (it ignores `policy_type` and `policy_value`). Rows with NULL `policy_value_json` are dropped (`null_json`); unknown keys are dropped to `unrecognized[]`.

| Constraint | Accepted `policy_key` aliases | `policy_value_json` shape | Engine destination |
|---|---|---|---|
| attribute_mix (per-shift) | attribute_mix, minimum_attribute_mix, gender_requirement, minimum_gender_requirement, sex_requirement | `{ attribute, minimums: {value:number}, scope: 'all_shifts'|'shift_type'|'specific_shift', scope_target? }` | `hard.attributeMix[]` → `enforceAttributeMixForShift` (post-fill swap). **Inert for Watermark today** — see note below. |
| **concurrent_coverage** (facility-wide, validate-and-flag) | same `policy_key` aliases as attribute_mix, distinguished by **`scope: 'concurrent_coverage'`** in `policy_value_json` (the parser routes on the `scope` value) | `{ attribute, minimums: {value:number}, scope: 'concurrent_coverage', population_roles: string[], on_infeasible: 'flag' }` | `hard.concurrentCoverage[]` → `evaluateSexCoverage` (no swap; emits `unsatisfied_sex_coverage` flags) |
| hours_fairness_weight | hours_fairness_weight, fairness_weight | number in [0,1] (or `{value}`) | `EngineSettings.hoursFairnessWeight` (fairness sort key) |
| partial_shifts_allowed | partial_shifts_allowed, allow_partial_shifts | boolean (or `{value}`) | `EngineSettings.partialShiftsAllowed` |
| veteran_preference_default | veteran_preference_default, veteran_default | 'none'\|'prioritize'\|'at_least_one'\|'only' | `EngineSettings.veteranPreferenceDefault` (fallback when manager omits) |
| doubles_policy | doubles_policy, double_shifts | 'never'\|'emergency_only'\|'allow' | `EngineSettings.doublesPolicy` |
| conflict_resolution_preference | conflict_resolution_preference, conflict_resolution | 'fairness_first'\|'minimize_disruption' | `EngineSettings.conflictResolution` (parsed, not yet consulted) |
| week_start_day | week_start_day, first_day_of_week | 'sunday'\|'monday' | `EngineSettings.weekStartDay` → `getWeekBounds` |

`DEFAULT_ENGINE_SETTINGS`: `hoursFairnessWeight 0.7`, `partialShiftsAllowed false`, `veteranPreferenceDefault 'none'`, `doublesPolicy 'never'`, `conflictResolution 'fairness_first'`, `weekStartDay 'sunday'`. Watermark sets `weekStartDay='monday'` via the Rules tab. `emergency_only` currently behaves like `never` (no emergency context in the build path).

**Watermark gender rule — LIVE as `concurrent_coverage` (not dormant).** Earlier docs described `gender_requirement` as a dormant per-shift `attribute_mix` with `policy_value_json = null`. That is no longer the case. The ENGINE-2 rework **flipped** the policy to the facility-wide `sex_coverage` model: `scope=concurrent_coverage`, `attribute=sex`, `minimums {male:1, female:1}`, `population_roles=[Headguard, Lifeguard, AManager]` (Greeter, Junior Lifeguard, and pure Manager are NOT counted), `on_infeasible=flag`. It is **validate-and-flag only** — it evaluates the day's timeline (segmented at shift boundaries, restricted to `population_roles`) and emits `unsatisfied_sex_coverage` `FlaggedIssue`s where a required sex is absent from the on-duty set; it never swaps. This eliminated the bimodal-hours churn the old per-shift swap caused. The flag is the safety mechanism (flag-don't-force) and surfaces in both the Aegis manager email and Homebase's `CoverageFlags`. See the Supplemental reference §5/§9 for the `evaluateSexCoverage` internals.

**`enforceAttributeMixForShift` — retained but inert (decision pending).** The old per-shift `attribute_mix` swap pass (`schedule-build.ts:707`, `attribute-mix.ts`) still exists and still fires for any tenant whose policy yields a `hard.attributeMix[]` constraint. For Watermark it is **inert** — the flipped policy feeds the `concurrent_coverage` path, so the parser yields no sex `attribute_mix` and `hard.attributeMix` is empty (confirmed by the 6/15 build: flat hours, only `sex_coverage` flags). A pending decision (`DEV_ROADMAP.md` Tier-2 / Phase 3) is whether to **keep** it as a generic multi-tenant capability behind a guardrail or **remove** it in favor of `concurrent_coverage` as the only sex/attribute model.

Non-policy hard constraints the engine also consults: `employee_conflicts` (`never` hard / `avoid` soft), `events` (`closure` drops dates; other types mark priority), and approved `time_off_requests`.

### 2.5 Veterans & invocation

`build_schedule` extracts `target_week (this|next)`, `veteran_preference`, and `veteran_only_dates [{start_date,end_date}]` (a hard date-specific exclusion of non-veterans, distinct from `veteranMode`). The classifier prompt injects today's date so relative ranges resolve. After a build, `computeWageEstimate` runs and the manager gets an assignment-count + gap summary. Dry-run/test harnesses: `scripts/dry-run-schedule.ts`, `scripts/test-cascade.ts`.

---

## 3. Time-Off Workflow (`src/workflows/time-off.ts`) — production-verified

1. Employee texts/emails (e.g. "I need Friday June 12 off"). Classified `submit_time_off`; dates normalized, partial windows resolved (period labels: morning 09:00–13:00, afternoon 13:00–17:00, evening 17:00–21:00).
2. A pending confirmation is stored in `aegis_memory` (`memory_type='observation'`); employee gets a "reply YES to confirm" message. On the email channel an in-thread ack (`sendInThreadAck`) lands first.
3. On YES (`confirm_pending`): INSERT into `time_off_requests` with `requested_at = now()` (NOT NULL), `time_off_type`, `partial_days`.
4. **`notifyManagersByEmail` fans out to ALL managers** — queries `users` `role IN ('manager','owner')`, filters to those with email, sends each a notification carrying a per-manager **magic-link** Approve/Deny (single-use `aegis_action_tokens`). Success logs silently; only failures/no-managers log.
5. Manager approves/denies via magic-link **or** the Homebase Time Off tab (the backstop). Employee is notified. Manager retains final authority — an employee's YES never auto-approves.

**BUG-1 fix (June 4, deployed):** TO creation no longer requires `shift_requirements`. The coverage simulator is wrapped in try/catch; if no shifts exist it skips silently (internal log only) and the TO still inserts and the manager is still notified.

**Policy violations** (e.g. notice period, max consecutive days) are computed and **rendered in the manager email body** (`violationLines()` → `policyLines`). Surfacing them in the Homebase UI is unbuilt (TO-R4). Manager-created/approved TOs are advisory-bypass — violations are shown, not blocked.

`query_my_time_off`: returns approved upcoming TO (`status='approved' AND end_date >= today`) with full-day/partial detail.

**Employee-facing email rule (BUG-4, hard standing rule):** employee emails are conversational and **must never contain a "View in Homebase" CTA** — employees have no Homebase access. Homebase links belong only in manager-facing templates.

---

## 4. Availability Update Workflow (`src/workflows/employee-onboarding.ts`) — production-verified

`handleUpdateAvailability` → `handleAvailabilityConfirmResponse` → `handleManagerAvailabilityApproval`:

1. Employee messages availability. The parser (`claudeParseAvailability`) wants **singular day names + the word "to"** ("I can work Monday 9am to 5pm and Thursday 10am to 3pm"). Plural days ("Mondays") and dashes ("9-5") currently fail to a graceful "be more specific" fallback. *Fast-follow: vocabulary hardening to accept dashes/plurals/"through".*
2. Confirmation stored in `aegis_memory`; employee replies YES.
3. **Manager notify fans out to ALL managers** (fixed June 5 — previously `.limit(1).maybeSingle()` notified only one). Pending approval is stored **once, keyed by employee** (`availApprovalSource(company_id, employee_id)`); any manager replying YES consumes it. Email-first per manager, SMS fallback when a manager has phone + an SMS channel but no email.
4. Manager approval is **reply-YES** (`handleManagerAvailabilityApproval`) — no magic-link buttons yet (*fast-follow: mirror the TO magic-link + add a Homebase backstop*). On YES: delete the employee's `availability` rows and insert the proposed set; log `availability_updated`; notify the employee.

---

## 5. Onboarding Workflow (`src/workflows/employee-onboarding.ts`)

Multi-step onboarding over SMS or email; sessions in `aegis_memory` (`source='onboarding:{employee_id}'`, 48h expiry). Steps: `opt_in → name_confirm → email → role → availability → availability_confirm → time_off → complete`.

**Opt-in (A2P/TCPA):** the first message any employee receives. `textEmployee()` guards on `opt_in_confirmed`; only `textEmployeeRaw()` bypasses (the opt-in send itself). YES keywords advance + log `employee_opt_in_confirmed`; NO clears the session + logs `employee_opt_in_declined`. **Fan-out** (`initiate_onboarding` "all"): one session + opt-in per active employee lacking a completed session, skipping those with neither phone nor email.

---

## 6. Other Workflows

- **Schedule distribution** — groups the current week's `assignments` by employee, sends each their shifts via `textEmployee()` (channel-aware), sets `schedules.distributed_at`, logs, reports count. Risky 30-person fan-out — requires DELIV-1 + manager coordination (see dev guide).
- **Day closure** (`src/workflows/day-closure.ts`) — `handleNotifyDayClosure`; triggered by Homebase `/api/notify-day-closure`; per-employee "your shift is cancelled" message; logs `closure_notification_sent`.
- **Emergency coverage** — finds qualified, available, not-on-TO candidates (veterans first if preferred), contacts in order, first YES is assigned, manager notified.
- **Shift swap** — `initiate_swap` creates a `swaps` row; target replies YES → `accepted` → manager approval → `manager_approved`; both notified.
- **homebase_edit** (manager) — direct Supabase update by entity name, logged with before/after.
- **query_schedule** (manager) — reports status, `total_filled/total_required`, gaps with reasons.

---

## 7. Reply, Tenant Routing & Logging

- `reply(contact, message, body)` routes by `contact.channel` (SMS via `sendSms` with the Messaging Service SID; email via `sendEmail`). Manager notifications use `reply()` against a synthetic `InboundMessage` so channel branching lives in one place.
- **Email threading / tenant From (TENANT-1, Phase 4.5 — partially open):** inbound is per-tenant (`aegis@aegis.quriasolutions.com`), but outbound `From` is currently the apex `aegis@quriasolutions.com` with `Reply-To` carrying the routing address. This works for single-tenant Watermark; the proper multi-tenant fix is to source `From`/`Reply-To` per tenant from `company_channels.channel_value` and propagate `In-Reply-To`/`References`. Required before a second tenant onboards.
- `logActivity({...})` writes to `activity_log` (actor defaults to `aegis`).
- `withAnthropicRetry(fn, 3)` wraps every Anthropic call (1s/2s backoff on 529). Applies only to intent classification and response generation — the schedule build is LLM-free.

---

## 8. Testing with cURL

Set `SKIP_TWILIO_VERIFICATION=true` (Twilio) and/or `SKIP_SENDGRID_VERIFICATION=true` (SendGrid) **for local testing only** — never in production. URL-encode `+` as `%2B`.

```
curl -X POST https://aegis-production-3220.up.railway.app/webhooks/sms \
  -d 'From=%2B16163280114&To=%2B16167477953&Body=help' \
  -H 'Content-Type: application/x-www-form-urlencoded'
```

Health check: `GET /health` → 200.
