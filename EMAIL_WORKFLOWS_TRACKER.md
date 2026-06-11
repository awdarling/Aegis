# Aegis Email Workflows — Path to Production

**Goal**: All Aegis email workflows ready for live client use at Watermark Country Club.

**Status**: **LAUNCHED June 5, 2026.** Time-off and availability email workflows are live and verified end-to-end on the Watermark production tenant. Inbound signature verification is live. Remaining work is fast-follows, deferred risky fan-outs, and the two newly-surfaced scheduling/Homebase bugs.

**Last updated**: June 9, 2026.

> **Push state (top-of-file):** Aegis is pushed and live (`46eaa70`). Homebase is pushed and live (`29ed00e`). **48-hour sprint COMPLETE (2026-06-09):** SCHED-EDIT-1 round-trip persists corrected hours; `unsatisfied_sex_coverage` flag renders in BOTH the manager schedule-preview email AND the Homebase Preview & Edit view; S3 in-tab TO approval verified in sandbox (notify fired, `decided_by` written, manager toast).

---

## Where we are now

Inbound email is authenticated (ECDSA signature verification) and verified. Both core employee→manager workflows (time off, availability) are proven on the real Watermark tenant: submit → confirm → fan-out to ALL managers → approve → employee notified. What remains is pre-fan-out deliverability hardening, a handful of cleanup fast-follows, and the deferred risky workflows (distribute, onboard fan-out).

> **Forward Build Sequence mapping (set 2026-06-09):** the remaining **TODO / UNTESTED** intents and workflows in this tracker — every employee intent not yet end-to-end-tested (swap, emergency coverage, query), manager intents beyond `build_schedule`, the onboarding fan-out, and the risky `distribute`/`onboard` fan-outs below — belong to **Forward Build Sequence Phase 2 ("Complete the comms loop")** in `DEV_ROADMAP.md`. (Note: that is the roadmap's *Phase 2*, distinct from this tracker's own internal "Phase" numbering 1–7 below. The deliverability/DELIV-1 prerequisite is roadmap **Phase 1**.)

### Overall progress

| Component | Status |
|---|---|
| SendGrid inbound parse → Aegis webhook | DONE |
| IP allowlist verification (`verifySendGridRequest`) | DONE (now superseded by ECDSA as primary) |
| SPF/DKIM authentication gate | DONE |
| **Inbound ECDSA signature verification ("wax seal")** | **DONE — live June 5, `SKIP_SENDGRID_VERIFICATION=false`** |
| Identity verification — quria_admin / manager / employee paths | DONE (all three exercised) |
| `build_schedule` email workflow + ack | DONE |
| Conversational ack reusable helper (`sendInThreadAck`) | DONE |
| Manager intents (query_schedule, homebase_edit, approve/deny TO) | DONE |
| Employee intents (submit_time_off, update_availability) | DONE |
| Availability manager-notify fan-out to ALL managers | DONE — fixed June 5 (was `.limit(1).maybeSingle()`) |
| Reply threading (single-tenant) | DONE via Reply-To; multi-tenant From open (TENANT-1) |
| Diagnostic logging stripped (`[email-trace]`, `[req]`) | TODO (fast-follow) |
| Risky fan-outs (distribute, onboard) | DEFERRED — Phase 7, gated on DELIV-1 + coordination |

---

## Completed phases (condensed — full step-by-step test scripts in git history)

- **Phase 1 — Ack pattern refactor.** DONE. `sendInThreadAck(message, contact, bodyText)` extracted; in-thread ack lands first, rich email follows.
- **Phase 2 — Low-risk manager intents.** DONE. `query_schedule`, `homebase_edit`, `approve_time_off`, `deny_time_off` each tested individually.
- **Phase 3 — Employee submission flow.** DONE. Full submit → confirm → manager-notify → approve → employee-confirmation chain verified (TO). Employee branch of identity verification exercised.
- **Phase 4 — Reply threading.** DONE for single tenant (Reply-To added; replies route + thread correctly).
- **Phase 5 — Pre-launch cleanup.** PARTIAL. `SKIP_SENDGRID_VERIFICATION=false` set (DONE). **Still TODO:** remove `[req]` global logger from `src/index.ts`; remove `[email-trace]` statements from `src/webhooks/email.ts` (keep `[email-auth]` and `[sendgrid-verify]`); tighten DKIM substring `' pass'` → regex `/:\s*pass\b/`; decide `resolveCompanyId` sole-company fallback (delete or guard to exactly-one-email-tenant).
- **Phase 6 — Production smoke.** Effectively satisfied by the live launch (query/build/TO/threading all exercised in production).

---

## Open phases

### Phase 4.5 — Tenant-aware outbound From + threading (TENANT-1) — OPEN

Outbound `From` is still the apex `aegis@quriasolutions.com` with `Reply-To` carrying the routing address. Works for single-tenant Watermark; **breaks reply routing the moment a second tenant onboards.** Fix: `sendEmail()` accepts `companyId` (or precomputed `fromAddress`); look up the tenant's email channel from `company_channels` (`channel_type='email'`, column `channel_value`); set `From` and `Reply-To` to it; verify `In-Reply-To`/`References` propagate; audit every `sendEmail` call site to pass tenant context. Not launch-blocking for Watermark alone.

### Phase 6.5 — Email deliverability hardening (DELIV-1) — OPEN

Outbound from `aegis.quriasolutions.com` must inbox, not spam. First-contact sends to Gmail landed in spam during sandbox testing. Required before the 30-person `distribute_schedule` fan-out. Work: verify SPF includes SendGrid IPs; confirm DKIM signing; add DMARC (`p=none` → escalate); SendGrid event webhook → `email_events` table for delivery/bounce/spam monitoring; staggered sender warm-up runbook. Done when ≥80% of first-contact sends to major providers inbox.

### Phase 7 — Risky workflow staged validation — DEFERRED (gated on DELIV-1 + manager coordination)

`distribute_schedule` (emails all ~30 Watermark employees), `initiate_onboarding` fan-out, `notify_day_closure` fan-out. **Never run without coordinating with Carolyn and Jack**, and not before DELIV-1.

---

## Active Bugs

### Email-workflow bugs

| ID | Status | Summary |
|---|---|---|
| BUG-1 | **DONE** (June 4) | TO creation no longer blocked when `shift_requirements` is empty; simulator wrapped in try/catch, TO inserts + manager notified regardless. |
| BUG-2 | **DONE** (June 4) | Sandbox seeded with a representative `shift_requirements` row (PM Lifeguard, `accepted_roles=ARRAY['Lifeguard']`). |
| BUG-3 | **DONE** | Outbound links corrected from dead `homebase-liart` to `homebase-nine-phi`; magic-link Approve verified working. |
| BUG-4 | **OPEN** (rule firm) | Audit every employee-facing email template (TO confirmation, approved/denied, distribution, swap, emergency coverage, onboarding) for "View in Homebase" CTAs and scrub. Homebase CTAs belong only in manager-facing templates. |
| BUG-5 | **OPEN** | Stale unconfirmed pending TO in `aegis_memory` silently short-circuits a new `submit_time_off` (no user feedback). Recommended: on a new submit with an existing pending, notify the employee + offer a cancel keyword ("START OVER"). |

### Scheduling / Homebase bugs (outside email scope — recorded here for visibility; canonical board in 05_Development_Guide §6.2)

| ID | Status | Summary |
|---|---|---|
| ENGINE-1 | **CLOSED-AS-DIAGNOSED** (not an engine bug) | The two named cases dissolved: "Aaron Barrigan" = Erin Berigan (one employee), whose exclusion was a 15-min availability-precision issue (data-fixed + verified). The residual — 4 Junior Lifeguards at 0h — is **structural** (no `Junior Lifeguard` shift_requirements / canvas slots) and routes to **Role Groups**, not an engine fix. Two product decisions pending (Afternoon shift end-time; whether Watermark schedules Junior Lifeguards). Canonical detail in `DEV_ROADMAP.md` S1 + doc 06 §9. |
| SCHED-EDIT-1 | **DONE** | Manual shift edits on the Homebase Schedule page update the displayed card but do not persist corrected `shift_name`/`start_time`/`end_time` into `schedules.data.assignments`; `distribute_schedule` then sends stale hours. UI-to-data write gap, not an engine bug. Fix committed (Homebase `f28cb30`): `resolveAssignmentForSlot` recomputes the full row (sibling-copy, fall back to **shift_types** — verified to match `buildCanvas`) + save-time backstop. Homebase pushed (`29ed00e`) and **live-verified 2026-06-09:** a manual assignment move round-trips the corrected hours to `schedules.data.assignments`. (Live `distribute` against real data still gated by distribution rules + DELIV-1, but the data axis is correct.) |
| ENGINE-2 | **DONE** | Bimodal Headguard hours (Lucas 26.3h / Erin 6.3h / Kori 6.3h / Michael 6.3h) root-caused to the post-fill per-shift `attribute_mix` sex swap displacing ranker picks without backfill — NOT a fairness bug. Replaced with `sex_coverage` (scope=`concurrent_coverage`, validate-and-flag, no swap). Policy `policy_value_json` flipped. **Fully live-verified on the 6/15 Watermark build:** Lucas 26.3h→15.3h, Erin 6.3h→10.8h; coalesced `unsatisfied_sex_coverage` flag renders in BOTH the manager schedule-preview email AND the Homebase Preview & Edit view (`CoverageFlags` mounted in the UpcomingCard preview, Homebase pushed at `29ed00e`). The retired per-shift swap code still exists generically (inert for Watermark) — fate logged as a Tier 2 decision. |

---

## Tier reference

### Tier 0 (was blocking for relaunch — now resolved unless noted)

| Item | Status |
|---|---|
| SPF/DKIM authentication gate | DONE |
| IP allowlist verification | DONE |
| Inbound email path verification | DONE |
| Inbound ECDSA signature verification | DONE (live) |
| Strip diagnostic logging | TODO (Phase 5 fast-follow) |
| Lock `SKIP_SENDGRID_VERIFICATION=false` | DONE |
| Tighten DKIM regex | TODO (Phase 5 fast-follow) |
| All email intents using ack pattern | DONE |
| End-to-end test every intent | DONE (TO + availability + manager intents) |
| Tenant-aware outbound From + threading (TENANT-1) | OPEN (not blocking single-tenant) |
| TO blocked by missing shift_requirements (BUG-1) | DONE |
| Wrong Homebase URL (BUG-3) | DONE |
| Employee emails reference Homebase (BUG-4) | OPEN |
| Stale pending TO blocks new requests (BUG-5) | OPEN |
| Email deliverability hardening (DELIV-1) | OPEN (before Phase 7 fan-out) |

### Launch fast-follows (post June 5)

- Remove Bubba Ganush's Watermark manager row after rollout monitoring (see TEST_IDENTITIES.md).
- Clear the stray pending test TO + remove the `aegisscheduler` test employee from Watermark.
- Availability parser vocabulary hardening — accept dashes/en-dashes, plural day names ("Mondays"), "through"/"-" variants (phones autocorrect `-`→`–`). Currently requires singular day + "to".
- Availability manager-approval **buttons** (mirror the TO magic-link via `aegis_action_tokens`) + a Homebase backstop — retire the fragile reply-YES path.
- `npm audit` — 4 vulns / 1 high from the `@sendgrid/eventwebhook` dependency; review (do NOT blind `audit fix` near launch).
- Wax-seal hardening: timestamp-freshness/replay window; remove the dead IP-allowlist fallback + `SKIP_SENDGRID_VERIFICATION` flag once stable.

### Tier 2 (post-launch backlog)

`resolveCompanyId` sole-company fallback footgun · `company_channels` exact-match lookup falls through to fallback · `TimeOffTab.tsx` doesn't set `decided_by` on in-tab approvals (only the magic-link path does) → **DONE via S3** (shared `decideTimeOffRequest` helper + `POST /api/time-off-decision`, cookie-auth `decided_by`, employee notify, manager toast; magic-link refactored onto the same helper). Committed 2026-06-09 (Homebase `f8e2505`), Homebase pushed (`29ed00e`), Vercel env (`AEGIS_URL` / `AEGIS_INTERNAL_SECRET`) confirmed, **sandbox approve-TO round-trip verified 2026-06-09** (notify fired, `decided_by` written, manager toast) · Stripe webhook middleware verification → **DIAGNOSED 2026-06-09 (SEC-3 in `DEV_ROADMAP.md`)**: Homebase middleware does not list `/api/stripe/webhook` in `isPublic`, so unauthenticated Stripe POSTs may be 307-redirected to `/login` and silently never process; fix shape = add the route to `isPublic` or exclude `/api/stripe/*` from the matcher; verify against live Stripe delivery logs (200 vs 307 on recent events) · migrate legacy SMS TO decision tokens to `aegis_action_tokens` · audit all Homebase `/api/*` for missing auth → **substantially complete via Phase-1 audit 2026-06-09** (branch `security/api-auth-audit` on Homebase, per-endpoint table in `SECURITY_AUDIT_API.md`): 4 routes guarded `IN REVIEW` (`soteria-validate-assignment`, `soteria-validate-schedule`, `payroll/test-payroll-provider`, `payroll/test-timeclock`); not yet live-verified; SEC-1..SEC-4 formalized in `DEV_ROADMAP.md` Phase 1 — 4 guarded routes IN REVIEW, 2 decision-gated (SEC-1 access model DECIDED + IN REVIEW on `security/create-user-authz`; SEC-2 Stripe billing NOT STARTED), 1 functional (SEC-3 above), 1 verification (SEC-4 `aegis_action_tokens` TTL/entropy) · Outlook 365 DKIM CNAMEs · `xlsx → exceljs` for schedule-download cell coloring · Homebase `notify-assignment` should route through Aegis · mass-fan-out manager gate · multi-turn email context (each reply currently classified fresh) · sandbox seeding-pattern doc · **TO-R2.5** multi-request-per-email (now unblocked — single-request flow verified) · **TO-R4** Homebase manager TO violation UI (violations render in the manager email but not the Time Off tab) · **TO-R5** full TO email regression cycle once BUG-4/BUG-5/TENANT-1 close · **Role Groups** `accepted_roles` audit → **AUDITED 2026-06-09**: on `main` the engine does NOT read `accepted_roles` (eligibility matches `slot.role` against `qualified_roles` only); on branch `role-groups-engine` (Aegis, **DRAFT**, not live) the engine reads it for eligibility (intersection with `qualified_roles`) + a `resolveAssignedRole` preference rule, with canvas falling back to `[role]` for back-compat. Cross-ref `DEV_ROADMAP.md` Role Groups (Phase 3) + `SCHEMA_DRIFT_LOG.md` session-5 (the `db/types.ts` optional-vs-NOT-NULL caveat).

**2026-06-10 verification update (Phase 1, branch-only — still IN REVIEW, not live):** `xlsx → exceljs` schedule-download → **VERIFIED WORKING** (sample `.xlsx` from the new exceljs renderer opened/inspected: dark header, red `UNFILLED` gap cells, grey merged `CLOSED` column, frozen panes present in the file). The `/api/*` auth audit (4 guarded routes) + SEC-1 `create-user` → **LOGIC VERIFIED via automated test, 22/22 cases** (anon=401 / own-company=allowed / cross-company=403 on the 4 guarded routes; `create-user` role-cap + owner company-binding / quria-any-company / garbage-role=400); the two security branches proven clean-merge via `git merge-tree`. Remaining gate to DONE for all three: merge + deploy (+ deploy-time real-login smoke for the security routes). NOTE: verification used a **throwaway** `test/security-verify` branch (vitest harness) — do NOT merge it; merge the two original security branches. Homebase still has no committed test runner — see `DEV_ROADMAP.md` Tier-3 (adopt vitest + port the auth test).

**2026-06-10 PRODUCTION DEPLOY + 2 post-deploy bugs:** Phase-1 batch merged into Homebase `main` via **PR** → Watermark production (Vercel). **DONE (deployed + verified):** `/api/*` auth audit (4 route guards) + SEC-1 `create-user` authz. **DEPLOYED but not DONE:** `xlsx → exceljs` schedule download — styling not observable in prod because the download 500s on real data (`DOWNLOAD-500`). **Operating-model change:** Homebase `main` is now PROTECTED (PR required, not a direct push); `05_Development_Guide` §4 ("push to main") is now wrong — flagged for reference-doc refresh. **New PRE-EXISTING bugs (neither caused by the deploy):** `DOWNLOAD-500` (Excel AND PDF 500 on real data — throw in shared `buildScheduleGrid`, prime suspect null/empty `employee_name`, likely SCHED-EDIT-1 residue; DIAGNOSED, fix in flight) and `DELETE-USER` (Access-page `handleRevoke` uses anon client, swallows the error, deletes only `public.users`; old users blocked by FK constraints; DIAGNOSED, needs soft-delete-vs-reassign decision + server route + `auth.admin.deleteUser`). Full diagnoses + proposed fixes in `DEV_ROADMAP.md` Phase 1.

---

## Cross-cutting principles (carry forward — do not violate)

- Smoke tests must not hit production SendGrid — sandbox subuser or full mock.
- Read the actual diff before approving any push.
- Clicking Distribute on a real Watermark schedule fans out to ~30 real employees — never without manager coordination (Carolyn `c45ringler@gmail.com`, Jack `jackmc419@icloud.com`).
- `awdarling@quriasolutions.com` is quria_admin, not an employee — employee intents need test setup.
- "Feels like a person" tone on every Aegis string — no "request received", "processing intent", "standby".
- One Soteria action per response.
- Always verify column names via `information_schema` before any INSERT/UPDATE — and remember `src/db/types.ts` is itself incomplete (missing `employees.sex`, `shift_requirements.accepted_roles`). See SCHEMA_DRIFT_LOG.md.
- Classifier prompts must inject today's date (timezone-aware via `Intl.DateTimeFormat('en-CA', { timeZone: companyTimezone })`) — year-drift is a recurring class.
- Employee emails never link to Homebase (BUG-4 rule).
- The schedule build is deterministic and LLM-free — no `withAnthropicRetry` there; it wraps intent classification and response generation only.

---

## Note on `tracker_update.md`

The standalone `tracker_update.md` scratch file (Phase 4.5 scoping + BUG-1/BUG-2) is **superseded** — its content is folded into this tracker (Phase 4.5 above, BUG-1/BUG-2 DONE). Safe to archive/delete from the repo root.
