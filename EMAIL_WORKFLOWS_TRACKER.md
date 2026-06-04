# Aegis Email Workflows — Path to Production

**Goal**: All Aegis email workflows ready for live client use at Watermark Country Club.

**Estimated effort from current state**: 2–3 focused days.

**Last updated**: June 2, 2026 — end of session diagnostics complete.

---

## Where we are right now

The inbound email pipe is fully verified and one manager intent (`build_schedule`) is working end-to-end with a conversational ack reply. Authentication and identity verification are in place. What remains is methodical workflow validation, UX consistency across all intents, and pre-launch cleanup.

### Overall progress

| Component | Status |
|---|---|
| SendGrid inbound parse → Aegis webhook | DONE |
| IP allowlist verification (`verifySendGridRequest`) | DONE |
| SPF/DKIM authentication gate | DONE |
| Identity verification — quria_admin path | DONE |
| Identity verification — manager path | DONE |
| Identity verification — employee path | UNTESTED |
| `build_schedule` email workflow + ack | DONE |
| Conversational ack as reusable helper | TODO |
| Manager intents beyond `build_schedule` | TODO |
| Employee intents | TODO |
| Reply threading | UNVERIFIED |
| Diagnostic logging stripped | TODO |
| `SKIP_SENDGRID_VERIFICATION` flipped to false | TODO |
| Risky workflow staged validation (distribute, onboard) | DEFERRED |

---

## Phase 1 — Ack pattern refactor

**Objective**: Extract the in-thread acknowledgment logic from `handleBuildSchedule` into a reusable helper so every email-channel intent uses the same pattern.

**Why now**: Every remaining email workflow needs the same ack treatment. Doing this first prevents copy-paste sprawl across five-plus handlers.

### Work
- [ ] Create `sendInThreadAck(message, contact, bodyText)` helper in `src/messaging/reply.ts`
- [ ] Replace the inline ack block in `handleBuildSchedule` with a call to the helper
- [ ] Keep the 3-second delay logic intact

### Stop and test
Send `build schedule` from your work email. Verify:
- Ack reply still arrives in-thread first
- Rich schedule email arrives ~3 seconds later
- Railway logs show the helper's log line firing

**Done when**: Helper exists, build_schedule uses it, prior test still passes.

---

## Phase 2 — Low-risk manager intents

**Objective**: Add the ack pattern to the remaining manager intents and test each end-to-end via email. Test in increasing order of side-effect risk.

### Intents in scope (in order)

1. `query_schedule` — read-only, safest. Manager asks "what's the schedule status?"
2. `homebase_edit` — small benign field change on sandbox employee
3. `approve_time_off` — against a sandbox-employee TO
4. `deny_time_off` — against a different sandbox-employee TO

### Work per intent
- [ ] Verify handler uses `sendInThreadAck` for email channel
- [ ] If not: add the ack call before the work begins
- [ ] End-to-end test via email from work email

### Stop and test (each intent individually — do not batch)

For `approve_time_off` specifically:
1. Insert a pending TO row for sandbox employee with `start_date` next week
2. Send email from work address: "Approve sandbox employee's time off for [date]"
3. Confirm ack reply arrives in-thread within seconds
4. Confirm TO row updates to `status='approved'`
5. Confirm employee notification email is dispatched (will land as "Dropped/Invalid" in SendGrid Activity for `sandbox-employee@example.com` — that's fine, we're verifying it was sent)
6. Confirm activity_log entry exists

**Done when**: All four intents tested green individually.

---

## Phase 3 — Employee submission flow

**Objective**: Validate the most operationally important employee-side path — submitting time off via email and the manager notification chain.

This is the first real test of the employee branch of `lookupContact` (the only identity-verification path not yet exercised).

### Setup
- [ ] Decide on test employee approach. Options:
  - (a) Create an Outlook alias `aegis-test-employee@quriasolutions.com` you control, and set it as the `contact_email` on the existing sandbox employee
  - (b) Create a fresh sandbox employee record in Watermark with that email
  - (c) Use a real personal email you control (e.g., xander.w.darling@gmail.com) — but this requires temporarily registering it as a Watermark employee, which complicates the cleanup

  **Recommendation**: option (b). Clean separation from existing sandbox data.

### Work
- [ ] Verify `submit_time_off` email handler uses `sendInThreadAck`
- [ ] Confirm manager notification email contains valid Approve/Deny magic-link buttons
- [ ] Confirm the magic-link → handler → confirmation chain works end-to-end

### Stop and test

Full chain:
1. Send TO request email from test employee inbox to `aegis@aegis.quriasolutions.com`. Subject: "Time off request". Body: "I need Friday June 12 off."
2. Verify ack reply arrives at test employee inbox: "Got your time-off request..."
3. Verify Aegis sends pending confirmation: "Got it — you're requesting [date] off. Reply yes to confirm."
4. Reply `yes` from test employee inbox
5. Verify TO row inserted in DB
6. Verify your work email receives manager notification with Approve/Deny buttons
7. Click Approve from work email
8. Verify TO row updates to `status='approved'`
9. Verify test employee inbox receives approval confirmation

**Done when**: Full eight-step chain passes.

---

## Phase 4 — Reply threading

**Objective**: Verify that when a manager replies to one of Aegis's emails (rather than starting a new thread), the reply lands at the webhook with the correct `thread_id` and routes correctly.

The Reply-To header was added in Phase 4b last night. The mechanism itself has never been tested end-to-end.

### Work
- [ ] Trigger any workflow that produces an Aegis reply (e.g., `query_schedule`)
- [ ] Reply to that email with a processable message: "Build that schedule for next week."
- [ ] Watch Railway logs for inbound webhook with `thread_id` matching the original

### Stop and test
The reply should be processed exactly as a fresh email would be — intent classification runs, appropriate handler dispatches. The difference is the `thread_id` should match the original conversation.

**Done when**: Reply produces same handler behavior as a fresh email and the conversation stays threaded in your inbox.

---

## Phase 4.5 — Tenant-aware outbound + reply threading

**Objective**: Outbound emails must use the From address matching the tenant's inbound channel, propagate Reply-To, and maintain email threading via In-Reply-To/References headers so conversations stay in one Gmail/Outlook thread.

**Why now**: Discovered during sandbox testing (June 4). When sandbox-tenant employees reply to Aegis, Gmail auto-fills the From address (aegis@aegis.quriasolutions.com — Watermark's channel). Reply gets rejected because the sender doesn't exist on Watermark. Cross-tenant isolation works correctly, but the From address routes replies to the wrong tenant. Within a single tenant, threading also needs verification — confirmation chains may be breaking out of the original thread.

### Work

- [ ] Audit current `sendEmail()` signature in `src/messaging/email.ts`
- [ ] Modify signature to accept `companyId` (or precomputed `fromAddress`)
- [ ] Look up tenant's email channel from `company_channels` (channel_type='email')
- [ ] Use that address as the `From` header on outbound
- [ ] Set `Reply-To` header to the same address (belt and suspenders for clients that distinguish)
- [ ] Verify In-Reply-To and References headers propagate on every outbound reply
- [ ] Audit every `sendEmail` call site and pass tenant context — handlers, workflows, notification helpers
- [ ] Verify subject preservation (with "Re:" prefix) for thread continuity

### Stop and test

1. Send a fresh TO request from sandbox employee
2. Confirm From address on confirmation reply equals `sandbox@aegis.quriasolutions.com`
3. Reply `yes` via Gmail Reply button (no manual address composition)
4. Verify webhook receives at `sandbox@...` not `aegis@...`
5. Verify conversation stays in a single Gmail thread (no thread splitting)
6. Manager notification arrives in correctly threaded position for that tenant

**Done when**: Sandbox test passes end-to-end using only the Reply button — no manual address composition needed, all messages threaded.

---

## Phase 5 — Pre-launch cleanup

**Objective**: Strip diagnostic noise and tighten security toggles before going live.

### Work
- [ ] Remove `[req]` global request logger from `src/index.ts` (it logs every health check)
- [ ] Remove all `[email-trace]` log statements from `src/webhooks/email.ts` (12 statements in handler)
- [ ] Keep `[email-auth]` logs (legitimate audit trail for authentication outcomes)
- [ ] Keep `[sendgrid-verify]` logs (legitimate audit trail for IP allowlist decisions)
- [ ] Tighten DKIM substring check in `src/webhooks/email.ts` from `' pass'` to regex `/:\s*pass\b/` (agent flagged this earlier — the loose substring would match unusual strings)
- [ ] In Railway, set `SKIP_SENDGRID_VERIFICATION=false`
- [ ] Decide on `resolveCompanyId` fallback: delete the "sole email-configured company" silent fallback OR add an explicit guardrail that only allows it when exactly one company is email-configured

### Stop and test

Send `build schedule` from work email after cleanup deploy. Verify:
- Workflow still completes end-to-end
- Railway logs are quiet — only `[sendgrid-verify] ip allowlisted` and `[email-auth] authenticated` and the workflow's own logs
- No `[req]` flood from health checks
- No `[email-trace]` chatter

If verification rejects legitimate mail at this point → bug, investigate the IP allowlist.

**Done when**: Same workflow that worked yesterday still works, logs are clean.

---

## Phase 6 — Production smoke test

**Objective**: Final pre-deployment verification with production-shaped config.

### Work
- [ ] Send `query schedule` from work email — confirm response
- [ ] Send `build schedule` from work email — confirm ack + result chain
- [ ] Submit a TO from test employee inbox — confirm employee/manager chain
- [ ] Reply to one Aegis email — confirm threading

**Done when**: All four green with clean logs.

---

## Phase 7 — Risky workflow staged validation

**Objective**: Validate the workflows that fan out to real Watermark employees. These cannot be tested in sandbox — they require real production data and real recipients.

### Workflows in this bucket
- `distribute_schedule` — clicking Distribute on a built schedule emails all 30 Watermark employees their assignments
- `initiate_onboarding` (fan-out mode) — sends opt-in messages to every active employee without a completed onboarding session
- `notify_day_closure` — already exists, triggered from Homebase UI, but still fans out to affected employees

### Strategy
**Coordinate with Carolyn and Jack first.** Pick a time when employees are expecting a real schedule.

1. Build next week's schedule via email
2. Verify the schedule contents look correct in the result email
3. Notify Carolyn and Jack that you're about to test live distribution
4. Click Distribute Schedule
5. Confirm all 30 employees receive their assignments
6. Monitor for any bounce/error/wrong-content reports

**Do not run this phase without manager coordination.**

---

## Active Bugs (discovered during sandbox testing)

### BUG-1: Time-off creation blocked when `shift_requirements` is empty — HOTFIX

Discovered June 4. After replying `yes` to a TO confirmation, Aegis responded: "Your request has been noted, but the scheduling system doesn't have shift requirements configured yet. Please ask your manager to set up shift requirements in Homebase before submitting time-off requests."

**Diagnostic confirmed**: no TO row inserted in `time_off_requests`, no manager notification sent. The guard prevents the entire flow.

Time-off requests must be creatable independently of `shift_requirements`. Coverage simulation can be skipped silently if no shifts exist. The TO row must still insert and the manager must still be notified. Any brand-new client trying to submit TO during onboarding (before shifts are configured) hits this wall.

**Priority**: must fix before continuing Phase 3 testing. Blocks all sandbox TO validation.

#### Work
- [ ] Locate the source of the error string in `handleConfirmPending`, `handleSubmitTimeOff`, or the schedule simulator
- [ ] Determine whether the guard prevents TO insertion entirely or only blocks the simulator (sounds like the former)
- [ ] Refactor: TO insertion must run regardless of `shift_requirements` presence
- [ ] Simulator call should be wrapped: if no shifts exist, skip silently with internal log only, do not surface to user
- [ ] Manager notification must dispatch regardless
- [ ] Re-test the sandbox TO chain to confirm fix

### BUG-2: Sandbox has no `shift_requirements` — data gap

Not a code bug. Need to seed sandbox with a representative shift configuration so the simulator can be exercised in tests. Recommended seed:

```sql
INSERT INTO public.shift_requirements
  (company_id, shift_name, role, required_count, start_time, end_time, days_active)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'PM', 'Lifeguard', 1,
   '15:00', '21:00', ARRAY[0,1,2,3,4,5,6]);
```

Apply this regardless of BUG-1 fix — once BUG-1 is fixed and TOs create successfully, this seed lets us test the simulator and violation flagging end-to-end.

---

## Tier reference — where each known item stands

### Tier 0 (blocking for relaunch)

| Item | Status | Resolution |
|---|---|---|
| SPF/DKIM authentication gate | DONE | Shipped this session |
| IP allowlist verification | DONE | Shipped this session |
| Inbound email path verification | DONE | Verified this session |
| Strip diagnostic logging | TODO | Phase 5 |
| Lock down `SKIP_SENDGRID_VERIFICATION=false` | TODO | Phase 5 |
| Tighten DKIM regex | TODO | Phase 5 |
| All email intents using ack pattern | TODO | Phases 1–3 |
| End-to-end test every intent | TODO | Phases 2–3 |
| Tenant-aware outbound From + threading | TODO | Phase 4.5 |
| TO creation blocked by missing shift_requirements (BUG-1) | TODO | HOTFIX before Phase 4.5 |

### Tier 2 (nice-to-have, post-launch)

| Item | Notes |
|---|---|
| `resolveCompanyId` "sole email-configured company" fallback | Footgun when second tenant onboards |
| `company_channels` exact-match lookup bug | Falls through to fallback when it should hit exact match |
| `TimeOffTab.tsx` doesn't populate `decided_by` on manager UI approvals | Only magic-link path sets it |
| Stripe webhook middleware question | `/api/stripe/webhook` may be silently failing in middleware redirect — unverified |
| Migrate legacy SMS-channel TO decision tokens | Move to unified `aegis_action_tokens` system |
| Audit all Homebase `/api/*` endpoints for missing auth | Same class as the original `/api/aegis-action` fix |
| DKIM CNAMEs for Outlook 365 | From admin.microsoft.com — improves outbound deliverability |
| xlsx → exceljs swap | Proper cell coloring in schedule downloads |
| Homebase `notify-assignment` calls Twilio directly | Should route through Aegis for consistency |
| Mass fan-out code paths need explicit manager gate | Same pattern as Phase 2 notify safety guard |
| Update stale reference docs | Multiple schemas in `/mnt/project/*.docx` are out of date |
| Sandbox test data cleanup | Consumed tokens, finished sandbox TOR/schedule rows |
| Orphan smoke data in `aegis_action_tokens` | `manager-smoke@test.local`, fake schedule UUID |
| Generalize ack pattern to SMS? | Decision needed — does "Got it, building..." via SMS add value or just double message volume? |
| Multi-turn email conversations | Aegis remembers context across replies — currently each reply is classified fresh |

---

## Daily plan suggestion

### Day 1
- Phase 1 — Ack refactor (1–2 hours including testing)
- Phase 2 — Manager intents (2–3 hours, paced by sandbox setup)

### Day 2
- Phase 3 — Employee submission flow (2–3 hours including test inbox setup)
- Phase 4 — Reply threading (1 hour)
- Phase 5 — Cleanup (1 hour)

### Day 3
- Phase 6 — Production smoke test (30 min)
- Phase 7 — Coordinate with Carolyn and Jack; schedule the live distribute test
- Begin Tier 2 backlog after live launch confirms stable

---

## Cross-cutting principles

Reminders carried forward from prior sessions, do not violate during this work:

- Smoke tests must not hit production SendGrid — sandbox subuser or full mock required
- Read actual diff before approving any push, not just the agent's report
- Clicking Distribute on a real Watermark schedule fans out to 30 real employees — never test that during off-hours or without manager coordination
- Watermark managers for coordination: Carolyn Ringler (c45ringler@gmail.com), Jack McCorkle (jackmc419@icloud.com)
- Alexander's work email (awdarling@quriasolutions.com) is quria_admin, not an employee — `submit_time_off` and other employee intents won't work from his address without test setup
- The "feels like a person" tone bar applies to every Aegis-generated string. No "request received." No "processing intent." No "standby."
- One Soteria action per response (Homebase rule, but worth remembering — same care applies to email response shape)
