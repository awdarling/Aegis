# Aegis Email Workflows — Path to Production

**Goal**: All Aegis email workflows ready for live client use at Watermark Country Club.

**Status**: **LAUNCHED June 5, 2026.** Inbound signature verification is live. The **time-off** email round-trip (employee submit → confirm → manager fan-out → manager approve via magic-link button → employee notified) is verified end-to-end on the Watermark production tenant. The **availability** path is **partially verified**: the employee→manager NOTIFY fan-out is live and verified (Phase 4 + the June-5 fan-out fix), but the manager-side **approve/deny magic-link buttons are NOT built** — those handlers are dead stubs that return a fake success page and no email mints availability tokens today. The current manager-approval path for availability is the fragile reply-YES + Homebase-tab path; the magic-link buttons are scoped under AEGIS-EMAIL-1. Remaining work is fast-follows, deferred risky fan-outs, the two newly-surfaced scheduling/Homebase bugs, and the AEGIS-EMAIL-1 umbrella.

**Last updated**: June 18, 2026.

> **Push state (top-of-file):** Aegis is pushed and live (`46eaa70`). Homebase is pushed and live (`29ed00e`). **48-hour sprint COMPLETE (2026-06-09):** SCHED-EDIT-1 round-trip persists corrected hours; `unsatisfied_sex_coverage` flag renders in BOTH the manager schedule-preview email AND the Homebase Preview & Edit view; S3 in-tab TO approval verified in sandbox (notify fired, `decided_by` written, manager toast). **2026-06-12:** schedule download DONE on Watermark (Piece 1 colors + full-name/role content fix both merged; live-verified); **`DOWNLOAD-500` RESOLVED** (symptom gone in prod — mechanism caveat: exact root-cause line not independently re-confirmed); **`distribute_schedule` fan-out ran successfully to the full Watermark roster** (warm per-employee shift-assignment message + inline full-week schedule) — only remaining distribute piece is a visual-consistency fix vs. the Homebase render (= template-unification **Piece 3**); **DELIV-1 downgraded BLOCKER → MONITOR / client-education** (fan-out ran with no spam problem; kept as a watch item, not a gate). **Active priority: build + test the remaining Aegis email workflows at Watermark** (AEGIS-EMAIL-1).

> **AEGIS-EMAIL-1 umbrella (set 2026-06-10) — current Now/Next #2 in `DEV_ROADMAP.md`.** Verify + fix + **test** every Aegis email-action workflow end-to-end (email → magic-link → `/api/aegis-action` → correct DB effect + notify): the 8 `ActionType`s in `src/lib/aegis-actions/types.ts` — `approve_to`, `deny_to`, `approve_availability`, `deny_availability`, `accept_emergency_coverage`, `decline_emergency_coverage`, `confirm_distribution`, `request_additional_batch`. Per-workflow status to be tracked below as each is exercised; each `DONE` requires (a) a sandbox round-trip producing the expected DB effect + notification AND (b) a committed automated test. Homebase has no test runner yet (tracked Tier-3) — standing one up may be a prerequisite. Token layer itself is sound (SEC-4 verified); this is the workflows themselves.

### AEGIS-EMAIL-1 — email-action status grid (set 2026-06-11)

Per-action status of the 8 `ActionType`s in `src/lib/aegis-actions/types.ts`. Drives the AEGIS-EMAIL-1 work list in `DEV_ROADMAP.md`. **3 of 8 wired end-to-end; 5 are dead stubs** (handlers return a fake success page; no email mints these tokens). Re-prioritized direction: `confirm_distribution`'s magic-link path is being **retired** (distribute moves to conversational command + Homebase button), so it won't graduate from this grid — it gets removed.

| Action | Status | Notes |
|---|---|---|
| `approve_to` | **WORKING (prod-verified)** | 21 Watermark consumptions; email → magic-link → DB update + employee notify. |
| `deny_to` | **BUILT, email-button UNVERIFIED** | In-app Time Off tab deny works (S3 / `decideTimeOffRequest`); the email-button path has not been observed consumed. Alexander testing 2026-06-11. |
| `confirm_distribution` | **RETIRED → replaced by Publish button (2026-06-18)** | Magic-link path dropped as planned. Distribute is now the Homebase **Publish** button keyed on `published_at` (status-clobber bug closed). See the 2026-06-18 SHIPPED block above. |
| `approve_availability` | **BUILT (verified-in-code 2026-06-28)** | STUB note is stale. `buildAvailabilityManagerEmail` mints the token; Homebase `dispatcher.ts` → `POST /internal/apply-availability-decision` → `applyAvailabilityDecision` (real DB write + employee notify). Tested in `availability-magic.test.ts`. Live sandbox eyeball still owed. |
| `deny_availability` | **BUILT (verified-in-code 2026-06-28)** | Same real path as `approve_availability` (DENY branch). |
| `approve_custom_availability` | **BUILT (verified-in-code 2026-06-28 — DEV_ROADMAP #13)** | "Until/through" date boundary or rotating phrasing → `handleUpdateAvailability` branches date-limited/rotating → manager magic-link mints this token (full snapshot payload) → Homebase `dispatcher.ts` handles it → `POST /internal/apply-custom-availability-decision` → `applyCustomAvailabilityDecision` writes the `custom_availability` override (date_limited or rotating) + notifies employee, **no Homebase link**. `custom_availability` columns verified vs live `information_schema`. Intake now tested (`custom-availability-magic.test.ts`, 10 tests); full suite 143/143. Owed: push test branch + 1 sandbox smoke. |
| `deny_custom_availability` | **BUILT (verified-in-code 2026-06-28)** | Same real path (DENY branch) — no override written, denial logged, employee notified with no Homebase link. |
| `accept_emergency_coverage` | **DELIVERED via Aegis `/webhooks/decision` (2026-06-24)** | The Homebase `aegis-action` ActionType stub is bypassed: emergency-coverage outreach emails now carry branded **Accept/Decline** buttons routed through the Aegis decision route as `decision_type:'coverage'` → `processCoverageButtonDecision` (first-yes-wins, schedule swap, shift-filled fan-out, manager notify). Branch `feat/coverage-email-buttons`; tsc + 128/128. Round-trip eyeball pending. SMS still reply-YES/NO. |
| `decline_emergency_coverage` | **DELIVERED via Aegis `/webhooks/decision` (2026-06-24)** | See `accept_emergency_coverage` above — same branded-button path (Decline → deny → records decline, batch-exhaust prompt to manager). |
| `request_additional_batch` | **BUILT via Aegis `/webhooks/decision` (2026-06-28, item #11)** | The coverage "send another batch?" prompt to the manager now carries branded **Send next batch / No, I've got it** buttons (own path: `decision_type: 'coverage_batch'` → `processCoverageBatchButton` → reuses `blastNextBatch`). The Homebase `aegis-action` ActionType stub of this name is bypassed (same approach as the coverage Accept/Decline buttons). Reply-YES/NO fallback still works. Branch `feat/coverage-batch-button`; 167/167. Live eyeball pending. |

---

## 2026-07-24 — FAIRNESS-3: time off no longer inflates the fairness memory (BUILT, IN REVIEW)

**Bug:** the cross-week memory read a week of approved time off as "under-worked," so a returner from leave got front-loaded (Lucas Witham: approved off 07-17→07-25 covering the memory window → prior ≈ 10.75 → #1 Headguard at 28.8h next week).

**Fix:** `loadRecentHours` now flags approved full-day-TO weeks and imputes them to the employee's own non-TO typical (roster normal-week fallback) via a pure, tested `foldPriorHours`. Leave reads as a normal week; genuine under-work still ranks up. Gated by `EngineSettings.fairnessExcludeTimeOff` (default on). Stacked on the FAIRNESS-2 floor branch.

**State:** branch `fix/engine-fairness-timeoff-memory`; `schedule-build.ts`, `types.ts`, new `fairness-timeoff-memory.test.ts` (5) + `scripts/dryrun-timeoff-memory-compare.ts`. tsc clean, 270/270. NOT merged; owed = live dry-run (Lucas's memory rises) → PR → merge. Together with FAIRNESS-2 this closes the Michael-at-zero / Lucas-front-loaded pair.

## 2026-07-24 (cont.) — FAIRNESS-2 floor tuned to ratio 1.0

First post-deploy build showed the fixes working (Michael 0→9h, Lucas 28.8→10.75h) but fully-available lifeguards still bottomed at ~6h (the 0.5 floor guarantees only ~half the role mean). Bumped `DEFAULT_ENGINE_SETTINGS.fairnessFloorRatio` 0.5 → 1.0 so available same-role guards cluster near the weekly average; time-off people stay correctly lower. One-line change, tsc clean. Verify via `scripts/dryrun-floor-compare.ts`.

## 2026-07-24 — FAIRNESS-2 engine floor: eligible employees no longer starved to zero (BUILT, IN REVIEW)

**Bug (Watermark managers):** an available employee with no time-off request (Michael McCorkle, Headguard) was left entirely off next week while same-role peers ran 20+ h. Root cause = FAIRNESS-1 cross-week memory with no floor (Michael's genuine 3-week load ≈ 44 decayed → ranked last → 0; fully staffed, so pure ranker starvation, not a gap).

**Fix:** new deterministic post-fill "distribution floor" pass in `schedule-build.ts` — moves whole slots from the most-loaded eligible holder to the most-starved eligible peer, reusing the fill loop's eligibility checks + a veteran-requirement guard; never breaks a hard rule or double-books, never reduces coverage. Gated by `EngineSettings.fairnessFloorEnabled` (default on) / `fairnessFloorRatio` (0.5). Universal across clients.

**State:** branch `fix/engine-fairness-floor` (off `origin/main`); touches `src/workflows/schedule-build.ts`, `src/lib/constraints/types.ts`, new `fairness-floor.test.ts` (5) + `scripts/dryrun-floor-compare.ts`. tsc clean, 265/265. NOT merged; owed = live dry-run (Michael off zero on real 07-27 inputs) → PR → merge → Railway. Patch: `FAIRNESS-2-floor.patch`. **FAIRNESS-3 (time-off deflates the memory — Lucas) is next, diagnosed not built.**

## 2026-07-01 (session 2) — Full email-workflow test pass + 4 pre-demo bug fixes

Exercised the live email workflows one-by-one on the SANDBOX tenant via real round-trips (employee = Sam `aegisscheduler@gmail.com` / Riley `lightningmakigga@gmail.com`; manager = `sandbox-mgr@quriasolutions.com` M365 shared mailbox; every decision confirmed against Supabase). **7 of 8 verified end-to-end; #11 coverage sent from the manager but not confirmed (SendGrid inbound backlog, not a logic failure).**

| Workflow | Result |
|---|---|
| Availability ≠ time-off (temporary) | ✅ classified `update_availability`, parsed days/times, employee-confirm → manager magic-link approve → **`custom_availability` date_limited row written** |
| Partial time-off ("after 4pm") | ✅ `time_off_type:partial`, `partial_days 16:00–21:00`, manager email renders partial hours + coverage impact, approved |
| Combined time-off + availability in one message | ✅ processes time-off, P.S. asks for the availability separately ("so nothing gets crossed") |
| "What are my shifts?" (`query_my_shifts`) | ✅ accurate, human-formatted (faithfully reads the stored schedule) |
| Banned-pair FLAG on pickup/swap | ✅ manager email shows ⚠️ "Riley & Casey are a restricted pair… it's your call", both Approve/Deny stay live — flag-don't-force exactly as specified |
| Manager DENIAL notifications | ✅ "Request denied. Notified Sam Rivera & Riley Brooks", `swap_requests.status=denied`, `decided_by=null` |
| Manager magic-link approvals (availability + time-off) | ✅ branded confirm-interstitial + "All set" pages |
| #11 Coverage batch "send next batch" | ⏳ manager request sent (Sent Items), awaiting inbound processing — not yet confirmed |

**Four bugs found and fixed** — branch `fix/pre-demo-bugs` (cut from main), tsc clean, **192/192 vitest**. **Status: IN REVIEW** (coded + tested; NOT yet deployed or live-verified):

1. **Weekday resolution → today.** "my Saturday PM shift" resolved to today (Wed Jul 1), not the upcoming Saturday; explicit dates worked. The prompt already said "resolve to the upcoming occurrence" but LLMs are unreliable at weekday arithmetic. Fix (`src/ai/claude.ts`): compute each weekday's date in code and inject a lookup table into the classifier prompt so it never does the math. Reproduced twice; helps all weekday phrasing.
2. **Approved swaps didn't persist to the schedule.** An approved pickup left the requester on the shift and the picker on none. Root cause: the publish step never superseded the prior published schedule for a week, so multiple `status='published'` rows coexisted and the swap-writer (`decision.ts` picks the newest published) and shift-reader could land on different rows. Fix: both publish paths in `src/workflows/schedule-build.ts` now archive any other published row for that week (one published schedule per week); `executeScheduleSwap`/`executeScheduleTrade` in `src/workflows/shift-swap.ts` no longer `return` silently on a miss — they `console.warn`. **Existing duplicate rows in the DB are pre-existing data; the sandbox reset (#18) or a one-time cleanup SQL collapses them.** Needs a live re-verify after deploy.
3. **Stale `avail_pending_mgr` hijacked the manager's next email.** After a manager approved availability via the email button, their next message ("I need coverage…") was read as a YES/NO to the already-decided availability. The reply-YES path deleted the pending record but the magic-link path didn't. Fix (`src/workflows/employee-onboarding.ts`): the cleanup now lives in the shared `applyCustomAvailabilityDecision`, so both paths self-clean.
4. **`swap_denyd` typo.** `swap_${action}d` produced "denyd"/"denyd by manager" on denials (same for time-off). Fix (`src/webhooks/decision.ts`): map to proper past tense.

Owed for DONE on the two behavioral fixes (#1 weekday, #2 swap persistence): merge → Railway deploy → one clean live re-verify each (do it during the #18 sandbox reset).

---

## 2026-06-28 — Undirected swap (#10) redesign in progress: two-button broadcast (Stages 1–3a built)

> ⚠️ **CORRECTION (2026-06-30):** the paragraph below says Stage 4b is "do not merge until a sandbox smoke passes" / "nothing cut into the live path yet." That is **out of date** — Stage 4b is **already merged and LIVE on `main`** (it rode in with PR #65, `feat/swap-agreement-stage4a`; the 4b commit was stacked on 4a). The undirected broadcast is active in production but still UNTESTED. Only the sandbox smoke (DEV_ROADMAP item 10.5 / 11.7b) remains; there is no merge step left. See DEV_ROADMAP Session Log 2026-06-30.

Alexander's full redesign (confirmed): a requester names the shift they can't work + the days they CAN work; Aegis broadcasts to ALL eligible coworkers at once; each email has a PICKUP button (everyone) and a SWAP button (only those with a tradeable shift on a willing day); web landing pages drive the clicks; first-commit locks the shift; manager approval always, both paths; requester-declined swap reopens the broadcast. Built so far (all branch-only, tsc green, nothing cut into the live path yet): **Stage 1** eligibility split + broadcast state (pure, tested); **Stage 2** willing-days parse + `buildSwapBroadcastEmail` (two-button, tailored) + `swap_pickup`/`swap_trade_select` tokens; **Stage 3a** the PICKUP landing page end-to-end — Aegis `commitSwapPickup` + `/internal/swap-pickup-commit`, Homebase dispatcher `swap_pickup` case + confirm-page copy; **Stage 3b** the SWAP shift-picker landing page — Aegis `proposeSwapTrade` + `/internal/swap-propose` + `SwapProposal` state + tradeable-shifts embedded in the swap token, Homebase interactive `swapPickerPage` (radio cards) with server-side index resolution. Both `swap_pickup` and `swap_trade_select` actions now have REAL handlers. **Stage 4a** the agreement chain — Aegis `buildSwapProposalEmail` (requester Agree/Decline email) + `resolveSwapProposal` (agree → two-way `swap_request` + manager approval → `executeScheduleTrade`; decline → reopen broadcast + notify candidate) + `/internal/swap-proposal-decision`; Homebase `swap_agree`/`swap_decline` tokens + dispatcher + confirm copy. All five new swap action types now have real handlers. **Stage 4b — the live CUT-OVER — BUILT (Aegis-only):** `handleInitiateSwap` captures willing-days; `handleSwapConfirmation` facilitated branch now fans out the simultaneous two-button broadcast (`partitionSwapCandidates` + `buildSwapBroadcastEmail` to every reachable candidate, `storeSwapBroadcast`), replacing the old one-at-a-time outreach. Directed (named-coworker) trades untouched. **ALL STAGES (1–4b) BUILT — #10 is code-complete.** This is the first stage that changes live behavior, so **do not merge until a sandbox smoke passes** (broadcast → pickup → manager → reassign; broadcast → swap → requester Agree → manager → trade; decline → reopen). After the smoke + merge, the undirected `swap` workflow is DONE end-to-end. 163/163 vitest green, tsc clean both repos. See `DEV_ROADMAP.md` #10 + Session Log 2026-06-28 (cont. 2–4).

## 2026-06-28 — Undirected shift swap (#10) made email-first (BUILT, verified-in-code)

The "anyone want my Saturday?" broadcast (`mode:'facilitated'` in `src/workflows/shift-swap.ts`) existed but was **SMS-only** in three spots (first-candidate contact, decline→next queue advance, auto-execute receiver notify) — so on Watermark's live **email** channel it silently reached no one. All three now use the existing email-first `sendOutreachMessage` helper (email → SMS fallback), gated by a new exported pure helper `isReachableForOutreach(emp, hasSmsChannel)` (email alone is reachable; a phone only counts with an active SMS channel). The broadcast contacts the first *reachable* candidate and walks past contactless records instead of dead-ending. Directed two-way trades and the manager-approval execution (`webhooks/decision.ts`) were already email-capable — untouched. 4 new pure-helper tests (`shift-swap.test.ts`, 22 total); full Aegis suite **147/147** green, tsc clean. **Owed for DONE:** push branch + 1 live sandbox smoke (broadcast → candidate email YES → schedule reassigned + both parties notified).

---

## 2026-06-18 (late) — queue + refinements SHIPPED (all merged to `main`, live)

- **Veteran tag in the emailed schedule (item 3, email half) — day-accurate.** The build/publish report email tags constrained shift rows with the grid wording ("Veterans only" / "≥N veterans"), honoring day-of-week + season scope so a Sat/Sun-only rule tags only those rows. `veteranLabelForShiftDate` (engine) + a `resolveShiftRuleLabel` resolver passed into `schedule-build-email.ts`. Merged AG PR #41 → **#42 (day-accurate)**. Test: `schedule-build-email.test.ts` (8 cases).
- **Capabilities / help + role-aware scope guard (item 4).** New `capabilities` intent (natural-language only — NOT the bare "help" keyword, see A2P note) returns a role-aware list; the employee→manager-only redirect now names what the employee CAN do instead of dead-ending. One source-of-truth list: `src/router/capabilities.ts` (Aegis) + `src/lib/soteria/capabilities.ts` (Homebase/Soteria). Merged AG PR #43, HB PR #19. Test: `capabilities.test.ts`.
- **A2P DECISION (Alexander):** the literal **HELP** / **STOP** keywords are reserved for SMS-compliance and are NOT routed to capabilities (left as `unknown` for now). The real A2P HELP/STOP responder is deferred to the SMS phase (handle via Twilio Messaging Service Advanced Opt-Out). Merged AG PR #44, HB PR #20.
- **Homebase (web) shipped alongside:** plain-English Rules-page copy (item 13, HB PR #18); VET badge unified to orange everywhere + scope-aware day-scoped rule notes on the schedule (item 15 piece, HB PR #17).

---

## 2026-06-18 — SHIPPED since the 06-16/06-17 batch (all merged to `main`, live)

- **Publish button + republish/swap (DEV_ROADMAP items 9 + 12) — SHIPPED & live (AG PR #38, HB PR #16; migration 016 applied via SQL editor; Alexander-tested).** `confirm_distribution`'s magic-link path is retired as planned. Distribute is now the Homebase **Publish** button: it flips **`published_at`** (the single source of truth — the old `distributed`/`published` status-clobber bug is closed) and distributes to staff. `publish_schedule_swap(p_new_id, p_old_id)` (SECURITY DEFINER) atomically unpublishes the old schedule + publishes a new one for the same week, **archives** the old (superseded, not deleted), supersedes its wage/hours estimates, and notifies **changed-only** employees (diff via `src/lib/schedule-diff.ts`).
- **MANAGER-COMM-1 (item 14) — SHIPPED & live (AG PR #39).** `handleOperationalQuery` no longer dumps truncated JSON; headcount/coverage answers are computed deterministically from `schedule.data.assignments` and the prompt is hardened against leaking internals. Test: `operational-query.test.ts`.
- **Veteran feature UI (items 3 grid-half + 7) — SHIPPED & live (HB PR #15).** Grid VET badge + per-shift rule indicator + Rules-page management UI. **Open:** the **veteran tag in the emailed schedule** (item 3 email half) — quick-win #1 of the next chat.

**NEXT CHAT QUEUE (Alexander-chosen 2026-06-18):** (1) veteran tag in the emailed schedule, (2) plain-English Rules-page explainers, (3) capabilities/help + role-aware scope guard. Full brief: `NEXT_CHAT_BRIEF.md`.

---

## 2026-06-16 batch — voice/branding pass + publish-status reconciliation

Cross-references the NEXT BATCH 2026-06-16 directive in `DEV_ROADMAP.md`. Affects this tracker as follows:
- **Voice + branding pass (all emails).** Every Aegis HTML email gets the Quria look (dark header, orchid logo, orange `#f97316` action buttons + glow, brushed-silver/charcoal type) AND a warm assistant-manager voice rewrite. Rollout is **sample-first**: one workflow email rebranded + rewritten for Alexander's sign-off, then applied across time-off, availability, emergency-coverage, swap, day-closure, distribution, and the operational-inquiry replies. **Constraint:** preserve any substrings the vitest suite asserts on when rewriting copy.
- **`confirm_distribution` → Publish.** Reinforces work-list item #2 (retire the magic-link `confirm_distribution` path): distribute becomes a Homebase **Publish** button that also flips the schedule to a `published` state. Reconcile the `distributed`/`published` status-clobber bug by keying the re-distribution guard on a single timestamp field (`published_at`/`distributed_at`) rather than the ambiguous status enum.
- **Published schedule = current-week live source of truth.** Closed-day texts, swap shift-adjustments, and emergency-coverage edits read + write the published current-week schedule; mid-week changes notify **affected people only**.

**INBOUND-SIG-1 — inbound reply verification FIXED 2026-06-16 (IN REVIEW, not pushed; branch `feat/voice-pass-1`).** The live sandbox test surfaced that confirmation replies (and any inbound email carrying non-UTF-8 bytes) failed ECDSA verification: `@sendgrid/eventwebhook.verifySignature` did `payload.toString()` (UTF-8), corrupting binary bytes (e.g. the inline logo image quoted in a reply) before hashing. Replaced with a byte-exact verifier (`src/security/sendgrid-signature.ts`) hashing `timestamp || rawBody` raw; 5-case test incl. a binary-body regression proving old-path-fails/new-path-passes. tsc clean, 52/52 vitest green. Aegis-only deploy. After deploy, re-send the confirmation reply (SendGrid may have exhausted retries on the original). See DEV_ROADMAP `2026-06-16 (cont. 2)`.

**TO-RERUN-1 — SHIPPED + live-verified 2026-06-17.** Final state: email-card re-run now **replies in the original thread** with a refreshed card (not a landing page); **"✓ Resolved" reply** posted to each manager's thread on approve/deny via any channel (`sendDecisionNotification` → `sendManagerResolutionReplies`); **click-guards** ("already approved by X on …" / "already decided — no re-check needed"); `/internal/recheck-to-reply` responds instantly with the recompute+reply backgrounded (fixed the slow/hung magic-link page). The recommendation honors custom/rotating availability and counts approved-TO only — it is correct (the earlier sandbox oddity was stale rotating-availability data). Polish branch `fix/recheck-fast-response` pending deploy + one re-test.

**TO-RERUN-1 — re-check stale TO recommendations BUILT 2026-06-16 (IN REVIEW, not pushed).** New manager action surfaced 3 ways: Homebase "Re-run check" button (Time Off tab), email-card `recheck_to` magic-link (recompute → branded landing page), and a conversational `recheck_time_off` command. Engine = `recomputeTimeOffRecommendation(requestId)` → `POST /internal/recompute-to-recommendation`. Read-only on the decision (only rewrites `aegis_recommendation`/`aegis_reasoning`). Addresses the `TO-REC-STALE` lead issue (submit-time recommendations go stale under a queue). tsc clean + 52/52 vitest both repos. Sandbox seed `SANDBOX_RERUN_SEED.sql`. See DEV_ROADMAP `2026-06-16 (cont. 3)`. Deploy order: Homebase before Aegis.

**STATUS — voice + branding pass BUILT 2026-06-16 (IN REVIEW, not pushed).** New brand kit `src/messaging/brand.ts` + inline CID logo. Rebranded + re-voiced (dark shell + "Action needed" action card + conclusion-first warm voice): time-off (manager + SMS-channel), build/distribute report, employee shifts distribution + team grid, availability + custom/rotating availability, emergency coverage, shift swap, payroll, and all `htmlFromText` plain replies; Homebase magic-link Approve/Deny/error pages (`aegis-action/route.ts`). Test-asserted substrings (`>Approve</a>`, `>Deny</a>`, `reply YES`) preserved — 47/47 vitest green, tsc clean both repos. Branch: Aegis `feat/voice-pass-1`, Homebase `feat/veteran-shift-rules`. Pending: Alexander push/PR/merge + a live sandbox eyeball.

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
| Employee `query_my_shifts` ("what are my shifts?" / "am I working Saturday?") | **BUILT 2026-06-28 (#12, Aegis-only, branch `feat/employee-shift-query`)** — `handleMyShiftsQuery` returns the employee's own upcoming/specific-day shifts from published schedules, warm reply, no Homebase CTA. 172/172. Live eyeball pending (11.7). |
| Availability manager-notify fan-out to ALL managers | DONE — fixed June 5 (was `.limit(1).maybeSingle()`) |
| Reply threading (single-tenant) | DONE via Reply-To; multi-tenant From open (TENANT-1) |
| Diagnostic logging stripped (`[email-trace]`, `[req]`) | TODO (fast-follow) |
| Risky fan-outs (distribute, onboard) | **`distribute_schedule` ran successfully in prod 2026-06-12** to the full Watermark roster (no spam problem observed; DELIV-1 downgraded to MONITOR). `initiate_onboarding` + `notify_day_closure` fan-outs still DEFERRED — Phase 7, gated on manager coordination. |

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

### Phase 6.5 — Email deliverability hardening (DELIV-1) — MONITOR (downgraded 2026-06-12)

**Downgraded BLOCKER → MONITOR / client-education on 2026-06-12.** The full ~30-person `distribute_schedule` fan-out ran in production 2026-06-12 with no spam problem observed, so DELIV-1 is no longer a pre-fan-out gate. Original work (verify SPF includes SendGrid IPs; confirm DKIM signing; add DMARC `p=none` → escalate; SendGrid event webhook → `email_events` for delivery/bounce/spam monitoring; staggered sender warm-up runbook) is kept as a watch item / client-education work, not a launch gate. Re-escalate to BLOCKER if any future fan-out shows spam-folder placement at meaningful rates.

### Phase 7 — Risky workflow staged validation — partial (distribute live; onboard/day-closure still deferred)

**`distribute_schedule`: ran successfully in prod 2026-06-12** to the full Watermark roster (warm per-employee shift-assignment message + inline full-week schedule; no spam problem observed). DELIV-1 no longer gates it. Only remaining piece is a visual-consistency fix so the emailed schedule matches the Homebase render exactly = template-unification **Piece 3**. **`initiate_onboarding` + `notify_day_closure` fan-outs: still DEFERRED against Watermark** — never run without coordinating with Carolyn and Jack.

**2026-07-05 — `initiate_onboarding` email path unblocked (IN REVIEW).** Onboarding previously hard-required an SMS channel and sent SMS-consent opt-in text on every session, so it couldn't run on an email-only tenant. Fixed in `src/workflows/employee-onboarding.ts`: SMS channel now optional (SMS only when the employee has a phone AND the company has an SMS channel, else email); email sessions skip the TCPA opt-in and open with a new `sendEmailWelcomeStep`. Homebase `OnboardingTab.tsx` no longer mislabels email-only hires as "Skipped". Both repos tsc clean; **not deployed**. **Sandbox** onboarding is now demoable (via `Aegis_Onboarding_Demo_Setup.sql`, repurposing Riley); Watermark fan-out remains human-gated.

---

## Active Bugs

### Email-workflow bugs

| ID | Status | Summary |
|---|---|---|
| BUG-1 | **DONE** (June 4) | TO creation no longer blocked when `shift_requirements` is empty; simulator wrapped in try/catch, TO inserts + manager notified regardless. |
| BUG-2 | **DONE** (June 4) | Sandbox seeded with a representative `shift_requirements` row (PM Lifeguard, `accepted_roles=ARRAY['Lifeguard']`). |
| BUG-3 | **DONE** | Outbound links corrected from dead `homebase-liart` to `homebase-nine-phi`; magic-link Approve verified working. |
| BUG-4 | **OPEN** (rule firm) | Audit every employee-facing email template (TO confirmation, approved/denied, distribution, swap, emergency coverage, onboarding) for "View in Homebase" CTAs and scrub. Homebase CTAs belong only in manager-facing templates. |
| BUG-5 | **FIXED** (2026-07-12) | Stale unconfirmed pending TO in `aegis_memory` short-circuited a new `submit_time_off` and (after BUG-6's TTL bump to 24h) could nag on unrelated messages for up to a day. Fix in `handlePendingTimeOffConfirmation` (`time-off.ts`): (1) a NEW `submit_time_off` while pending now **replaces** the pending with the new dates (clears old → `handleSubmitTimeOff`) instead of telling the employee to "start over" and dropping their dates; (2) a clearly-different actionable intent (`query_my_shifts`/`query_my_time_off`/`initiate_swap`/`update_availability`/`capabilities`) **abandons the unconfirmed pending and re-routes** so the request is handled that turn (pending cleared before the recursive `routeIntent`, so no re-entry loop; `routeIntent` imported dynamically to avoid the circular import). `general_question`/`operational_query` stay in the yes/no/START-OVER nag path (often a fumbled confirmation). tsc clean, 194/194. Same subsystem as BUG-6. |
| BUG-6 | **CORE ALREADY FIXED + residual HARDENED** (2026-07-12) | June 30 screenshots: bare "Yes" confirming a TO returned "I don't have an active swap request pending for you." **Verified against source:** the router already resolves a pending TO deterministically BEFORE the classifier (`intent-router.ts` → `getPendingTimeOff` first → `handlePendingTimeOffConfirmation`, EARLY RETURN; keys match `pending_to:{employee_id}`; confirm handler matches "yes" by regex). So a bare "yes" with a live pending is consumed correctly — the diagnosed loss cannot reproduce in-window (corroborated by the 2026-07-08 live TO test). An external "fix packet" that proposed building a new deterministic `affirmation.ts` gate was **NOT applied** — it reinvented existing code and its guessed names (`swaps`→`swap_requests`, memory shape) were wrong. **Real residual:** the pending-TO TTL was 1h, so a late "yes" (expired) or a "yes" with nothing pending fell to the classifier → `handleRespondSwap` fallback = the confusing line. **Fix (adopted):** TTL 1h→24h (`time-off.ts`); `handleRespondSwap` now replies gracefully for a bare affirmation/negation instead of implying a phantom swap (`shift-swap.ts`). tsc clean, 194/194 (+2 regression tests). Same subsystem as BUG-5. |

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
| Email deliverability hardening (DELIV-1) | MONITOR (downgraded 2026-06-12 — distribute fan-out ran in prod with no spam problem; kept as a watch item, not a gate) |

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

**2026-06-12 (template-unification Piece 1 — MERGED + live):** with `DOWNLOAD-500` fixed (merged 2026-06-12), the remaining gap was that the exceljs/PDF download rendered all-blue and didn't match the on-screen schedule. Piece 1 closes it: `resolveCellAppearance` (Homebase `fix/download-template-colors` @ `4a813e5`) is now the single shared cell-color resolver across the on-screen grid + both download renderers — per-day header colors + per-day cell tints restored, deleting the forked kind-only palettes. **MERGED 2026-06-12 to Homebase `main` and deployed to Watermark prod via Vercel; all-blue fix confirmed live (downloads now match the screen's per-day colors). DONE.** **Originally logged in this paragraph as "one known regression open from the merge" — that framing was wrong and has been reframed (2026-06-12):** the missing last-name + role text in the download was a **PRE-EXISTING content gap, NOT caused by Piece 1** (evidence on record: `git diff 4a813e5^ 4a813e5` touches zero text-path lines; first-name-only display + no per-assignment role text predate Piece 1). A separate **download full-name/role content fix** was scoped and **merged 2026-06-12**; real Watermark download verified live the same day with full names + per-assignment role text rendering in both Excel and PDF. Cross-ref `DEV_ROADMAP.md` → template-unification Piece 1 + the Tier-3 entry "Download full-name + role content gap (was logged 'Piece 1 follow-up' — reframed 2026-06-12)".

**2026-06-12 (distribute fan-out — LIVE SUCCESS in production):** `distribute_schedule` ran successfully against the live Watermark tenant 2026-06-12, fanning out to the full ~30-person roster with the warm per-employee shift-assignment message AND the inline full-week schedule. No spam problem observed. **Schedule download is DONE on Watermark (Piece 1 colors + full-name/role content fix both merged + live-verified).** **`DOWNLOAD-500` RESOLVED** (symptom gone in prod; mechanism caveat: the exact root-cause line was NOT independently re-confirmed against the post-fix path — recording only that the symptom is gone, not over-claiming which line cured it). **DELIV-1 downgraded BLOCKER → MONITOR / client-education** in this tracker (Phase 6.5, Phase 7, Tier 0 row updated) and in `DEV_ROADMAP.md` (Phase 1 table + Tier-2 backlog). Only remaining piece on distribute is a **visual-consistency fix** so the emailed schedule matches the Homebase render exactly = template-unification **Piece 3**. **Active priority is now the remaining AEGIS-EMAIL-1 workflows** (verify `deny_to` via the email-button path; build `approve_availability` / `deny_availability` magic-link buttons + the shared employee-notify-back; emergency coverage accept/decline; `request_additional_batch`; manager labor-force queries; employee shift queries; employee shift-swap). The comprehensive system-document rewrite is deferred until those are verified live.

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

---

### 2026-06-11 — Distribute redesign + Aegis personability (built on branch feat/distribute-email-redesign)
- Distribute email rebuilt: warm per-employee copy + full-week all-staff schedule attached
  (Aegis self-renders HTML from schedules.data — option D; no Homebase call, no new deps).
- Aegis email attachments enabled (EmailOptions.attachments → SendGrid).
- Personability pass: shared greeting helper + automated check (scripts/check-greeting.ts);
  greetings across all employee- and manager-facing messages (each by own first name); manager
  CTAs/magic-links preserved; opt-in/TCPA, compliance, general_query excluded.
- Findings: no Homebase Distribute button today (distribution = magic-link + SMS reply);
  /download/pdf returns HTML not PDF (03 §4.3 drift).
- Status: built on branch, tsc clean, greeting check green; NOT merged/live-verified.

Distribute email redesign + inline full-schedule + Aegis personability — DONE (PR #5/#6, deploy 7c7f158e). .html attachments don't render in Gmail → grid is inline.

---

### 2026-06-12 — distribute_schedule week-selection + special notes (MERGED)
- distribute now extracts `target_week` (this|next) and selects by `week_start` match (was: latest schedule → wrong week). No schedule for requested week → clear reply.
- Distribute email gains a "This week:" events/special-notes section (closures, parties, holidays, staffing notes) above the full-week grid.
- Tz caveat: `getWeekBounds` is server-local, not company-tz — see DEV_ROADMAP Tier-1 fast-follow.
