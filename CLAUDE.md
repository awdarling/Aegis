# CLAUDE.md — Aegis

Aegis is Quria Solutions' AI assistant manager: a Node/Express/TypeScript service on Railway that talks to employees and managers over SMS (Twilio) and email (SendGrid), classifies intent with Claude, and runs a deterministic **Schedule Engine V2**. Supabase (service-role key — bypasses RLS) is the database. First and only live client: Watermark Country Club (launched June 5, 2026).

## Read before you act
@DEV_ROADMAP.md
- That import is the live sprint + how-to-use. It loads automatically — treat its Current Sprint as the priority and follow its rules.
- Deep reference (read the relevant one before working in that area): `docs/04_Aegis_Reference.md`, `docs/02_Database_Schema.md`, `docs/06_Supplemental_Reference.md`.
- Live trackers (update them when state changes): `EMAIL_WORKFLOWS_TRACKER.md`, `SCHEMA_DRIFT_LOG.md`, `TEST_IDENTITIES.md`.

## Hard rules (do not violate)
- **Diagnose before fixing.** Show the evidence and explain the plan in plain English BEFORE editing. No blind fixes.
- **Verify column names against `information_schema` before any INSERT/UPDATE.** `src/db/types.ts` is INCOMPLETE — it omits `employees.sex` and `shift_requirements.accepted_roles` (both exist, NOT NULL). Never trust the types file as the schema of record. Log new findings in `SCHEMA_DRIFT_LOG.md`.
- The schedule build is **deterministic and LLM-free**. Wrap only intent-classification and response-generation Anthropic calls in `withAnthropicRetry`.
- Classifier prompts **must inject today's date**, timezone-aware (`Intl.DateTimeFormat('en-CA', { timeZone: companyTimezone })`) — year-drift is a recurring bug.
- **Employee-facing emails NEVER contain a "View in Homebase" CTA.** Homebase links are manager-only.
- Every Aegis-generated string meets the "feels like a person" bar — no "request received", "processing intent", "standby".
- **No orphan outputs:** every write lands as valid, visible state a manager can see.
- Compile clean: `npx tsc --noEmit`, zero errors. **Show the full diff of every changed file before any push.**

## Engine V2 quick map (`src/lib/engine`, `src/lib/constraints`)
- Orchestrator: `src/workflows/schedule-build.ts` (`runScheduleBuild`; `ScheduleData`/`ScheduleAssignment`/`ScheduleGap` types).
- Pipeline: `canvas.ts` → `eligibility.ts` (date-level) + slot filter → `ranker.ts` → `cascade.ts` → `attribute-mix.ts` → gap recount.
- Eligibility matches employees by `qualified_roles` vs `slot.role`. The engine does **not** read `accepted_roles` (Role Groups unbuilt).
- "Why wasn't X scheduled?" → read the gap's `per_employee_dispositions` (`DispositionReasonCode`).
- Constraints come from `policies.policy_value_json` via `src/lib/constraints/parser.ts` (it ignores `policy_type` and `policy_value`).

## Other key paths
- Intent routing/identity: `src/router/intent-router.ts`. Classifier: `src/ai/claude.ts`.
- Workflows: `time-off.ts`, `employee-onboarding.ts` (availability + onboarding), `day-closure.ts`.
- Messaging: `src/messaging/{sms,email}.ts` (`sendSms`, `sendEmail`, `reply`, `sendInThreadAck`).
- Inbound security: `src/middleware/{capture-raw-body,verify-signature}.ts` (SendGrid ECDSA "wax seal"). `SKIP_SENDGRID_VERIFICATION` must be `false` in prod.
- Harnesses: `scripts/dry-run-schedule.ts`, `scripts/test-cascade.ts`.

## Deploy & danger zones
- Push to `main` → Railway auto-deploys. Read the actual diff before pushing.
- **NEVER** trigger `distribute_schedule` against real Watermark data without manager coordination (Carolyn, Jack) — it emails ~30 real employees. And not while **SCHED-EDIT-1** (Homebase) is open: distributed hours may be stale.
- Never print or commit secrets (Twilio, SendGrid, Supabase keys live in Railway env vars).
- `awdarling@quriasolutions.com` is quria_admin, NOT an employee — employee intents won't work from it without test setup.

## When you finish — follow the Logging Protocol
Work is not done until the project's memory is updated. Follow the **Logging Protocol** at the top of `DEV_ROADMAP.md`: update the roadmap status + append a Session Log entry, mirror bug changes into `EMAIL_WORKFLOWS_TRACKER.md`, append any schema finding to `SCHEMA_DRIFT_LOG.md`, update `TEST_IDENTITIES.md`, and update the relevant `docs/` reference doc when the change alters how the system works. Never end a session without it — the next agent self-briefs from these files.
