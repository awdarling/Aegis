# QURIA — Development Roadmap & Progress Tracker

**Living document. Last updated: June 9, 2026.**

This is the operational source of truth for active development. It is meant to be read and updated by Claude (Claude Code / Cowork) every session.

> **PUSH STATE (top-of-file banner — read every session):** Aegis is pushed and live (`46eaa70`). **Homebase is ahead 8 commits and UNPUSHED.** Until Homebase is pushed: SCHED-EDIT-1 (S2) cannot live-verify, S3 cannot live-verify (and lacks `AEGIS_URL` / `AEGIS_INTERNAL_SECRET` on Vercel), and the `CoverageFlags` renderer is dark — which is why the `unsatisfied_sex_coverage` flag now appears in the manager schedule-preview email but **not** in the Homebase schedule view. Pushing Homebase is the universal next gate.

---

## How to use this document (instructions for the agent)

1. **Read this whole file first** at the start of every session. The Current Sprint is the priority; the backlog is everything after.
2. **Diagnose before you fix.** Every bug here is diagnose-first. Do not write a fix until the diagnosis section for that item is filled in with real evidence (logs, dispositions, the actual code path).
3. **Update statuses as you go.** Change the status tag on an item the moment its state changes. Tick checklist boxes when each sub-step is verified (not when attempted).
4. **Append a Session Log entry at the end of every working session** — date, what was done, what's next, any new bugs/decisions. Append only; never rewrite past entries.
5. **Keep in sync with the repo trackers.** Bug status changes here must also land in `EMAIL_WORKFLOWS_TRACKER.md` (and `SCHEMA_DRIFT_LOG.md` for any new schema finding). The six `.docx` reference docs are the stable reference; this file is the live state.
6. **Hold the standing principles** (bottom of file). The big one: **no orphan outputs** — every change an AI makes must land as valid, visible Homebase state within the constraints. And: read the actual diff before any push.

**Status legend:** `NOT STARTED` · `DIAGNOSING` · `DIAGNOSED` · `FIXING` · `IN REVIEW` (pushed, awaiting verification) · `DONE` · `BLOCKED`

---

## LOGGING PROTOCOL — run this on every approval (mandatory for every agent)

This is the single most important habit. The moment a piece of work is **approved by Alexander**, and before you consider the task done, update the project's memory so the *next* agent — and Alexander — never face a context gap. Do all that apply:

1. **DEV_ROADMAP.md** — flip the item's status, tick only the boxes you actually verified, and append a dated entry to the Session Log (what changed, what's next, any new decision or bug).
2. **EMAIL_WORKFLOWS_TRACKER.md** — if a bug or workflow's state changed, mirror it here.
3. **SCHEMA_DRIFT_LOG.md** — if you found anything in the live database that differs from the docs (a column, constraint, type, enum), append it (append-only; never delete).
4. **TEST_IDENTITIES.md** — if tenants/identities changed (new test user, removed Bubba, etc.), record it.
5. **Reference docs (`docs/01–06`)** — if the change alters how the system actually works (new feature, changed workflow, schema change), update the relevant reference doc so the stable reference stays true. Significant changes also get reflected in the matching `.docx` in the Claude.ai project knowledge.

**Rule:** never end a session without doing the above. The next agent self-briefs from these files. Skipping this re-creates the exact context gap this whole system exists to prevent. If you changed something and didn't log it, the work isn't finished.

---

## CURRENT SPRINT — 48-hour priority (started June 8)

### S1 · ENGINE-1 — Builder skips eligible employees
**Repo:** Aegis (`src/lib/engine/`) · **Status:** `DIAGNOSED` (ruled out as an engine bug — see post-sprint determination)
Aaron Barrigan (Headguard, fully available) is never placed. Erin Berigan reported as "can't work" with no custom availability. Suspected systemic, not one-off.

**Post-sprint determination (2026-06-09):** ENGINE-1 is **not** an engine code bug. The two named cases dissolved under diagnosis: "Aaron Barrigan" = Erin Berigan (one employee, not two), and Erin's exclusion was a 15-min availability-precision issue (data fix, applied + verified). The remaining systemic miss — **4 Junior Lifeguards (Jenna Stibitz, Cameron Osterhaven, Colin Marvin, Quin Mead) get 0h because no `Junior Lifeguard` shift_requirements / canvas slots exist this week** — is **structural** and is **routed to Role Groups** (Tier 2). It is NOT an ENGINE-1 code fix. ENGINE-1 stays `DIAGNOSED` (not `DONE`) and is **blocked on two Alexander/manager decisions**: (a) true Afternoon shift end — 21:00 or 21:15? (b) does Watermark schedule Junior Lifeguards at all (off-roster vs Role Groups / fold into Lifeguard)?

- Diagnosis (fill in before fixing):
  - [x] Dry-run built for the affected week; `per_employee_dispositions` dumped for Aaron, Erin, **and full roster**
  - [x] Aaron's & Erin's `employees` rows pulled (`primary_role`, `qualified_roles`, `max_weekly_hours`, `active`) + their `availability` rows
  - [x] Disposition reason identified (`not_qualified` / `availability_mismatch` / `max_hours_reached` / `eligible_but_unchosen` / …)
  - [x] Determined: roster-wide pattern or isolated? (count how many employees show the same reason)

**Findings (2026-06-08 diagnostic pass — dry-run for build week 2026-06-15..21):**

Method: `scripts/dry-run-schedule.ts` (next week) + `scripts/diagnose-s1.ts` (one-off, traces date-level eligibility for every employee × every canvas slot and pulls Aaron/Erin from the live DB). Both ran against live Watermark data with no writes.

1. "Aaron Barrigan" does not exist in employees and is CONFIRMED (Alexander, 2026-06-08) to be a misremembering of Erin Berigan — there is no separate employee. The two named ENGINE-1 cases are therefore ONE case: Erin. Her availability was entered ending 21:00 while the Afternoon shift ends 21:15, locking her out of evenings. Availability extended (data fix) and verified 2026-06-08.

2. **Erin Berigan — exists, active, and IS being placed (4.5h), but is structurally locked out of the dominant evening shift.**
   - Row: `id=1b868570-1ade-443d-9781-4cbe16a5cf06`, `primary_role=Headguard`, `qualified_roles=["AManager","Headguard","Lifeguard"]`, `max_weekly_hours=40`, `active=true`, `is_veteran=true`.
   - Availability: 7 rows, every day, **09:00:00–21:00:00**. No `custom_availability`. No approved TO in the build week.
   - Dry-run placement: **1 shift, Friday AM Weekday Headguard 11:00–15:30 (4.5h)**.
   - **Why she's shut out of the largest Headguard pool (Afternoon, 7×wk):** the "Afternoon" shift runs **15:00:00–21:15:00**. `isAvailableForShift` (`src/lib/engine/eligibility.ts:17–29`) requires the availability window to **fully contain** the slot: `availStart ≤ slotStart && availEnd ≥ slotEnd`. `21:00:00 < 21:15:00` → mismatch on every Afternoon slot, every day. Disposition code = `availability_mismatch`. This is the literal cause of the manager's "she's marked as can't work" perception — the engine truthfully says she can't cover *any* Afternoon. **Off by 15 minutes is the binding constraint, not a code defect.** A fix is a product decision (15-min grace window? Shorten Afternoon end? Edit Erin's availability to 21:15?), not a code bug per se.

3. **Roster-wide tally (distinct employees ever excluded by a date-level reason, summed across all 70 canvas slots):**
   - `not_qualified`: **29** (every active employee gets `not_qualified` against at least one slot whose role they don't hold — this counter, on its own, is uninformative. The interesting subset is below.)
   - `availability_mismatch`: **5** (Kori Baumann, Ally Becker, Erin Berigan, Michael McCorkle, Letizia Cumbo-Nacheli) — same root pattern as Erin worth checking per employee.
   - `on_time_off`: **3** (Will Roelofs, Miles Holter, Rosa Thornburg).
   - `inactive`: **0**.
   - **`eligible_but_unchosen` / `max_hours_reached` / `doubles_blocked` / `in_conflict` — not measured this pass:** the dry-run came in at 70/70, 0 gaps, so the engine never wrote a single `per_employee_dispositions` block (those only generate for unfilled slots). To get slot-level reasons, we need a week with real gaps, or a synthetic stress run.

4. **The real systemic pattern: 4 active employees were NEVER date-level-eligible for ANY slot this week, and the engine never surfaces them.** All four are Junior Lifeguards:
   - Jenna Stibitz, Cameron Osterhaven, Colin Marvin, Quin Mead — `qualified_roles=["Junior Lifeguard"]`, all available 7d × 00:01–23:59.
   - Canvas this week has **zero `Junior Lifeguard` slots**. Distinct slot.role values: `Headguard` (14), `Lifeguard` (35), `Manager` (14), `Greeter` (7).
   - A 5th, Nick Jovanovic (`qualified_roles=["Junior Lifeguard","Greeter"]`), was eligible for the 7 Greeter slots but ranker chose Bennet/Kason instead → 0h.
   - **These five do not appear in any `per_employee_dispositions` list because no gap exists for the slots they're qualified for.** A manager looking at the schedule sees them silently dropped. This is the "suspected systemic" pattern in the bug report.
   - Fix is structural (Role Groups — already in Tier 2 backlog as `shift_requirements.accepted_roles`), not a one-line eligibility patch. As a short-term diagnostic, we could surface an "active employees with zero eligible slots this week" flag on every build.

5. **String-mismatch / casing check (this was the original suspicion in the bug report):**
   - Distinct `slot.role` values in canvas: `"Headguard"`, `"Lifeguard"`, `"Manager"`, `"Greeter"`.
   - Distinct `qualified_roles` values across active employees: `"AManager"`, `"Greeter"`, `"Headguard"`, `"Junior Lifeguard"`, `"Lifeguard"`, `"Manager"`.
   - **No casing or whitespace mismatch for any role currently in the canvas.** `isQualifiedForRole` uses exact-string `.includes(role)` (`eligibility.ts:11–13`); it would silently fail on `" Headguard"` or `"headguard"`, but none of those exist in this data. So the bug is **not** roster-wide string normalization.
   - CORRECTION (2026-06-08): "AManager" in Erin Berigan's and Michael McCorkle's qualified_roles is NOT a typo. Per reference doc 01, AManager = Assistant Manager, a legitimate Watermark role (Erin is the named AManager, "maps to Headguard/Lifeguard in practice"). It is inert only because no shift_requirements carry role='AManager'. DO NOT rewrite it to "Manager" and DO NOT log it as schema drift — it is expected data. Open (low priority): should AManager be its own schedulable slot, or always resolve to Headguard/Lifeguard? Verify Michael McCorkle is in fact an Assistant Manager.

**Plain-English summary:** The bug report's two named cases dissolve under inspection. Aaron isn't in the database — confirm with Alexander whether the name is wrong or the employee just needs adding. Erin is being placed, but is locked out of every Afternoon shift because her availability ends at 21:00 and Afternoon ends at 21:15 — an off-by-15-min data precision issue, not an engine defect. The real systemic miss is structural: four Junior Lifeguards with no matching shift_requirements get silently skipped, and the engine never produces a disposition row for them because their slots don't exist to gap on. The casing/normalization hypothesis was checked and ruled out for this week's roster, but `"AManager"` on two employees confirms free-text `qualified_roles` is a real future risk.

- Fix (only after diagnosis):
  - [ ] **Decision needed from Alexander before coding:** (a) Is "Aaron Barrigan" a real employee that needs to be added, or a misremembering of Erin Berigan? (b) For Erin's 21:00 vs 21:15 mismatch — grace window in the engine, shorten Afternoon to 21:00, or edit Erin's availability to 21:15? (c) For the four Junior Lifeguards — is this expected (off-roster this week) or should we accelerate Role Groups / fold Junior Lifeguard into Lifeguard `qualified_roles`?
  - [ ] Add a build-time diagnostic: warn when active employees have zero eligible slots in the week (so the Junior Lifeguard pattern surfaces without needing a manual trace next time).
  - [ ] Clean up `"AManager"` in Erin's and Michael's `qualified_roles` (data fix, not code).
  - [ ] Dry-run re-run confirms the missing people are now placed (or are knowingly off-roster).
  - [ ] DECISION (Alexander, operational): true Afternoon shift end — 21:00 or 21:15? Fix whichever data point is wrong. NOT an engine grace window (rejected — global containment change to mask one data point).
  - [ ] DECISION (Alexander, domain): are the 4 Junior Lifeguards off-roster this week (expected) or should JL be schedulable (Role Groups / fold into Lifeguard)?
  - [ ] CODE (greenlit pending): build-time diagnostic warning on active employees with zero eligible slots in the built week.
- **Done when:** the affected employees are scheduled in a dry-run, and no other employee is being silently dropped for the same reason.

### S1b · ENGINE-2 — Hours not distributing across the roster (suspected fairness)
**Repo:** Aegis (`src/lib/engine/ranker.ts`, `schedule-build.ts` fill loop, `src/lib/engine/sex-coverage.ts`) · **Status:** `DONE`

**Resolution (2026-06-09, live-verified):** Per-shift `attribute_mix` sex swap — the real cause of the bimodal Headguard hours — has been **replaced** with `sex_coverage` (scope=`concurrent_coverage`, validate-and-flag, no swap). The policy `policy_value_json` has been **flipped** to the new model. **Live-verified by a Watermark build:** Lucas 26.3h → 15.3h, Erin 6.3h → 10.8h; the `unsatisfied_sex_coverage` flag renders in the manager schedule-preview email (coalesced contiguous segments). The post-fill swap pass is now dormant (the parser yields no sex `attribute_mix` under the new json). **Caveat:** Homebase **display** of the same flag (`CoverageFlags` renderer) is committed but ships with the pending Homebase push — until then, managers see the flag in email only, not in the Homebase schedule view.
After Erin's evening availability fix, a fresh next-week sample still places her once while a few names repeat (e.g. Audrey Rook, Headguard, 3 afternoons). Expectation: accumulated hours should lower an employee's rank for later slots so hours spread. Symptom suggests hours-fairness may not be accumulating during the fill — NOT yet confirmed. Diagnose-first; do not touch the ranker until a trace names the deciding sort key.

**Findings (2026-06-08 instrumented trace):** NOT a fairness bug. The hours-fairness pipeline is verified intact: rankCandidates is called fresh per slot (schedule-build.ts:500/521), each placement updates weekState.weeklyHoursMap immediately (:596), and the sort key reads it (ranker.ts:48/61/76). Erin's availability fully contains the Afternoon Headguard slot on all 7 days — availability ruled out.
ROOT CAUSE: enforceAttributeMixForShift runs as a post-fill pass to satisfy an ACTIVE gender_requirement (attribute_mix sex: >=1 male + >=1 female per shift, scope=all_shifts). ~3 swaps/week. When it swaps a ranker-awarded employee OUT, the displaced person is not re-placed, and same-day-doubles that fired during the main fill loop are not re-evaluated — so they lose slots they were blocked from. The hours ledger IS refunded (attribute-mix.ts:284-285); re-placement is what's missing. Net: Erin, Kori, Michael each end at 6.3h (one shift) while Lucas (repeatedly inserted male) hits 26.3h. Headguard distribution bimodal across 6 HGs / 14 slots split 3M/3F.
TWO PROBLEMS:
- (A) Engine correctness: post-fill swaps don't reconsider/backfill the displaced employee.
- (B) Policy decision (Alexander): is '>=1 of each sex on EVERY shift' intended? Options: keep broad / narrow scope / remove. DECIDE FIRST — it sets how much of (A) is needed.
DOC DISCREPANCY: gender_requirement is documented as DORMANT (doc 04 §2.4, doc 06 §9) but is configured and active. Flag for reference-doc correction and verify in the Homebase Rules tab.
DECISIONS NEEDED:
- [ ] (B) Confirm/narrow/remove the gender attribute_mix policy.
- [ ] (A) After (B): surgical backfill vs structural fold-of-attribute-mix-into-fill-loop. Lean structural if the rule stays broad.
- **Done when:** displaced employees are reconsidered so Headguard hours flatten, without violating the confirmed gender policy. No fix until (B) is decided.

**Agreed fix direction (2026-06-08):** ENGINE-2 is resolved by REPLACING the gender rule's model, not by patching the swap. The real requirement (Alexander) is facility-wide temporal coverage: ≥1 male + ≥1 female on duty among counted roles at every moment the pool is staffed — NOT per-shift composition. New constraint sex_coverage: attribute=sex, minimums {male:1,female:1}, scope=concurrent_coverage (evaluate over the day's timeline segmented at shift boundaries), population_roles=[Headguard, Lifeguard, AManager] (Greeter + Junior Lifeguard NOT counted; pure Manager pending confirm), on_infeasible=flag. Evaluation = validate-and-FLAG (FlaggedIssue 'unsatisfied_sex_coverage'); NO swap pass. Retiring the per-shift enforceAttributeMixForShift swap eliminates the ENGINE-2 churn and makes Problem A (no backfill) moot. Ship as pure validate-and-flag first; add a forward-looking soft fill-loop coverage bias only if flags prove common. Contract-first (engine before Rules-tab UI), like Role Groups. MIGRATION: remove the current attribute_mix sex scope=all_shifts policy + its swap pass in the same change to avoid double-application.
Decisions confirmed: JL not counted; presence = guard staff on floor; flag-don't-force; no single-staff open windows (only Greeter/Flex are 1-person shifts). Managers NOT counted (confirmed 2026-06-08). Population FINAL: Headguard, Lifeguard, AManager. sex_coverage implementation spec drafted 2026-06-08; build may run ahead of policy flip, but the policy_value_json migration is held pending Watermark management sign-off on the rule.
DOC FIX still needed: gender_requirement documented dormant (doc 04 §2.4, doc 06 §9) but is live — correct on next doc pass, and replace the per-shift framing with the concurrent_coverage model.

DECISION 2026-06-08 (Alexander): NO Phase 2 soft coverage bias — rejected to keep the engine generic/config-driven. sex_coverage stays validate-and-flag, toggleable per client. Because flag-only is the chosen model, the coverage flag is now the safety mechanism: it MUST surface as a visible manager review/action item in the Homebase schedule view (not only the Aegis email). Remaining sex_coverage work: (a) Homebase renders + surfaces the no-shift_name coverage variant as an action item; (b) coalesce contiguous same-missing-sex flags into one; (c) management sign-off + policy_value_json flip to scope=concurrent_coverage.
**UPDATE 2026-06-09:** (a) DONE — Homebase `FlaggedIssue` reconciled to the Aegis union, and new `CoverageFlags` component renders `unsatisfied_sex_coverage` as a "Coverage to review" manager action item (date, time window, missing sex, on-duty) in the schedule view + history report detail. (b) DONE — `sex-coverage.ts` now coalesces time-contiguous same-missing-sex segments into one flag (verified by a synthetic check: 3 contiguous segments → 1 flag 11:00–18:00; a satisfied middle window correctly stays 2 flags). (c) STILL PENDING — needs management sign-off + the policy_value_json flip (exact SQL prepared this session, presented to Alexander to run in Supabase; NOT executed by the agent). Live-roster verify harness (hours-flatten + real flags) could NOT run from the agent sandbox (no network egress to Supabase) — run `scripts/verify-sex-coverage.ts` where the DB is reachable. The flip retires the per-shift attribute_mix swap automatically: once the sex policy's json is scope=concurrent_coverage, the parser yields a concurrentCoverage constraint and no sex attribute_mix, so the swap pass has nothing to act on.

### S2 · SCHED-EDIT-1 — Manual schedule edits don't persist
**Repo:** Homebase (`src/app/(app)/schedule/page.tsx`) · **Status:** `IN REVIEW` — fix committed (`f28cb30`), code-verified; **gated on Homebase push + the live edit→reload→distribute round-trip** before flipping to `DONE`.
Moving an employee between shifts updates the displayed card but not `schedules.data.assignments`; distribute then sends the new shift name with stale hours. **This gates safe distribution — no manual-edited schedule may be distributed until this is green.**

- Diagnosis:
  - [x] Manual-edit save handler read; determined whether it persists to Supabase at all
  - [x] Identified which fields it carries vs drops on a move (`shift_name` vs `start_time`/`end_time`/`role`/`hours`)

**Findings (2026-06-08 diagnostic pass):**

1. **Move handler (the part that runs when a card is dragged between cells).**
   File: `src/components/schedule/ScheduleRenderer.tsx`, lines 512–530. Triggered from `handleDragEnd` (lines 555–561), which reads the drop target out of `DroppableCell` props (`shiftName={row.id}`, `date={date}` — lines 641–642).

   ```ts
   function moveAssignment(source: ScheduleAssignment, targetShift: string, targetDate: string) {
     if (!onAssignmentChange) return
     if (source.shift_name === targetShift && source.date === targetDate) return

     let moved = false
     const next = assignments.map(a => {
       if (
         !moved &&
         a.employee_id === source.employee_id &&
         a.shift_name === source.shift_name &&
         a.date === source.date
       ) {
         moved = true
         return { ...a, shift_name: targetShift, date: targetDate }
       }
       return a
     })
     if (moved) onAssignmentChange(next)
   }
   ```

   `onAssignmentChange` is wired to `setPendingAssignments` in `src/app/(app)/schedule/page.tsx` (lines 1394, 1467). So a move only mutates *local React state* (`pendingAssignments`); the renderer itself never touches Supabase.

2. **Persistence to Supabase — does happen, but only on explicit Save in the review panel.**
   The schedule page does not auto-persist on each move. Persistence runs from `ScheduleReviewPanel.save()` (`src/components/schedule/ScheduleReviewPanel.tsx` lines 188–216), invoked after the user opens the Soteria review drawer and clicks Save Changes:

   ```ts
   const newData = {
     ...(schedule.data ?? { assignments: [], gaps: [], summary: '' }),
     assignments: pendingAssignments,
   }
   const { data: saved, error: updateErr } = await supabase
     .from('schedules')
     .update({ data: newData, staffing_report: newReport })
     .eq('id', schedule.id)
     .select()
     .single()
   ```

   So *when* a save happens, the **entire `pendingAssignments` array is written back to `schedules.data.assignments`**, replacing it. Other top-level columns of `schedules` are untouched; inside `data`, only `assignments` is overwritten (other keys — `gaps`, `summary`, `closed_dates`, etc. — are preserved via spread). The `staffing_report` column is recomputed alongside.

   **This means the persistence mechanism itself is fine. The bug is upstream in `moveAssignment`'s reshape of the row, which then gets dutifully persisted.**

3. **Fields on a move — what updates vs goes stale.**
   `ScheduleAssignment` (`src/lib/types.ts` lines 186–196) has nine fields. After a move, in the pending row that gets persisted:

   | Field            | Updated? | Source on move | Notes |
   |------------------|----------|----------------|-------|
   | `date`           | ✅ updated | `over.date` from drop target | correct |
   | `shift_name`     | ✅ updated | `over.shift_name` = `row.id` of the target `DroppableCell` | correct (RowConfig.id IS the shift_name per `src/lib/types.ts:155–161`) |
   | `employee_id`    | ✅ preserved | (carried) | correct |
   | `employee_name`  | ✅ preserved | (carried) | correct |
   | `employee_photo` | ✅ preserved | (carried) | correct |
   | **`role`**       | ❌ **stale** | carried from source assignment | wrong when shifts have different roles |
   | **`start_time`** | ❌ **stale** | carried from source assignment | wrong whenever target shift has different hours |
   | **`end_time`**   | ❌ **stale** | carried from source assignment | same |
   | **`hours`**      | ❌ **stale** | carried from source assignment | same — this is the field that drives the email's hour total |

   **Where the target's correct `start_time` / `end_time` / `role` would come from:** `shift_types` (the canonical source per the deprecation notice on `shift_templates` in `src/lib/types.ts:122–140`). The renderer does *not* have `shift_types` data in scope — only `RowConfig` (`id`, `label`, `height`, `visible`, `order`), which carries no time/role information. So `moveAssignment` cannot recompute these locally without a new data dependency. This is the structural reason it doesn't.

4. **Distribute path — confirms exactly what gets sent.**
   Homebase only sends `{ schedule_id }` to Aegis (`src/lib/aegis-actions/dispatcher.ts:286–289`). Aegis then re-reads the schedules row and reads **`schedules.data.assignments`** — confirmed in `~/Desktop/Aegis/src/workflows/schedule-build.ts:1259–1291`:

   ```ts
   .from('schedules')
     .select('id, week_start, week_end, data, status')
     .eq('id', scheduleId)
   ...
   const schedData = scheduleRow.data as unknown as ScheduleData;
   ...
   const myShifts = schedData.assignments.filter(a => a.employee_id === emp.id)...
   ```

   The email/SMS templates render `s.shift_name`, `s.role`, `s.start_time`, `s.end_time`, `s.hours` straight off each assignment (`schedule-build.ts:1303–1331`). No second lookup against `shift_types` to correct the times — whatever sits in `schedules.data.assignments` is what employees receive.

**Net diagnosis:** the manual edit *does* persist to `schedules.data.assignments` (the Save path is whole-array overwrite, not partial). The bug is that `moveAssignment` only patches `shift_name` + `date` and leaves `start_time`/`end_time`/`role`/`hours` set to the *source* shift's values, so the persisted row is internally inconsistent ("new shift name, old hours"). Aegis then distributes that inconsistent row verbatim, producing the reported symptom.

**Fix shape (not implemented yet):** the move handler needs the target shift's authoritative `start_time` / `end_time` / role(s) at the moment of drop. Two viable spots — recompute inside `moveAssignment` (requires passing `shift_types` into `ScheduleRenderer`), or normalize inside `ScheduleReviewPanel.save()` before writing (single chokepoint, also catches `add_shift` paths). Decide on direction before writing the fix.

**Agreed fix approach (2026-06-08):** Shared pure resolver resolveAssignmentForSlot, called at BOTH moveAssignment (live UI correctness) and ScheduleReviewPanel.save() (persist chokepoint). Preserve role (it is NOT stale on a move — corrects finding-3). Resolve start/end by copying from a sibling assignment in the same shift_name+date (engine-authoritative this week); fall back to shift_types only for empty targets. Recompute hours from the resolved window.

- Fix:
  - [x] A move recomputes the **full** assignment object from the target slot and persists the complete `ScheduleData`
  - [ ] Verified: edit → reload → DB shows corrected hours → a (test) distribute reads correct hours *(live round-trip — still pending; gated by distribution rules)*
- **Done when:** a manual move round-trips to the DB with all fields correct and distribute reflects it.

Session recap (2026-06-08) reports S2 implemented (4 files + 2 helpers, claimed tsc clean) but NOT yet diff-reviewed by Alexander. PENDING: read full diff; run npx tsc --noEmit independently; verify the empty-target fallback time source (shift_types vs shift_requirements — original S1 PART 3, still unconfirmed). Common-case sibling-copy path is fine; the fallback is the risk.

Implemented (uncommitted, 2026-06-08): new helpers src/lib/schedule/resolveAssignment.ts + hours.ts; edits to ScheduleRenderer, ScheduleReviewPanel, plus UNREQUESTED edits to GapResolverPanel + ManualScheduleBuilder (likely shared-hours dedup — verify behavior unchanged). PENDING Alexander: read all diffs incl. the two unscoped files; independent npx tsc --noEmit; verify resolveAssignment empty-target fallback time source (shift_types vs shift_requirements, still unconfirmed). tsconfig.tsbuildinfo should not be tracked.

**RESIDUAL RESOLVED (2026-06-09):** All three PENDING items above are now cleared. (1) The fix is committed in Homebase as `f28cb30` (not uncommitted) — `resolveAssignment.ts` + `hours.ts` + edits to ScheduleRenderer/ScheduleReviewPanel/GapResolverPanel/ManualScheduleBuilder; `tsconfig.tsbuildinfo` is now gitignored. (2) **Empty-target fallback time source = shift_types — CONFIRMED CORRECT, matches the engine.** `buildCanvas` (Aegis `src/lib/engine/canvas.ts:89,100-105`) sources a slot's `start_time`/`end_time`/`hours` from the **shift_type** (`st.start_time`/`st.end_time`); only `role` comes from the shift_requirement (`req.role`). The Homebase fallback (`resolveAssignment.ts:24-27`) looks up `shiftTypes` by name and copies `st.start_time`/`st.end_time` — same source. Note: `shift_requirements` *has* its own `start_time`/`end_time` columns, but `buildCanvas` ignores them — shift_types is authoritative. The save-time backstop (`ScheduleReviewPanel.save()` lines 193-201) fetches real `shift_types` from Supabase and re-resolves every pending row, so even an empty-target move normalizes against shift_types before persisting. (3) Independent `npx tsc --noEmit` on Homebase = **0 errors**. (4) The two unscoped files (GapResolverPanel, ManualScheduleBuilder) are pure dedup — they delete byte-identical local `computeHours` definitions and import the shared `@/lib/schedule/hours`; behavior unchanged. Only the live edit→reload→distribute round-trip remains (gated by distribution rules) before flipping to DONE.

### S3 · Manual TO approval in Homebase doesn't notify the employee
**Repo:** Homebase Time Off tab → Aegis notify bridge · **Status:** `IN REVIEW` — committed (`f8e2505`), tsc clean, `decided_by` set on the in-tab path; **gated on Homebase push + `AEGIS_URL` / `AEGIS_INTERNAL_SECRET` on Vercel + sandbox round-trip** before flipping to `DONE`.
The email magic-link approval notifies the employee; the in-tab Homebase approval does not. Also set `decided_by`, and have Aegis acknowledge the acting manager.

- Diagnosis:
  - [x] In-tab approve/deny path read; Aegis employee-notification function (used by the magic-link path) located
- Fix:
  - [x] In-tab approval fires the same employee notification (via the shared helper → `/internal/notify-to-decision`)
  - [x] `decided_by` set on the in-tab path (from the server auth cookie)
  - [x] Manager gets a "got it — change made and employee notified" acknowledgment (toast surfaces the helper's message, incl. notify channel)
- **Done when:** approving a TO in Homebase notifies the employee and the manager, and `decided_by` is populated.

**Findings (2026-06-08):** In-tab TimeOffTab.handleDecision (TimeOffTab.tsx:230-241) updates status + decided_at, logs activity, refetches — and stops. Missing vs magic-link path: employee notification, decided_by, race guard (.eq('status','pending')), manager acknowledgment. Notification primitive postToAegisInternal('/internal/notify-to-decision') exists in Homebase (aegis-internal.ts) but needs server env vars; TimeOffTab is a client component so it can't call it directly.
Agreed fix approach: extract shared decideTimeOffRequest helper (guarded update w/ decided_by from server auth cookie, activity log, fire-and-tolerate notify, return manager-facing message); add server route POST /api/time-off-decision; refactor magic-link dispatcher to call the same helper; TimeOffTab calls the route and surfaces the message (toast). Pre-fix checks: grep src/ for other client-side time_off_requests.update({status}) callers; confirm AEGIS_URL + AEGIS_INTERNAL_SECRET set on Vercel. Out of scope: cross-notify other managers (fast-follow).

**BUILT (2026-06-09, uncommitted — Homebase):** exactly the agreed shape, 4 files.
- NEW `src/lib/time-off/decide.ts` — `decideTimeOffRequest(input)`: guarded pending-only update setting `decided_by`, activity-log entry (`source: 'magic_link' | 'in_tab'`), fire-and-tolerate `postToAegisInternal('/internal/notify-to-decision')`, returns a "feels-like-a-person" manager message (incl. notify channel / config-missing fallbacks). Dates parsed local-time per Doc 5 §6.1.
- NEW `src/app/api/time-off-decision/route.ts` — POST; authenticates the manager via the cookie session (`createServerSupabase().auth.getUser()` → `users.company_id`), loads the request with the service-role client, enforces same-company ownership, calls the helper with `source: 'in_tab'` + the manager's identity, returns the result (200 ok / 409 already-decided / 4xx).
- `src/lib/aegis-actions/dispatcher.ts` — `handleTimeOffDecision` refactored to delegate to the shared helper (−96 lines net). Removed now-dead `NotifyToDecisionResponse` type + unused `AegisInternalError` import + unused `dateRange` local. `logDecision`/`logAegisDeliveryFailure` retained (still used by the distribute path).
- `src/app/(app)/data/tabs/TimeOffTab.tsx` — `handleDecision` now POSTs to the route and surfaces the returned message as a dismissible toast; Approve/Deny disabled + "Saving…" while in flight. The old client-side `time_off_requests.update` + `logActivity` removed from this path.

Pre-checks done: (1) Only client-side `time_off_requests.update({status})` caller was `TimeOffTab` itself — `page.tsx:389` is a read-only SELECT (out-this-week), not a decision writer. No other competing path. (2) `AEGIS_URL` + `AEGIS_INTERNAL_SECRET` are referenced in code + declared in `.env.example`, but **absent from `.env.local`** and **could not be verified on Vercel from this session** — Alexander must confirm both are set on Vercel prod and match the Aegis side. If unset, the helper degrades gracefully (decision still persists; toast says notifications aren't configured).
Verified: independent `npx tsc --noEmit` = **0 errors**; full diffs reviewed. NOT done: live round-trip (approving a real TO fires a real employee notification → would fan out to a real employee; hold per the standing rules — test with the sandbox identity / a Watermark test TO, not a live employee). NOT pushed.

> **Out of this sprint (deliberately):** cross-notify the *other* managers when one acts ("no action needed") — moderate build, near-term fast-follow.

---

## Active backlog

### Tier 1 — near-term fast-follows
- Cross-notify managers on TO/availability action ("no action needed").
- **Access page: can't revoke Homebase access for Bubba** — fix; then execute launch cleanup (remove Bubba's manager row, `aegisscheduler` test employee, stray pending test TO, sandbox/test activity).
- Availability approval **buttons** (mirror TO magic-link) + Homebase backstop — also the fix for "communications feel robotic / yes-no reply bs" (do a tone pass in the same pass).
- Undo action button.
- Expand doc 03's Access Management section (docs gap).

### Tier 2 — significant builds (contract-first: engine/parser before UI)
- **TO-rules-as-policy program** (one program): move TO rules into the same `policy_value_json`/constraint-vocabulary system the schedule engine uses; attribute classifier so workflows know what to pull; Rules/Attribute creation+edit UI that updates everywhere; Soteria + Aegis can read/write. Includes the "new UI and engine for TO rule policies" and "attribute edit/creation page" notes.
- **Role Groups** — `shift_requirements.accepted_roles` (exists, NOT read yet); structural fix for Headguard coverage gaps **and** the resolution path for ENGINE-1's Junior-Lifeguard structural miss (4 employees with 0h because no JL slots exist). Engine eligibility before UI. (Distinct from ENGINE-1 as a bug class: ENGINE-1 is `DIAGNOSED` and the JL portion is structurally owned here.)
- **Coverage-flag resolver (engine helper + Homebase UI)** — when a schedule carries an unsatisfied_sex_coverage flag (all slots filled, but the concurrent-coverage mix is unmet — e.g. no male guard 11:00-21:15), Homebase displays the flag but offers no way to act on it. Build a manager-assisted resolver, analogous to the gap resolver: an engine helper computes candidate swaps that would satisfy the flagged window without creating a new gap/conflict/coverage hole; Homebase surfaces them as suggestions; the manager applies one via the manual-edit path. Manager-driven, NOT an automatic swap — the assisted version of the per-shift swap retired in ENGINE-2 (preserves flag-don't-force + config-over-code). Two stages: (1) read-only — name the missing sex and list qualified, available employees who could cover; (2) one-click apply-a-swap. Dependencies: gate on SCHED-EDIT-1 verified; needs an engine swap-suggestion helper (shares eligibility/ranking infra with the gap resolver and the retired attribute-mix logic). Sequence after SCHED-EDIT-1; overlaps with gap-resolver / Role Groups work.
- **Soteria fully operational** — natural-language control of all of Homebase + can edit the schedule.
- **Manual builder recommends employees with engine-level efficacy** — surface the engine ranking in the manual builder.
- **Dedicated security track** (for client acquisition) — `/api/*` auth audit, wax-seal replay/timestamp window, RLS review, secrets hygiene, remove dead IP-allowlist fallback.
- **DELIV-1** — SPF/DKIM/DMARC + sender warm-up; gates the 30-person `distribute_schedule` fan-out.

### Tier 3 — polish / smaller fixes
- `saveTemplate id:''` bug in `TemplateEditorPanel` (before any client edits a template).
- Hour rounding in the schedule tab for contributors.
- Schedule download format should match the schedule builder (ties to `xlsx → exceljs`).
- Orange glow around each rule (Rules tab UI).
- Quria-admin-only: delete activity logs; delete old schedules (gated destructive actions).
- **Strip committed `node_modules` from Aegis history** (~142MB across 2 historical commits — surfaced during the 2026-06-09 secret-scrub audit). Confirm `node_modules` is in `.gitignore`. Safe to force-push the rewrite later (solo repo).
- **Reference-doc refresh** — items surfaced in `PRIORITY2_ANALYSIS.md` §3 / SCHEMA_DRIFT_LOG: docs 02/04/06 still describe the gender rule as **dormant per-shift `attribute_mix`** with a **single-variant `FlaggedIssue`** — reality is `sex_coverage` (scope=`concurrent_coverage`) + a discriminated union (incl. `unsatisfied_sex_coverage`); docs 05/06 carry the ruled-out ENGINE-1 hypothesis (`qualified_roles` miscased / `max_weekly_hours` null) — real cause was availability precision + the JL structural miss; doc 03 §7 cites a Homebase `src/db/types.ts` that doesn't exist (types live in `src/lib/types.ts`); SCHED-EDIT-1 and in-tab `decided_by` are described as open but have shipped fixes. Reconcile on the next doc pass.

### Business / ops (non-dev — tracked, not on the build timeline)
- Fix Quria landing page: add SME AI-integration consulting service line.
- Travis Stoliker follow-up.

---

## Standing principles (do not violate)
- **No orphan outputs:** every AI change (Aegis, Soteria, engine) lands as valid, visible Homebase state within the constraints.
- **Diagnose before fixing.** Read the actual diff before any push. Don't trust "tsc clean" without seeing it.
- Verify column names against `information_schema` before any write (`src/db/types.ts` is incomplete — see `SCHEMA_DRIFT_LOG.md`).
- Classifier prompts inject today's date (timezone-aware). Employee emails never link to Homebase. One Soteria action per response. The schedule build is LLM-free.
- "Feels like a person" tone on every Aegis string.
- Never distribute a real Watermark schedule without manager coordination (Carolyn, Jack) — and not while SCHED-EDIT-1 is open.
- **Configuration over code:** the engine/platform is generic and multi-tenant; client behavior is driven by their Supabase data + the constraint vocabulary, never by client-specific code. Accommodating a client is a data/config operation, not an engine change. Per-client rules are toggleable (e.g. sex_coverage on/off). If a client needs something the vocabulary can't express, that's a product conversation — never a quiet engine patch.

## Reference map
- Stable reference: the six `.docx` (01 Business, 02 Schema, 03 Homebase, 04 Aegis, 05 Dev Guide, 06 Supplemental).
- Live trackers: this file (sprint/progress), `EMAIL_WORKFLOWS_TRACKER.md` (email workflows), `SCHEMA_DRIFT_LOG.md` (append-only drift), `TEST_IDENTITIES.md` (tenants/identities).

---

## SESSION LOG (append-only)

### 2026-06-08 — Doc refresh + sprint definition
- Rewrote all six `.docx` reference docs to v3.0 (Engine V2, post-launch reality, resolved schema drift). Updated `SCHEMA_DRIFT_LOG.md`, `TEST_IDENTITIES.md`, `EMAIL_WORKFLOWS_TRACKER.md`.
- Logged two live bugs: ENGINE-1 (engine skips eligible employees) and SCHED-EDIT-1 (manual edits don't persist).
- Defined the 48-hour sprint: S1 ENGINE-1, S2 SCHED-EDIT-1, S3 manual-approval-notify. All diagnose-first.
- **Next session:** run the three diagnostic prompts (S1 dry-run + disposition dump in Aegis; S2 save-handler read in Homebase; S3 approve-path read). Fill in each item's Diagnosis section here before writing any fix.

### 2026-06-08 (cont.) — availability fix + fairness question
- Confirmed Erin's availability ended 21:00 vs Afternoon 21:15; extended availability (data fix), verified.
- Post-fix sample still schedules Erin once; repeat names observed. Opened ENGINE-2 (S1b) as DIAGNOSING — suspected hours-fairness not distributing load, four competing hypotheses, instrumented dry-run pending.
- Corrected agent error: AManager is a real role, not a typo (no cleanup, no drift entry).

### 2026-06-08 (cont. 2) — ENGINE-2 root cause + S3 diagnosed
- ENGINE-2 is NOT a fairness bug. Fairness pipeline verified intact. Root cause = enforceAttributeMixForShift post-fill swaps (active gender_requirement, 1M+1F/shift, all shifts) displacing ranker picks without backfill; same-day-doubles not re-evaluated. Erin/Kori/Michael starved to 6.3h, Lucas 26.3h. Two problems: (A) engine no-backfill, (B) policy decision. gender_requirement documented dormant but is LIVE — doc correction needed (04 §2.4, 06 §9).
- S3 diagnosed: in-tab TO approval does ~1/3 of magic-link path; shared-helper + server-route fix approach agreed; build held.
- S2 reported implemented by recap; IN REVIEW pending Alexander's diff read + tsc + fallback time-source check.
- No engine/Homebase fixes authorized this session — all hold on decisions above.

### 2026-06-08 (cont. 3) — gender rule reframed to temporal coverage
- Real requirement clarified: facility-wide 1M+1F at every staffed moment among counted guard roles (Headguard/Lifeguard/AManager; Greeter + Junior LG excluded; Manager TBD), guard-staff-on-floor, flag-don't-force, no single-staff windows. This becomes the ENGINE-2 fix: new sex_coverage constraint (scope=concurrent_coverage, validate-and-flag, no swap), retiring the per-shift attribute_mix swap that caused the inequity. Contract-first; spec pending Manager-counts confirm.
- S2 found implemented but uncommitted/unreviewed; expanded scope to GapResolverPanel + ManualScheduleBuilder. IN REVIEW pending Alexander's diff read + tsc + fallback check.

### 2026-06-09 — S2 residual closed + S3 built; cross-repo coverage-flag gap surfaced
- **Repo state at session start:** Aegis `main` ahead of origin by 3 (unpushed), with uncommitted edits to CLAUDE.md/DEV_ROADMAP.md + 2 untracked diagnostic scripts (diagnose-s1.ts, verify-sex-coverage.ts). Homebase `main` ahead by 2 (unpushed); the SCHED-EDIT-1 fix is committed (`f28cb30`), with an uncommitted CLAUDE.md edit + untracked `.claude/`. **Neither repo is fully committed/pushed** — flagged to Alexander (no push performed; his call). Roadmap is current. NOTE: orphan copies on Desktop (`CLAUDE_for_Aegis.md`, `CLAUDE_for_Homebase.md`, `DEV_ROADMAP.md`) exist outside both repos — the in-repo Aegis `DEV_ROADMAP.md` is canonical; recommend deleting/reconciling the Desktop copies to avoid drift.
- **S2 / SCHED-EDIT-1 residual CLOSED (code axis).** Answered the open question: `buildCanvas` sources slot `start_time`/`end_time`/`hours` from **shift_types** (`canvas.ts:89,100-105`), role from `shift_requirements`. The Homebase empty-target fallback (`resolveAssignment.ts:24-27`) uses shift_types — matches. `shift_requirements` carries its own time columns but the engine ignores them. Save-time backstop wires real shift_types in. Independent `tsc` = 0 errors. The two unscoped files = byte-identical `computeHours` dedup (safe). Only the live round-trip remains before DONE.
- **S3 BUILT (uncommitted, Homebase, 4 files):** shared `decideTimeOffRequest` helper + `POST /api/time-off-decision` route (cookie-auth, same-company guard) + magic-link dispatcher refactored onto the same helper + manager toast in TimeOffTab; `decided_by` now set on the in-tab path; guarded pending-only update on both paths. `tsc` = 0 errors; diffs reviewed; NOT pushed. **Open for Alexander:** confirm `AEGIS_URL` + `AEGIS_INTERNAL_SECRET` on Vercel (absent from `.env.local`, unverifiable from here); run the live round-trip with a sandbox/test identity (not a live employee).
- **Cross-repo coverage-flag check (priority 3) — RESULT: won't break, but the required surfacing is UNBUILT.** Homebase's schedule view reads `schedule.data.gaps` but **never reads `flagged_issues`** — no `.tsx` references it at all. So the new `unsatisfied_sex_coverage` variant cannot crash the view (nothing parses it). BUT roadmap line 111(a) requires the coverage flag to surface as a visible manager action item in the Homebase schedule view, and that renderer does not exist yet. Also a **type-contract mismatch**: Aegis emits a discriminated union (`{type,date,description,metadata}`, no `shift_name`/`severity`/`message` on the sex_coverage variant) while Homebase's `FlaggedIssue` interface is `{type,severity,message,metadata}`. A renderer built against the current Homebase type would read `.message`/`.severity` that Aegis never sends. **Precondition for the policy flip is therefore NOT met.** Proposed next step (NOT built — sits in the gated sex_coverage track): reconcile Homebase's `FlaggedIssue` to Aegis's union, then build a coverage action-item renderer (no-shift_name, time_window from metadata) + coalesce contiguous same-missing-sex flags.
- **Held for Alexander's decision (not touched):** the `sex_coverage` policy_value_json flip (scope=concurrent_coverage) — engine code may run ahead but the policy migration awaits Watermark management sign-off + your go. NOTE: "Phase 2 coverage-bias" appears **already decided as NO** on 2026-06-08 (line ~111) — flagging in case you want to re-open or confirm. Did not touch the gender rule's live behavior.
- **Next session:** (1) Alexander reviews S3 diffs + confirms Vercel env + runs the S3 live test; (2) flip SCHED-EDIT-1 → DONE after the live round-trip; (3) on your go, build the Homebase coverage-flag renderer (precondition for the sex_coverage flip).

### 2026-06-09 (session 2) — standardization sweep + finished the gender rule (code)
Theme: cleanup + drift reconcile + finish sex_coverage. Posture: fix-now if safe; prepare-don't-execute anything that writes production or pushes/deploys. All `tsc` runs clean (both repos).
- **PART A — cleanup (done).** Deleted 3 stale Desktop orphans (`CLAUDE_for_Aegis.md`, `CLAUDE_for_Homebase.md`, `DEV_ROADMAP.md` — confirmed older than the in-repo canonical copies). Deleted an empty botched-`mkdir` junk tree in Homebase (`{src/{app/...}` — zero files, untracked). Standardized `.claude/settings.local.json`: gitignored in both repos, `git rm --cached` in Aegis (was tracked). Kept the two diagnostic harnesses (`scripts/diagnose-s1.ts`, `scripts/verify-sex-coverage.ts`) and tracked them (they match the existing `scripts/` harness pattern). Left gitignored artifacts (`dist/`, `dry-run-output.json`) in place.
- **PART B — drift audit (diagnosed; safe reconciles done, rest presented).** Reconciled NOW (Homebase, tsc-clean): `FlaggedIssue` → Aegis union; `ScheduleData.summary` → optional; `ScheduleGap` += `description?/start_time?/end_time?`. Presented for go (rippling): adding `employees.sex` + `shift_requirements.accepted_roles` to Aegis `src/db/types.ts` (ripples into ~15 `smoke.ts` fixtures). Deferred: shared `StaffingReport` contract (producer is untyped `Record<string,unknown>`; shapes currently agree on consumed fields). Full details + stale-doc list in `SCHEMA_DRIFT_LOG.md` (2026-06-09 entry).
- **PART C — gender rule (code DONE; flip pending).** (a) Homebase renders coverage flags (`CoverageFlags` component, mounted in the current-schedule view + history report detail). (b) Aegis `sex-coverage.ts` coalesces contiguous same-missing-sex segments → one flag; verified by synthetic check (PASS). (c) Policy-flip SQL prepared, presented to Alexander (NOT executed). Live verify harness blocked in-sandbox (no Supabase egress) — run it where the DB is reachable.
- **PART D — S3 live verification: SKIPPED (could not confirm prereqs).** `AEGIS_URL`/`AEGIS_INTERNAL_SECRET` absent from Homebase `.env.local`, Vercel env not inspectable from the agent, and network egress is blocked — so the sandbox TO round-trip and the SCHED-EDIT-1 DB round-trip could not run. Both remain manual steps for Alexander.
- **PART E — self-enforcing protocol baked into BOTH `CLAUDE.md`** (session-start read; fix-now bias; defer-only-with-logged-reason; session-end write-back). Also fixed Homebase `CLAUDE.md`'s `src/db/types.ts` path (Homebase has none — types live in `src/lib/types.ts`).
- **PART F — logged + committed locally in logical groups; NOT pushed.** Commits + the policy-flip SQL presented for Alexander. Pushes + the Supabase flip are his to run.
- **Deferred (with reasons, logged):** db/types.ts column add (ripples into test fixtures → SCHEMA_DRIFT_LOG); shared StaffingReport contract (medium → SCHEMA_DRIFT_LOG); reference-doc refresh for gender_requirement dormant→live + Soteria prompt's attribute_mix model (large → SCHEMA_DRIFT_LOG); S3 + SCHED-EDIT-1 live round-trips and the sex_coverage live verify (no DB/network in sandbox → above); the policy flip itself (Alexander/management call).

### 2026-06-09 (session 3) — SECRET INCIDENT: GitHub push-protection block + history scrub
**Trigger:** GitHub secret scanning blocked the Aegis push — a Twilio **Account SID** in `docs/01_Business_Overview.md` (original scaffold commit, was `16018a5`). Stop-the-line: no push/force-push; prepared a clean state for Alexander to push.
- **Audit (offline; no network — gitleaks/trufflehog/PyPI all unreachable, built a regex/entropy scanner over full object history of BOTH repos).**
  - **No TRUE secrets in history → NO ROTATION REQUIRED.** Every credential-shaped string is a placeholder in `.env.example` (`ACxxxx`, `your_token`, `SG.xxx…`, header-only `eyJhbG…` JWT stub len 39, `sk-ant-…` len 13). Real keys are 100–220 chars; all matches are short examples.
  - **No `.env` (non-example) was EVER committed** in either repo.
  - **Flagged identifiers (scrub, no rotation):** Twilio **Account SID** (`AC…`) and **Messaging Service SID** (`MG…`) — in exactly two files ever: `docs/01_Business_Overview.md` and `docs/04_Aegis_Reference.md`. The Aegis SMS number (`+1616…`) is a known public-ish identifier (already in TEST_IDENTITIES) — left as-is.
  - **Homebase history: CLEAN** of credentials/identifiers (only code false-positives) — no scrub needed.
  - **Bonus finding (NOT a secret, flagged for Alexander):** `node_modules/` was committed in 2 historical commits on Aegis (~142 MB of bloat that will push). Out of scope for this secret task; recommend a separate `node_modules` history strip before/with the push if the size matters.
- **Scrub (Aegis only):** `git filter-repo` couldn't be installed offline (PyPI proxy-blocked), so used the built-in equivalent: `git filter-branch --index-filter` (no working-tree checkout → node_modules not materialized) scoped to the two doc files across `--branches`, replacing the SID literals with placeholders (`AC••• — redacted (see Railway env / password manager)`). Dropped `refs/original`, expired reflogs, `git gc --prune=now`.
- **Verified clean:** re-scan of full Aegis history = **0** AC/MG SID occurrences; working tree clean (redaction baked into every commit, so no separate redaction commit exists/needed); `tsc` clean both repos; origin remotes intact on both (filter-branch keeps them — no re-add needed).
- **Push is a FAST-FORWARD (no force needed):** the SID scaffold commit was never on origin (it lived in the unpushed range), so the rewrite produced new commits atop the unchanged origin base. `git push origin main` works normally for both.
- **PART 2:** added a "no secrets/sensitive identifiers in committed files — reference docs included" hard rule to BOTH `CLAUDE.md`.
- **Standing action for Alexander:** decide whether to also strip the committed `node_modules` from Aegis history (separate rewrite) before pushing.

### 2026-06-09 — Sprint go-live (in progress) + ENGINE-2 + secret scrub
- Aegis pushed & live (46eaa70) after a GitHub secret-scan block; Twilio SIDs scrubbed from history (docs 01/04), no .env ever committed, no rotation. node_modules committed in 2 Aegis commits (~142MB) — flagged, deferred.
- ENGINE-2: bimodal Headguard hours root-caused to the post-fill per-shift attribute_mix swap (not a fairness bug); replaced with sex_coverage (validate-and-flag). Policy flipped; confirmed live (hours flattened + flag in manager email).
- S1/ENGINE-1 ruled out as engine bug (Erin availability fixed; JL-zero-hours is structural -> Role Groups; 2 decisions pending).
- S2 (f28cb30) and S3 (f8e2505) committed, IN REVIEW pending Homebase push + live verify.
- Homebase ahead 8, UNPUSHED — S2/S3/CoverageFlags renderer/type reconcile/CLAUDE.md rule all dark until pushed (why the flag shows in email but not the Homebase schedule view).
- New goal logged: coverage-flag resolver (Tier 2).
- Next: push Homebase -> verify S2/S3 + flag display -> confirm Vercel env -> doc refresh; ENGINE-1 residual + forward-plan A/B/C await Alexander's call.
