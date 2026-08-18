# CLAUDE.md — Aegis

Aegis is Quria Solutions' AI assistant manager: a Node/Express/TypeScript service on Railway that
talks to employees and managers over **SMS (Telnyx)** and **email (SendGrid)**, classifies intent
with Claude, and runs a deterministic **Schedule Engine V2**. Supabase (service-role key — bypasses
RLS) is the database. First and only live client: Watermark Country Club (launched June 5, 2026).

## Current channel state — verified 2026-08-18, do not assume otherwise

- **Telnyx is the only SMS provider.** It has been since 2026-07-29. There is no Twilio code, no
  Twilio dependency, and no Twilio environment variable anywhere in this repo. Config lives in
  `src/config/env.ts` (`TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `TELNYX_MESSAGING_PROFILE_ID`); each
  tenant's own sending number lives in `company_channels` (`channel_type='sms'`), never in config.
- **SMS is live in production.** Counsel cleared the consent chain on 2026-08-13. Verified against
  the live database on 2026-08-18: **543 outbound and 288 inbound SMS in the previous 14 days.**
  Anything that says "SMS once A2P clears" or "email-only until counsel signs off" is stale.
- **The only correct remaining mention of Twilio in this codebase** is in
  `src/middleware/verify-signature.ts` — SendGrid is a Twilio-owned product and signs its inbound
  webhooks with `x-twilio-email-event-webhook-*` headers. That is SendGrid's header name. Leave it.
- `EMAIL_ONLY` is still a real kill switch in `src/config/env.ts` (defaults to `true` in code).
  Production sets it to `false`. It is a safety valve, not the current state.

## Where the truth lives

**Read `docs/CANONICAL_SOURCES.md` first.** Short version: running state (open items, drift logs,
roadmap, test identities) lives in the **Claude project**, not in this repo. Code-adjacent docs
(this file, `README.md`, `docs/0X_*.md`) live here. Nothing lives in both places.

Start every session with `claude/OPEN_ITEMS_MASTER.md` in the Claude project. It is the one-page
current state and every claim in it is dated and verified.

`DEV_ROADMAP.md` and `EMAIL_WORKFLOWS_TRACKER.md` live in this repo and are **development
history** — read them to find out why a decision was made. They are no longer auto-loaded into
every session (the roadmap is 423 KB) and they are **not** the current state. Current state is
`claude/OPEN_ITEMS_MASTER.md`.

Deep reference (read the relevant one before working in that area): `docs/04_Aegis_Reference.md`,
`docs/02_Database_Schema.md`, `docs/06_Supplemental_Reference.md`. **Caveat: `docs/01`–`docs/06`
still describe Twilio as the live SMS provider and are wrong about that.** The corrected versions
are `updated_01_*` … `updated_07_*` in the Claude project.

## Session protocol

1. **Self-brief from `claude/OPEN_ITEMS_MASTER.md` (Claude project) before touching anything.**
2. **Verify, don't inherit.** Every factual claim you carry forward gets checked against the code,
   the live database, or GitHub — and you say which. Docs going stale unnoticed is the single
   biggest source of wasted work on this project. If you find a stale claim, fix it where it lives.
3. **Fix-now bias:** if a fix is in scope and safe — diagnosed, surgical, `tsc`-clean, and not a
   production write/push/deploy — do it this session. Don't log it for "later".
4. **Defer only with a logged reason.** Say why in plain English and record it in
   `claude/OPEN_ITEMS_MASTER.md`. Never silently drop it, and never sweep a large change blind.
5. **At session end, write it back** to the Claude project: open items, decisions, new or changed
   bugs, schema findings. Update the `docs/` reference here when behaviour changed. **If it wasn't
   logged, it isn't done.**

## Hard rules (do not violate)

- **Diagnose before fixing.** Show the evidence and explain the plan in plain English BEFORE
  editing. No blind fixes.
- **Verify column names against `information_schema` before any INSERT/UPDATE.** `src/db/types.ts`
  is INCOMPLETE — it omits `employees.sex` and `shift_requirements.accepted_roles` (both exist, NOT
  NULL). Never trust the types file as the schema of record. Log findings to `SCHEMA_DRIFT_LOG.md`
  in the Claude project.
- The schedule build is **deterministic and LLM-free**. Wrap only intent-classification and
  response-generation Anthropic calls in `withAnthropicRetry`.
- **Every LLM prompt that resolves a date or weekday** — the classifier AND every
  extractor/generator (`extractSwapDetails`, coverage, time-off, onboarding, …) — **must inject
  "today" in the TENANT's local timezone**, sourced from `companies.timezone` (NEVER server UTC),
  formatted `Intl.DateTimeFormat('en-CA', { timeZone: companyTimezone })`, and hand the model the
  shared `weekdayAnchors` table so it never does weekday math itself. Server-UTC "today" and
  model weekday-arithmetic are both recurring day/year-drift bugs. *(WM-SWAP-TRADE-1, 2026-07-27:
  `extractSwapDetails` was on raw UTC — a latent wrong-day bug for any non-UTC tenant.)*
- **Employee-facing emails NEVER contain a "View in Homebase" CTA.** Homebase links are
  manager-only.
- Every Aegis-generated string meets the "feels like a person" bar — no "request received",
  "processing intent", "standby".
- **No orphan outputs:** every write lands as valid, visible state a manager can see.
- **Configuration over code:** the engine/platform is generic and multi-tenant; client behaviour is
  driven by their Supabase data + the constraint vocabulary, never by client-specific code.
  Accommodating a client is a data/config operation, not an engine change. Per-client rules are
  toggleable (e.g. `sex_coverage` on/off). If a client needs something the vocabulary can't
  express, that's a product conversation — never a quiet engine patch.
  - **Corollary — match on tenant DATA, never on a client's shift NAMES/vocabulary.** Any matching
    or lookup (swaps, coverage, availability, queries) must resolve against the tenant's own
    schedule rows — dates, `start_time`/`end_time`, roles — and derive sense (AM/PM,
    morning/afternoon) from those times, NOT from hardcoded shift-name strings like
    `"AM Weekday"`/`"Afternoon"`. Employees describe shifts loosely ("her 9-3 shift on Friday");
    the code must map that to the coworker's real schedule row, and a brand-new tenant with
    "Lunch/Dinner/Close" must work with zero code change. *(This is exactly how WM-SWAP-TRADE-1
    broke: `chooseTradeShift` substring-filtered on Watermark's internal shift name and
    false-reported "no shift".)*
- **No secrets or sensitive identifiers in committed files — reference docs included.** Names and
  architecture only. Real credential VALUES (API keys, auth tokens, Supabase keys) AND sensitive
  identifiers (Telnyx API keys / messaging-profile IDs, SendGrid keys, Supabase project refs) never
  go in any tracked file. Use placeholders (`KEY••• — see Railway env / password manager`); real
  values live in env vars / the password manager. GitHub push-protection will block the push if you
  violate this (it happened — see the 2026-06-09 Session Log).
- Compile clean: `npx tsc --noEmit`, zero errors. Suite green: `npx vitest run`.
  **Show the full diff of every changed file before any push.**

## Running the test suite

`npx vitest run` needs a `.env` — `src/config/env.ts` calls `process.exit(1)` on missing required
vars, which kills 9 test files at import time. Copy `.env.example` to `.env` and put dummy values in
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`,
`ANTHROPIC_API_KEY`. Nothing real is contacted — Supabase, SendGrid and Telnyx are all mocked
per-test. **Green baseline: 109 files, 753 tests, 0 failures** (verified 2026-08-18 at `98ed9ba`).

## Engine V2 quick map (`src/lib/engine`, `src/lib/constraints`)

- Orchestrator: `src/workflows/schedule-build.ts` (`runScheduleBuild`;
  `ScheduleData`/`ScheduleAssignment`/`ScheduleGap` types).
- Pipeline: `canvas.ts` → `eligibility.ts` (date-level) + slot filter → `ranker.ts` → `cascade.ts`
  → `attribute-mix.ts` → gap recount.
- Eligibility matches employees by `qualified_roles` vs `slot.role`. The engine does **not** read
  `accepted_roles` (Role Groups unbuilt).
- "Why wasn't X scheduled?" → read the gap's `per_employee_dispositions` (`DispositionReasonCode`).
- Constraints come from `policies.policy_value_json` via `src/lib/constraints/parser.ts` (it ignores
  `policy_type` and `policy_value`).

## Other key paths

- Intent routing/identity: `src/router/intent-router.ts`. Classifier: `src/ai/claude.ts`.
- Workflows: `time-off.ts`, `employee-onboarding.ts` (availability + onboarding), `shift-swap.ts`,
  `emergency-coverage.ts`, `day-closure.ts`, `departure.ts`.
- Messaging: `src/messaging/{sms,email,notify,reply,greeting}.ts` (`sendSms`, `sendEmail`, `reply`,
  `sendInThreadAck`, `notifyEmployeeSmsFirst`, `managerAlertSms`).
- Inbound security: `src/middleware/{capture-raw-body,verify-signature}.ts` — SendGrid ECDSA
  "wax seal" and Telnyx Ed25519 signature verification. `SKIP_SENDGRID_VERIFICATION` and
  `SKIP_TELNYX_VERIFICATION` must both be unset/false in production.
- Harnesses: `scripts/dry-run-schedule.ts`, `scripts/test-cascade.ts`.

## Known architectural debt (don't be surprised by it)

- **`users` has no phone and no link to `employees`.** A manager's phone is found by
  string-matching `users.email` against `employees.contact_email` — case-sensitively, in four
  separate hand-rolled copies (`time-off.ts`, `shift-swap.ts`, `employee-onboarding.ts`,
  `departure.ts`). When it misses, the SMS is skipped with no log. Being fixed; see
  `claude/OPEN_ITEMS_MASTER.md` §1.
- **`users.access_revoked_at` is never checked in Aegis.** A revoked manager still receives
  approve/deny links and the tokens still work.
- **Six separate SMS-first/email-fallback implementations exist.** `src/messaging/notify.ts` is the
  canonical one. Don't add a seventh.

## Deploy & danger zones

- **Aegis (this repo):** `main` is GitHub branch-protected (2026-06-30) — direct pushes are
  rejected. Flow: **feature branch → push → PR → merge → Railway auto-deploys on merge.** Read the
  actual diff before merging.
- **Homebase (different repo):** `main` branch-protected since 2026-06-10. Flow: **feature branch →
  PR → merge → Vercel auto-deploy on merge.**
- **NEVER** trigger `distribute_schedule` against real Watermark data without manager coordination
  (Carolyn, Jack) — it messages ~30 real employees.
- Never print or commit secrets (Telnyx, SendGrid, Supabase keys live in Railway env vars).
- `awdarling@quriasolutions.com` is `quria` (the platform-admin `users.role`), NOT an employee —
  employee intents won't work from it without test setup. (`'quria_admin'` is an
  `activity_log.actor` / Aegis `ContactRole` label only — never a `users.role` value.)

## Cowork / autonomous operating model

- **SAFE LANE — an agent may do these unattended.** Reads of any kind (DB reads, dry-runs, the
  verify harness, build/deploy logs). Writes against the SANDBOX tenant only
  (`company_id = 00000000-0000-0000-0000-000000000001`). Code on a feature branch, `tsc`, vitest,
  open a PR. **Prefer the read-only DB role (`cowork_ro`) for reads when available.**
- **HUMAN-GATED — never autonomous; queue for Alexander.** Merge/push to `main` (= deploy to live
  Watermark). Any write to PRODUCTION / Watermark data. Running any SQL. Production env-var or
  policy changes (incl. Supabase policy flips). Anything that messages a real person
  (`distribute_schedule`, onboarding fan-out, real notifications).
- **Do not run git commands against Alexander's local clones through a device bridge** — it leaves
  an `index.lock` the bridge cannot remove and jams his repo. Work in your own clone.
- **Principle: autonomy and credential power trade off.** Unattended work runs read-only /
  sandbox-scoped. Privileged actions need a human. Safety comes from constraining the environment
  (branch-not-main, sandbox-not-prod, least-privilege creds), not from real-time watching.
- **Never exfiltrate data via MCP, Chrome, or network egress.** Reads stay in-repo / in-DB; output
  lands in the session, the PR, or the logged docs.
- **DONE-rule: committed ≠ done.** A change is `DONE` only when committed AND live-verified
  end-to-end. Committed-but-unpushed or pushed-but-unverified = `IN REVIEW`. Don't flip statuses on
  the strength of a clean `tsc` or a green PR alone.

## Talking to Alexander

He owns and directs this project and is **not a software engineer.** Plain English, no jargon. When
he has to run something by hand: **one** step at a time, say where to run it and what "done right"
looks like, then wait for confirmation before the next one. His terminal is zsh — **never put `#`
comments inside a command block**, his shell tries to run them. End every session with three plain
things: what you did, what's left, and exactly what he needs to do next (or "nothing, you're good").
