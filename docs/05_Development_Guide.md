# QURIA SOLUTIONS — Development Guide

**Patterns, Active State & Backlog**

**Version 3.2 — June 16, 2026**

> **v3.2 changelog (2026-06-16):** Documented this session's shipped work — the **Quria email brand kit + voice pass** (`src/messaging/brand.ts` + `brand-logo.ts`, CID-inline logo), **INBOUND-SIG-1** (byte-exact inbound ECDSA via `src/security/sendgrid-signature.ts`), and **TO-RERUN-1** (re-check stale TO recommendations + email threading + "✓ Resolved" notices). Updated the §5 file-structure table, added the new shipped items to §6.1, and noted the closed fast-follows. See doc 04 §1.2 / §3.1 / §9 for the reference detail.
>
> **v3.1 changelog (2026-06-10):** §4 Deployment corrected — Homebase `main` is **protected**; the real flow is branch → PR → merge → Vercel auto-deploy (the old "push to `main`" line was wrong as of 2026-06-10). Added a NEW §4.1 with the exact terminal sequence. NEW §9 "Remote Control (run/steer a session from your phone)" documents Claude Code v2.1.51+ remote-control setup, sign-in requirements, gotchas (laptop awake/online, sandboxing OFF).

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
- **Inbound email rejected** → check `[sendgrid-verify]` logs; if legitimate mail is 403'd, the signature key/policy or IP allowlist is the cause; `SKIP_SENDGRID_VERIFICATION` must be `false` in prod. NB: verification is now **byte-exact** (`verifySendGridSignature`, INBOUND-SIG-1) — replies carrying non-UTF-8 bytes (e.g. an inline image in a quoted reply) used to fail under the old `toString()` path; if a reply specifically is 403'd, confirm `captureRawBody` runs first and `req.rawBody.length` matches content-length.
- **Schedule build wrong/empty** → check both `shift_types` and `shift_requirements` are populated; read the gap `per_employee_dispositions`; check the `[schedule-build]` log lines (absence ⇒ intent extraction missed a parameter).
- **Soteria action card missing** → max_tokens truncation (missing `</action>`) or "action JSON parse failed" in logs.
- **Stripe** → live vs test mode mismatch; `billing_model` must be `one_time`/`subscription`; `subscription_price` in cents.

## 4. Deployment

- **Homebase (Vercel):** **`main` is GitHub branch-protected as of 2026-06-10 — direct pushes are rejected.** The real flow is **push a feature branch → open a PR → merge the PR on GitHub → Vercel auto-deploys on merge.** After env-var changes on Vercel, redeploy manually (`git commit --allow-empty -m 'redeploy' && git push` on the feature branch, then re-merge — or use Vercel's "Redeploy" button on the latest deployment).
- **Aegis (Railway):** push to `main` → Railway auto-deploys. (Aegis is not currently behind branch protection; treat protected-`main` as the eventual standard and read the diff before pushing either way.)
- **Migrations:** run manually in the Supabase SQL Editor; `ADD COLUMN IF NOT EXISTS`; service role bypasses RLS.

### 4.1 Homebase deploy — exact terminal sequence

The protected-`main` flow, end-to-end. Run from the Homebase repo (`~/Desktop/homebase`); for an Aegis branch the same shape applies minus the PR/merge step (push goes straight to `main`).

```bash
find .git -name "*.lock" -delete       # clear stale git lock files (common after a previous crash)
git fetch origin                       # sync remote refs
git checkout <branch>                  # or: git checkout -b <branch>
npm install                            # bring deps up to date
npm run build                          # MUST be green — Vercel will fail the same way
git push -u origin <branch>            # publish the feature branch
# then on GitHub: open PR, review the diff, merge.
# Vercel auto-deploys on merge — verify the deployment in the Vercel dashboard.
```

**Gotchas:** `npm run build` failures here will fail on Vercel — fix locally first. **Never force-push to `main`** (the protection rejects it; the underlying rule against force-pushing protected branches stands). After a merge, your local `main` will lag origin/`main` until you `git checkout main && git pull` — this is normal, not a problem to fix on the feature branch.

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
| `src/workflows/time-off.ts` | TO submit/confirm/approve/deny/query; `notifyManagersByEmail`; `recomputeTimeOffRecommendation`, `recheckAndReplyToManager`, `sendDecisionNotification`, `sendManagerResolutionReplies`, `toThreadMessageId` (TO-RERUN-1) |
| `src/workflows/time-off-manager-email.ts` | `buildTimeOffManagerEmail` (manager action-card email w/ approve/deny/recheck magic-links), `buildTimeOffResolutionEmail` ("✓ Resolved" reply) |
| `src/workflows/employee-onboarding.ts` | onboarding + opt-in; availability update/confirm/manager-approval; `applyAvailabilityDecision`, `applyCustomAvailabilityDecision` |
| `src/workflows/day-closure.ts` | closure notifications |
| `src/messaging/brand.ts`, `brand-logo.ts` | Quria email brand kit (`brandedEmailShell`, `brandedButtonRow`, `brandActionCard`, `BRAND`) + base64 CID logo |
| `src/messaging/sms.ts`, `email.ts` | `sendSms`, `sendEmail` (gained `message_id`/`in_reply_to` threading; auto-attaches CID logo), `htmlFromText`; `reply`, `sendInThreadAck` |
| `src/security/sendgrid-signature.ts` | `verifySendGridSignature` — byte-exact inbound ECDSA (INBOUND-SIG-1) |
| `src/middleware/capture-raw-body.ts`, `verify-signature.ts` | inbound SendGrid ECDSA verification (calls `verifySendGridSignature`) |
| `src/webhooks/sms.ts`, `email.ts`, `internal.ts` | inbound endpoints; `internal.ts` = Bearer-auth internal routes (`/notify-to-decision`, `/recompute-to-recommendation`, `/recheck-to-reply`, availability + distribute) |
| `src/db/client.ts`, `types.ts` | Supabase service-role client; generated types (incomplete — verify) |
| `scripts/dry-run-schedule.ts`, `test-cascade.ts` | engine harnesses |

**Homebase (`~/Desktop/homebase`):** `src/app/(app)/` pages; `src/app/(app)/data/tabs/`; `src/app/(app)/schedule/page.tsx`; `src/app/api/soteria/{route,execute,validate-schedule,validate-assignment}`; `src/app/api/stripe/{route,webhook}`; `src/app/api/notify-day-closure`; `src/app/api/schedule/download/`; `src/lib/{types,activity}.ts`; `src/lib/hooks/{useCompany,useQuria}.ts`; `src/lib/supabase/{client,server}.ts`; `src/components/layout/{SoteriaPanel,Sidebar}.tsx`.

---

## 6. Active State — June 9, 2026 (post-sprint)

The 48-hour post-launch sprint **closed 2026-06-09**: ENGINE-2 (gender rule), S2/SCHED-EDIT-1, and S3 (in-tab TO notify) are all DONE and live-verified; S1/ENGINE-1 is closed-as-diagnosed (no engine bug). The next direction is the **Forward Build Sequence (Phases 1–4)** — see §6.6.

### 6.1 Shipped & verified

- **Watermark launched June 5, 2026.** Employees email `aegis@aegis.quriasolutions.com` for time off and availability.
- **Time-off email workflow** — full chain verified on Watermark (submit → confirm → fan-out to all managers → magic-link or Homebase approve → employee notified; violations rendered in the manager email).
- **Availability email workflow** — full chain verified (submit → confirm → fan-out to all managers → reply-YES approve → `availability` updated → employee notified).
- **Inbound signature verification** ("wax seal") — live, `SKIP_SENDGRID_VERIFICATION=false`.
- **INBOUND-SIG-1 — byte-exact inbound ECDSA fix (shipped this session).** Replaced `@sendgrid/eventwebhook`'s `verifySignature` (which UTF-8-decoded the body before hashing and corrupted non-UTF-8 bytes — e.g. the inline logo image in a quoted **reply** — so inbound replies were 403'd) with `src/security/sendgrid-signature.ts → verifySendGridSignature`, which hashes the exact `timestamp ‖ rawBody` bytes via the same ECDSA primitives. `verify-signature.ts` now calls it; covered by a unit test incl. a binary-body regression. (See doc 04 §1.2.)
- **Quria email brand kit + voice pass (shipped this session).** New `src/messaging/brand.ts` (`brandedEmailShell`, `brandedButtonRow`, `brandActionCard`, `BRAND` palette) is the single source of truth for outbound HTML email — dark Quria frame matching Homebase. Logo is an **inline CID attachment** (`brand-logo.ts`; `email.ts sendEmail` auto-attaches it when the HTML references `cid:quria-logo`) — a hosted-URL logo did not render and was replaced by CID. Every Aegis email + every plain reply (`htmlFromText`) was rebranded and re-voiced to a warm, conclusion-first assistant-manager tone (ask + reassurance ABOVE the action card). (See doc 04 §9.)
- **TO-RERUN-1 — re-check stale TO recommendations + threading + resolution notices (shipped this session).** `recomputeTimeOffRecommendation` re-runs the sim + AI recommendation against current approvals (guards already-decided requests); surfaced via the Homebase "Re-run check" button (`POST /internal/recompute-to-recommendation`), an email-card "Re-run check" magic-link (`recheck_to` → `POST /internal/recheck-to-reply`, responds instantly + recomputes/replies in the background), and the conversational `recheck_time_off` command. Email threading via deterministic per-manager `Message-ID` (`toThreadMessageId`) + `in_reply_to`/"Re:" replies (new `email.ts` `message_id`/`in_reply_to` options). On any-channel approval/denial, `sendDecisionNotification` also posts a "✓ Resolved" reply into each manager's thread (`buildTimeOffResolutionEmail`). Click-guards return a clear "already decided" outcome. (See doc 04 §3.1.)
- **Schedule Engine V2 (2.0.0)** — deployed, dry-run + cascade + banned-pair validated.
- **ENGINE-2 / gender rule (DONE, live).** The bimodal-Headguard-hours cause — the per-shift `attribute_mix` sex swap displacing ranker picks without backfill — was replaced by the facility-wide `sex_coverage` (`scope=concurrent_coverage`, validate-and-flag, no swap). Policy `policy_value_json` flipped; the 6/15 build flattened hours (Lucas 26.3h→15.3h, Erin 6.3h→10.8h) and surfaced a coalesced `unsatisfied_sex_coverage` flag in both the manager email and Homebase `CoverageFlags`.
- **SCHED-EDIT-1 (DONE, Homebase `f28cb30`, live-verified).** Manual schedule moves now persist corrected hours to `schedules.data.assignments` via the shared `resolveAssignment` + `hours` helpers (move handler + save chokepoint).
- **S3 / in-tab TO approval (DONE, Homebase `f8e2505`, sandbox-verified).** In-tab approve/deny now notifies the employee, sets `decided_by`, and toasts the manager — via the shared `decideTimeOffRequest` helper + `POST /api/time-off-decision`; the magic-link path delegates to the same helper.
- Fixed: BUG-1 (TO without shift_requirements), BUG-3 (wrong Homebase URL in outbound), availability manager-notify fan-out (was `.limit(1)`), classifier TO-vs-availability disambiguation.

### 6.2 Open bugs

| ID | Status | Summary |
|---|---|---|
| ENGINE-1 | CLOSED-AS-DIAGNOSED (not an engine bug) | "Aaron Barrigan" = Erin Berigan (one employee); her exclusion was a 15-min availability-precision issue (data-fixed). Residual — 4 Junior Lifeguards at 0h — is **structural** (no JL shift_requirements/canvas slots) and routes to **Role Groups**, not an engine fix. Two product decisions pending: Afternoon shift end-time; whether Watermark schedules Junior Lifeguards. (Full detail in `DEV_ROADMAP.md` S1 + doc 06 §9.) |
| SCHED-EDIT-1 | DONE (Homebase `f28cb30`, live-verified 2026-06-09) | Manual moves now persist corrected hours to `schedules.data.assignments` (shared `resolveAssignment` + `hours` helpers). |
| ENGINE-2 | DONE (live 2026-06-09) | Per-shift `attribute_mix` sex swap replaced by `sex_coverage` (`concurrent_coverage`, validate-and-flag); hours flattened, flag renders in email + Homebase. |
| BUG-4 | OPEN (rule firm) | Audit every employee-facing email template for Homebase CTAs (swap, emergency coverage, onboarding, distribution) and scrub. |
| BUG-5 | OPEN | Stale unconfirmed pending TO silently blocks a new TO submission. Recommended: notify employee + cancel keyword. |
| TENANT-1 | OPEN | Outbound `From` not tenant-aware (apex address + Reply-To works for single-tenant Watermark; breaks at second tenant). |
| DELIV-1 | OPEN | Deliverability hardening (SPF/DKIM/DMARC + sender warm-up) — prerequisite before the 30-person `distribute_schedule` fan-out. |

### 6.3 Launch fast-follows

Remove the Bubba Ganush manager row after rollout monitoring; clear the stray pending test TO + test employees (`aegisscheduler`); availability parser vocabulary hardening (accept dashes/plural days/"through"); availability manager-approval **buttons** (mirror TO magic-link) + a Homebase backstop; `npm audit` (4 vulns / 1 high from the new dep — review, don't blind-fix); strip `[email-trace]`/`[req]` verbose logging and tighten the loose DKIM `' pass'` substring; add a wax-seal timestamp/replay window and remove the dead IP-allowlist fallback.

### 6.4 Deferred features

**Role Groups** (high priority — structural fix for Afternoon Headguard gaps **and** the resolution path for ENGINE-1's Junior-Lifeguard 0h miss; `accepted_roles` exists; build contract-first, engine before UI); `distribute_schedule` / `initiate_onboarding` fan-outs (need DELIV-1 + Carolyn/Jack coordination); Rules-tab UI + Watermark policy migration (incl. `week_start_day='monday'`); max-consecutive-days constraint; `conflict_resolution_preference` wiring; cascade 5-hop/hours-aware paths; TO-R2.5 (multi-request-per-email — now unblocked), TO-R4 (Homebase TO violation UI), TO-R5 (full TO regression cycle). *(The `gender_requirement` policy is no longer dormant — it is live as `sex_coverage`/`concurrent_coverage`; see doc 04 §2.4.)*

### 6.5 Tier-2 backlog

`resolveCompanyId` sole-company fallback footgun; `company_channels` exact-match lookup; ~~`decided_by` not set on in-tab TO approvals~~ (**DONE via S3** — shared `decideTimeOffRequest` helper + `POST /api/time-off-decision` set `decided_by` on the in-tab path); Stripe webhook middleware verification; legacy SMS TO-token migration to `aegis_action_tokens`; audit Homebase `/api/*` for missing auth (→ Phase 1 security); Outlook DKIM CNAMEs; `xlsx → exceljs` for schedule download cell coloring (→ Phase 1 download); route Homebase `notify-assignment` through Aegis (→ Phase 2); mass-fan-out manager gate; multi-turn email context; sandbox seeding-pattern doc; **decide the fate of the inert per-shift `attribute_mix` swap** (`enforceAttributeMixForShift` — keep-as-capability-+-guardrail vs remove; → Phase 3).

### 6.6 Forward Build Sequence (Phases 1–4)

The post-sprint direction (set 2026-06-09; full transcription + 11-note mapping + effort/lane tags live in `DEV_ROADMAP.md`). It supersedes the A/B/C option framing in `PRIORITY2_ANALYSIS.md`.

- **Phase 1 — Harden & fix the live product:** security audit + hardening (Homebase `/api/*` auth, wax-seal replay/timestamp window, remove dead IP-allowlist fallback, RLS + secrets); schedule download working (`xlsx → exceljs` + matching PDF); email deliverability / DELIV-1 (SPF/DKIM/DMARC + warm-up, gates the 30-person fan-out).
- **Phase 2 — Complete the comms loop:** all email workflows up & verified (employee swap/emergency/query, manager beyond `build_schedule`, onboarding); two deliverables on distribute (per-employee shifts **+ full-schedule email**); availability approval in Homebase (magic-link buttons + backstop); route `notify-assignment` through Aegis.
- **Phase 3 — Configurable, correct rules:** rules actually apply (`conflict_resolution_preference`, fairness weight, doubles emergency); Role Groups (`accepted_roles` eligibility + role-preference, engine before UI); Rules-tab UI + configurable rules (TO-rules-as-policy, rule/attribute create-edit); coverage-flag resolver (manager-assisted swap suggestions); decide the inert per-shift swap.
- **Phase 4 — Experience & leverage:** Aegis personability pass; Soteria fully operational (NL control of all Homebase + schedule editing); user guides (two per user type).

**Per-shift-swap decision (Phase 3, logged):** ENGINE-2 retired the per-shift gender swap by *configuration* (flipping Watermark's policy to `concurrent_coverage`), not by removing code. `enforceAttributeMixForShift` still exists and still fires for any tenant with an `attribute_mix`-shape policy — inert for Watermark today, but a footgun (re-adding an `attribute_mix` policy to Watermark would resurrect the bimodal-hours behavior). Decide: (a) keep as a generic capability + a guardrail, or (b) remove if committing to `concurrent_coverage` as the only sex/attribute model.

### 6.7 Cowork autonomous operating model

Development now runs partly through Cowork agents as well as Claude Code, under an explicit operating model (the canonical statement is in both repos' `CLAUDE.md`): a **safe lane** an agent may run unattended (reads of any kind, sandbox-tenant writes, feature-branch code + `tsc` + PR) and **human-gated** actions that always queue for Alexander (merge/push to `main`, any production/Watermark write, prod env-var or policy changes incl. Supabase policy flips, and anything that messages a real employee). Autonomy and credential power trade off — unattended work stays read-only / sandbox-scoped / least-privilege. **DONE-rule: committed ≠ done** — a change is `DONE` only when committed *and* live-verified end-to-end; committed-but-unpushed or pushed-but-unverified is `IN REVIEW`.

---

## 7. A2P / SMS status

10DLC campaign (Low Volume Mixed) resubmitted with the opt-in flow + consent page — **pending Twilio approval**; toll-free verification submitted as the parallel faster path. SMS is therefore not yet the primary channel — **launch is email-first**. Opt-in keywords YES/START/UNSTOP; opt-out STOP/STOPALL/CANCEL/END/QUIT/UNSUBSCRIBE/REVOKE/OPTOUT; HELP/INFO. Support contact `awdarling@quriasolutions.com`. (See the Twilio reference for full campaign field values.)

---

## 8. Cross-cutting principles (do not violate)

Smoke tests must not hit production SendGrid. Read the actual diff before approving a push. Clicking Distribute on a real Watermark schedule fans out to ~30 real employees — never without manager coordination (Carolyn `c45ringler@gmail.com`, Jack `jackmc419@icloud.com`). Alexander's `awdarling@quriasolutions.com` is quria_admin, not an employee — employee intents won't work from it without test setup. Every Aegis-generated string meets the "feels like a person" bar — no "request received", "processing intent", "standby". Verify column names before any write. Keep `SCHEMA_DRIFT_LOG.md` current.

**Doc-refresh trigger** (this v3.0 set was produced under it): refresh when (a) Aegis is live and a second client onboards, (b) `SCHEMA_DRIFT_LOG.md` exceeds ~15 entries, (c) a significant feature like Role Groups needs designing against current schema, or (d) someone other than Alexander joins.

---

## 9. Remote Control (run/steer a session from your phone)

Launch and steer a Claude Code session on the laptop from the Claude mobile app — useful when a long-running build, verify, or research task is mid-flight and you're away from the desk.

**Requirements**

- Claude Code **v2.1.51+** (v2.1.110+ for **push notifications** from the laptop session back to your phone). Upgrade with the same channel you installed from.
- Signed in via **claude.ai** (`/login` inside Claude Code; pick the claude.ai sign-in option). **API keys are not supported** for Remote Control — if `ANTHROPIC_API_KEY` is set in your shell environment, **unset it** for the session: `unset ANTHROPIC_API_KEY` (and remove it from `~/.zshrc`/`~/.bashrc` if it's exported there, so future sessions don't silently fall back to the API-key path).
- Same claude.ai account on the laptop and on the mobile app.

**Enable Remote Control**

- **Per-session:** start the CLI with `claude --rc`.
- **For all sessions:** open `/config` inside Claude Code → **Enable Remote Control for all sessions** → confirm.

**Mobile setup**

- Install the **Claude** mobile app from the App Store / Google Play; sign in with the same claude.ai account.
- Inside Claude Code, run `/config` → enable push notifications. The mobile app will receive a notification when the laptop session needs input or finishes a long-running task.
- Open the mobile app → **Code** tab → select the running laptop session to attach and steer it (send messages, approve tools, read output).

**Gotchas — these will bite if ignored**

- **The laptop must stay awake and on the network.** Mac default sleep, lid-closed sleep, and network-drop-during-sleep all end the remote session. Use `caffeinate -dimsu` in another terminal to keep the machine awake for the duration. **>~10 minutes offline ends the session** — reconnecting from the phone won't recover it; you have to start a new one.
- **Leave sandboxing OFF (the default).** Enabling sandboxing for the session recreates the same failure modes we hit during the Cowork pass: git lock files that can't be cleaned, `npm run build` font/asset errors, network-egress restrictions. Sandboxing OFF is the working configuration.
- **Merge-to-live always stays a human gate.** Remote Control lets you message the session from your phone — it does *not* relax the safety model. Merging a PR to `main` (= deploy to live Watermark) is still a deliberate, on-laptop action you take after reviewing the diff; do not script around it from the phone.
