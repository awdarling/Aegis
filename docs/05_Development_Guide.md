# QURIA SOLUTIONS — Development Guide

**Patterns, Active State & Backlog**

**Version 3.0 — June 8, 2026**

---

## 1. Developing with Claude Code

All Homebase/Aegis development runs through Claude Code from the repo directory (`~/Desktop/homebase` or `~/Desktop/Aegis`).

**Loop:** open terminal in the repo → `claude` → paste prompt → review the actual diff (do not trust "tsc clean" without seeing it) → `git add . && git commit -m '…' && git push` → verify deploy (Vercel for Homebase, Railway for Aegis).

**Prompt structure that works:** (1) read-list — "Read these files completely before writing anything"; (2) audit gate — "Do not make changes yet"; (3) named sections (PART 1, PART 2…); (4) exact field names/types/logic where precision matters; (5) close with "Compile clean with `npx tsc --noEmit`. Show the full diff of every file changed."

For larger builds, split into a read-only **audit session** then a **build session** (the pattern that produced Engine V2 and the doc-refresh audit) — it costs an hour and saves days.

## 2. Critical codebase rules

- Read files before editing; verify column names against `information_schema` (and remember `src/db/types.ts` is incomplete — see Schema doc).
- Dates: never `new Date('YYYY-MM-DD')` for display — `split('-')` + `new Date(y, m-1, d)`.
- RLS: Aegis uses the service role (bypasses RLS); Homebase client uses anon, server uses service role. A missing/ mismatched `public.users` row breaks all Homebase queries.
- One `<action>` per Soteria response; keep `max_tokens` 8192.
- Wrap every Anthropic call in `withAnthropicRetry`. The schedule build is **LLM-free** — no retry needed there.
- Stripe amounts in cents.
- Classifier prompts must inject today's date (timezone-aware) to avoid year-drift.
- Employee-facing emails never contain Homebase CTAs (hard rule).
- Every NOT NULL discovered in production goes in `SCHEMA_DRIFT_LOG.md` (append-only) — e.g. `time_off_requests.requested_at`, `shift_requirements.accepted_roles`, `aegis_memory.memory_type`.

## 3. Debugging quick-reference

- **Homebase data not loading** → check `public.users` row exists with matching `id`/`company_id`; check `NEXT_PUBLIC_SUPABASE_*` envs.
- **Aegis not responding** → Railway running? Twilio inbound webhook URL correct + account funded? `ANTHROPIC_API_KEY` set? `curl …/health`.
- **Inbound email rejected** → check `[sendgrid-verify]` logs; if legitimate mail is 403'd, the signature key/policy or IP allowlist is the cause; `SKIP_SENDGRID_VERIFICATION` must be `false` in prod.
- **Schedule build wrong/empty** → check both `shift_types` and `shift_requirements` are populated; read the gap `per_employee_dispositions`; check the `[schedule-build]` log lines (absence ⇒ intent extraction missed a parameter).
- **Soteria action card missing** → max_tokens truncation (missing `</action>`) or "action JSON parse failed" in logs.
- **Stripe** → live vs test mode mismatch; `billing_model` must be `one_time`/`subscription`; `subscription_price` in cents.

## 4. Deployment

- **Homebase (Vercel):** push to `main` → auto-deploy; after env-var changes, redeploy manually (`git commit --allow-empty -m 'redeploy' && git push` forces it).
- **Aegis (Railway):** push to `main` → auto-deploy.
- **Migrations:** run manually in the Supabase SQL Editor; `ADD COLUMN IF NOT EXISTS`; service role bypasses RLS.

## 5. File structure

**Aegis (`~/Desktop/Aegis`):**

| Path | Purpose |
|---|---|
| `src/router/intent-router.ts` | identity verification, intent dispatch |
| `src/ai/claude.ts` | classifier + response gen; `EMPLOYEE_INTENTS`/`MANAGER_INTENTS` |
| `src/workflows/schedule-build.ts` | engine orchestrator; `runScheduleBuild`; output types |
| `src/lib/engine/` | `week-bounds`, `canvas`, `eligibility`, `ranker`, `cascade`, `attribute-mix`, `dispositions`, `types` |
| `src/lib/constraints/` | `parser`, `types` (constraint vocabulary, `EngineSettings`) |
| `src/lib/to-window.ts`, `custom-availability.ts`, `schedule-simulator.ts` | TO windows, custom availability, coverage sim + wage estimate |
| `src/workflows/time-off.ts` | TO submit/confirm/approve/deny/query; `notifyManagersByEmail` |
| `src/workflows/employee-onboarding.ts` | onboarding + opt-in; availability update/confirm/manager-approval |
| `src/workflows/day-closure.ts` | closure notifications |
| `src/messaging/sms.ts`, `email.ts` | `sendSms`, `sendEmail`; `reply`, `sendInThreadAck` |
| `src/middleware/capture-raw-body.ts`, `verify-signature.ts` | inbound SendGrid ECDSA verification |
| `src/webhooks/sms.ts`, `email.ts` | inbound endpoints |
| `src/db/client.ts`, `types.ts` | Supabase service-role client; generated types (incomplete — verify) |
| `scripts/dry-run-schedule.ts`, `test-cascade.ts` | engine harnesses |

**Homebase (`~/Desktop/homebase`):** `src/app/(app)/` pages; `src/app/(app)/data/tabs/`; `src/app/(app)/schedule/page.tsx`; `src/app/api/soteria/{route,execute,validate-schedule,validate-assignment}`; `src/app/api/stripe/{route,webhook}`; `src/app/api/notify-day-closure`; `src/app/api/schedule/download/`; `src/lib/{types,activity}.ts`; `src/lib/hooks/{useCompany,useQuria}.ts`; `src/lib/supabase/{client,server}.ts`; `src/components/layout/{SoteriaPanel,Sidebar}.tsx`.

---

## 6. Active State — June 8, 2026

### 6.1 Shipped & verified

- **Watermark launched June 5, 2026.** Employees email `aegis@aegis.quriasolutions.com` for time off and availability.
- **Time-off email workflow** — full chain verified on Watermark (submit → confirm → fan-out to all managers → magic-link or Homebase approve → employee notified; violations rendered in the manager email).
- **Availability email workflow** — full chain verified (submit → confirm → fan-out to all managers → reply-YES approve → `availability` updated → employee notified).
- **Inbound signature verification** ("wax seal") — live, `SKIP_SENDGRID_VERIFICATION=false`.
- **Schedule Engine V2 (2.0.0)** — deployed, dry-run + cascade + banned-pair validated.
- Fixed: BUG-1 (TO without shift_requirements), BUG-3 (wrong Homebase URL in outbound), availability manager-notify fan-out (was `.limit(1)`), classifier TO-vs-availability disambiguation.

### 6.2 Open bugs

| ID | Status | Summary |
|---|---|---|
| ENGINE-1 | OPEN | Engine V2 silently skips eligible employee (Aaron Barrigan, Headguard). Eligibility-filter bug; check `qualified_roles`/`max_weekly_hours` via gap dispositions. |
| SCHED-EDIT-1 | OPEN | Manual Schedule-page edits don't persist to `schedules.data.assignments` → distribute sends stale hours. UI-to-data write gap. |
| BUG-4 | OPEN (rule firm) | Audit every employee-facing email template for Homebase CTAs (swap, emergency coverage, onboarding, distribution) and scrub. |
| BUG-5 | OPEN | Stale unconfirmed pending TO silently blocks a new TO submission. Recommended: notify employee + cancel keyword. |
| TENANT-1 | OPEN | Outbound `From` not tenant-aware (apex address + Reply-To works for single-tenant Watermark; breaks at second tenant). |
| DELIV-1 | OPEN | Deliverability hardening (SPF/DKIM/DMARC + sender warm-up) — prerequisite before the 30-person `distribute_schedule` fan-out. |

### 6.3 Launch fast-follows

Remove the Bubba Ganush manager row after rollout monitoring; clear the stray pending test TO + test employees (`aegisscheduler`); availability parser vocabulary hardening (accept dashes/plural days/"through"); availability manager-approval **buttons** (mirror TO magic-link) + a Homebase backstop; `npm audit` (4 vulns / 1 high from the new dep — review, don't blind-fix); strip `[email-trace]`/`[req]` verbose logging and tighten the loose DKIM `' pass'` substring; add a wax-seal timestamp/replay window and remove the dead IP-allowlist fallback.

### 6.4 Deferred features

**Role Groups** (high priority — structural fix for Afternoon Headguard gaps; `accepted_roles` exists; build contract-first, engine before UI); `distribute_schedule` / `initiate_onboarding` fan-outs (need DELIV-1 + Carolyn/Jack coordination); Rules-tab UI + Watermark policy migration (incl. `week_start_day='monday'`); max-consecutive-days constraint; `conflict_resolution_preference` wiring; cascade 5-hop/hours-aware paths; TO-R2.5 (multi-request-per-email — now unblocked), TO-R4 (Homebase TO violation UI), TO-R5 (full TO regression cycle); dormant `gender_requirement` policy.

### 6.5 Tier-2 backlog

`resolveCompanyId` sole-company fallback footgun; `company_channels` exact-match lookup; `decided_by` not set on in-tab TO approvals; Stripe webhook middleware verification; legacy SMS TO-token migration to `aegis_action_tokens`; audit Homebase `/api/*` for missing auth; Outlook DKIM CNAMEs; `xlsx → exceljs` for schedule download cell coloring; route Homebase `notify-assignment` through Aegis; mass-fan-out manager gate; multi-turn email context; sandbox seeding-pattern doc.

---

## 7. A2P / SMS status

10DLC campaign (Low Volume Mixed) resubmitted with the opt-in flow + consent page — **pending Twilio approval**; toll-free verification submitted as the parallel faster path. SMS is therefore not yet the primary channel — **launch is email-first**. Opt-in keywords YES/START/UNSTOP; opt-out STOP/STOPALL/CANCEL/END/QUIT/UNSUBSCRIBE/REVOKE/OPTOUT; HELP/INFO. Support contact `awdarling@quriasolutions.com`. (See the Twilio reference for full campaign field values.)

---

## 8. Cross-cutting principles (do not violate)

Smoke tests must not hit production SendGrid. Read the actual diff before approving a push. Clicking Distribute on a real Watermark schedule fans out to ~30 real employees — never without manager coordination (Carolyn `c45ringler@gmail.com`, Jack `jackmc419@icloud.com`). Alexander's `awdarling@quriasolutions.com` is quria_admin, not an employee — employee intents won't work from it without test setup. Every Aegis-generated string meets the "feels like a person" bar — no "request received", "processing intent", "standby". Verify column names before any write. Keep `SCHEMA_DRIFT_LOG.md` current.

**Doc-refresh trigger** (this v3.0 set was produced under it): refresh when (a) Aegis is live and a second client onboards, (b) `SCHEMA_DRIFT_LOG.md` exceeds ~15 entries, (c) a significant feature like Role Groups needs designing against current schema, or (d) someone other than Alexander joins.
