# Aegis Email Workflows — Path to Production

**Goal**: All Aegis email workflows ready for live client use at Watermark Country Club.

**Status**: **LAUNCHED June 5, 2026.** Time-off and availability email workflows are live and verified end-to-end on the Watermark production tenant. Inbound signature verification is live. Remaining work is fast-follows, deferred risky fan-outs, and the two newly-surfaced scheduling/Homebase bugs.

**Last updated**: June 8, 2026.

---

## Where we are now

Inbound email is authenticated (ECDSA signature verification) and verified. Both core employee→manager workflows (time off, availability) are proven on the real Watermark tenant: submit → confirm → fan-out to ALL managers → approve → employee notified. What remains is pre-fan-out deliverability hardening, a handful of cleanup fast-follows, and the deferred risky workflows (distribute, onboard fan-out).

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
| ENGINE-1 | **OPEN** | Engine V2 silently skips an eligible employee at Watermark (Aaron Barrigan, Headguard, fully available). Engine-eligibility bug (NOT a UI↔Supabase sync issue — the engine reads Supabase directly via the service role). Leading suspects: `qualified_roles` missing/miscased "Headguard", or `max_weekly_hours` 0/null. Diagnose via the gap's `per_employee_dispositions` (`DispositionReasonCode`). |
| SCHED-EDIT-1 | **IN REVIEW** | Manual shift edits on the Homebase Schedule page update the displayed card but do not persist corrected `shift_name`/`start_time`/`end_time` into `schedules.data.assignments`; `distribute_schedule` then sends stale hours. UI-to-data write gap, not an engine bug. **Fix committed** (Homebase `f28cb30`): `resolveAssignmentForSlot` recomputes the full row (sibling-copy, fall back to **shift_types** — verified to match `buildCanvas`) + save-time backstop. Residual fallback-source question CLOSED + independent `tsc` clean (2026-06-09). Only the live edit→reload→distribute round-trip remains. |

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

`resolveCompanyId` sole-company fallback footgun · `company_channels` exact-match lookup falls through to fallback · `TimeOffTab.tsx` doesn't set `decided_by` on in-tab approvals (only the magic-link path does) → **addressed by S3** (shared `decideTimeOffRequest` helper + `POST /api/time-off-decision`, cookie-auth `decided_by`, employee notify, manager toast; magic-link refactored onto the same helper). Built 2026-06-09, uncommitted — pending Alexander diff review + Vercel env confirm + live test · Stripe webhook middleware verification · migrate legacy SMS TO decision tokens to `aegis_action_tokens` · audit all Homebase `/api/*` for missing auth · Outlook 365 DKIM CNAMEs · `xlsx → exceljs` for schedule-download cell coloring · Homebase `notify-assignment` should route through Aegis · mass-fan-out manager gate · multi-turn email context (each reply currently classified fresh) · sandbox seeding-pattern doc · **TO-R2.5** multi-request-per-email (now unblocked — single-request flow verified) · **TO-R4** Homebase manager TO violation UI (violations render in the manager email but not the Time Off tab) · **TO-R5** full TO email regression cycle once BUG-4/BUG-5/TENANT-1 close · **Role Groups** `accepted_roles` audit before building (engine does not currently read it).

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
