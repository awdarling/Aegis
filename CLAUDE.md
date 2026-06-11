# CLAUDE.md — Aegis

Aegis is Quria Solutions' AI assistant manager: a Node/Express/TypeScript service on Railway that talks to employees and managers over SMS (Twilio) and email (SendGrid), classifies intent with Claude, and runs a deterministic **Schedule Engine V2**. Supabase (service-role key — bypasses RLS) is the database. First and only live client: Watermark Country Club (launched June 5, 2026).

## Session protocol (do this every session — non-negotiable)
1. **At session start, read first:** `DEV_ROADMAP.md` (live sprint + Logging Protocol) and the trackers — `EMAIL_WORKFLOWS_TRACKER.md`, `SCHEMA_DRIFT_LOG.md`, `TEST_IDENTITIES.md`. Self-brief from these before touching anything.
2. **Fix-now bias:** if a fix is in scope and safe — diagnosed, surgical, `tsc`-clean, and not a production write/push/deploy — do it this session. Don't log it for "later".
3. **Defer only with a logged reason:** when a fix is unsafe to do now (rippling/large change, needs Alexander's decision, or writes production / deploys), say why in plain English and log it in the right doc. Never silently drop it, and never sweep a large change blind.
4. **At session end, write it all back:** every finding, decision, new bug, and schema surprise goes into the right doc — roadmap status + Session Log entry, the trackers, `SCHEMA_DRIFT_LOG.md`, and the `docs/` reference when behavior changed. **If it wasn't logged, it isn't done.**

## Read before you act
@DEV_ROADMAP.md
- That import is the live sprint + how-to-use. It loads automatically — treat its Current Sprint as the priority and follow its rules.
- Deep reference (read the relevant one before working in that area): `docs/04_Aegis_Reference.md`, `docs/02_Database_Schema.md`, `docs/06_Supplemental_Reference.md`.
- Live trackers (update them when state changes): `EMAIL_WORKFLOWS_TRACKER.md`, `SCHEMA_DRIFT_LOG.md`, `TEST_IDENTITIES.md`.

## Design north-star (self-align to this)
The post-sprint direction is the **Forward Build Sequence (Phases 1–4)** in `DEV_ROADMAP.md`: (1) harden & fix the live product, (2) complete the comms loop, (3) configurable correct rules, (4) experience & leverage. **End-state vision:** Aegis is a conversational AI assistant manager running the entire employee side of workforce ops over email (SMS once A2P clears) — onboarding, availability, time-off, swaps, emergency coverage, weekly distribution — in a human-feeling voice, backed by a deterministic engine that builds fair schedules and *flags* real coverage gaps instead of silently overworking staff; Homebase is the manager command center (rules that drive the engine, schedules that persist & download, one-click approvals, coverage flags with suggested swaps, Soteria NL admin). Thesis: config-over-code multi-tenancy, a deterministic auditable engine, flag-don't-force with humans in final authority — secure enough to sell. Full statement in `docs/01_Business_Overview.md` §1.5.

## Hard rules (do not violate)
- **Diagnose before fixing.** Show the evidence and explain the plan in plain English BEFORE editing. No blind fixes.
- **Verify column names against `information_schema` before any INSERT/UPDATE.** `src/db/types.ts` is INCOMPLETE — it omits `employees.sex` and `shift_requirements.accepted_roles` (both exist, NOT NULL). Never trust the types file as the schema of record. Log new findings in `SCHEMA_DRIFT_LOG.md`.
- The schedule build is **deterministic and LLM-free**. Wrap only intent-classification and response-generation Anthropic calls in `withAnthropicRetry`.
- Classifier prompts **must inject today's date**, timezone-aware (`Intl.DateTimeFormat('en-CA', { timeZone: companyTimezone })`) — year-drift is a recurring bug.
- **Employee-facing emails NEVER contain a "View in Homebase" CTA.** Homebase links are manager-only.
- Every Aegis-generated string meets the "feels like a person" bar — no "request received", "processing intent", "standby".
- **No orphan outputs:** every write lands as valid, visible state a manager can see.
- **Configuration over code:** the engine/platform is generic and multi-tenant; client behavior is driven by their Supabase data + the constraint vocabulary, never by client-specific code. Accommodating a client is a data/config operation, not an engine change. Per-client rules are toggleable (e.g. sex_coverage on/off). If a client needs something the vocabulary can't express, that's a product conversation — never a quiet engine patch.
- **No secrets or sensitive identifiers in committed files — reference docs included.** Names and architecture only. Real credential VALUES (API keys, auth tokens, Supabase keys) AND sensitive identifiers (Twilio Account/Messaging-Service SIDs, project refs) never go in any tracked file. Use placeholders (`AC••• — see Railway env / password manager`); real values live in env vars / the password manager. GitHub push-protection will block the push if you violate this (it happened — see the 2026-06-09 Session Log).
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
- **Aegis (this repo):** push to `main` → Railway auto-deploys. Read the actual diff before pushing.
- **Homebase deploy flow (different repo — PR-gated).** As of 2026-06-10, Homebase `main` is **GitHub branch-protected** — direct pushes are rejected. The flow is **feature branch → PR → merge → Vercel auto-deploy on merge**. Exact sequence (run from `~/Desktop/homebase`):
  ```bash
  find .git -name "*.lock" -delete
  git fetch origin
  git checkout <branch>
  npm install
  npm run build          # must be green
  git push -u origin <branch>
  # then on GitHub: open PR, review diff, merge — Vercel deploys on merge
  ```
- **NEVER** trigger `distribute_schedule` against real Watermark data without manager coordination (Carolyn, Jack) — it emails ~30 real employees.
- Never print or commit secrets (Twilio, SendGrid, Supabase keys live in Railway env vars).
- `awdarling@quriasolutions.com` is `quria` (the platform-admin `users.role`), NOT an employee — employee intents won't work from it without test setup. (`'quria_admin'` is an `activity_log.actor` / Aegis `ContactRole` label only — never a `users.role` value.)

## Remote Control (launch a session you can steer from your phone)
Claude Code's Remote Control lets the Claude mobile app attach to a running laptop session — useful for long verifies/builds you're away from. Requires **Claude Code v2.1.51+** (v2.1.110+ for push notifications) and sign-in via **claude.ai** (`/login`); **API keys are unsupported** — `unset ANTHROPIC_API_KEY` if it's exported. Enable per-session with `claude --rc`, or for all sessions via `/config` → "Enable Remote Control for all sessions". On mobile: install the Claude app, sign in with the same account, enable push in `/config`, attach from the Code tab. **Gotchas:** the laptop must stay awake and online (`caffeinate -dimsu`; >~10 min offline ends the session); leave **sandboxing OFF** (the default — enabling it recreates the git-lock / `npm run build` / font failures); **merge-to-live always stays a human gate** — Remote Control does not relax the safety model.

## Cowork / autonomous operating model
- **SAFE LANE — an agent may do these unattended.** Reads of any kind (DB reads, dry-runs, the verify harness, build/deploy logs). Writes against the SANDBOX tenant only (`company_id = 00000000-0000-0000-0000-000000000001`). Code on a feature branch, `tsc`, open a PR. **Prefer the read-only DB role (`cowork_ro`) for reads when available** — least-privilege by default, not the service-role key.
- **HUMAN-GATED — never autonomous; queue for Alexander.** Merge/push to `main` (= deploy to live Watermark). Any write to PRODUCTION / Watermark data. Production env-var or policy changes (incl. Supabase policy flips). Anything that messages a real employee (`distribute_schedule`, onboarding fan-out, real notifications).
- **Principle: autonomy and credential power trade off.** Unattended work runs read-only / sandbox-scoped. Privileged actions need a human. Safety comes from constraining the environment (branch-not-main, sandbox-not-prod, least-privilege creds), not from real-time watching.
- **Never exfiltrate data via MCP, Chrome, or network egress.** Reads stay in-repo / in-DB; output lands in the session, the PR, or the logged docs.
- **DONE-rule: committed ≠ done.** A change is `DONE` only when committed AND live-verified end-to-end. Committed-but-unpushed or pushed-but-unverified = `IN REVIEW`. Don't flip statuses on the strength of a clean `tsc` or a green PR alone.
- **Logging routing (additive to the Session protocol).** Apply enumerated status changes / decisions / findings exactly as the working note states — don't independently re-judge them. Route by topic: bugs / workflows → `EMAIL_WORKFLOWS_TRACKER.md`; schema surprises → `SCHEMA_DRIFT_LOG.md`; tenants / test identities → `TEST_IDENTITIES.md`. If it changed and wasn't logged, it isn't done.

## When you finish — follow the Logging Protocol
Work is not done until the project's memory is updated. Follow the **Logging Protocol** at the top of `DEV_ROADMAP.md`: update the roadmap status + append a Session Log entry, mirror bug changes into `EMAIL_WORKFLOWS_TRACKER.md`, append any schema finding to `SCHEMA_DRIFT_LOG.md`, update `TEST_IDENTITIES.md`, and update the relevant `docs/` reference doc when the change alters how the system works. Never end a session without it — the next agent self-briefs from these files.
