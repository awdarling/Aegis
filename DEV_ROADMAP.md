# QURIA — Development Roadmap & Progress Tracker

**Living document. Last updated: June 8, 2026.**

This is the operational source of truth for active development. It is meant to be read and updated by Claude (Claude Code / Cowork) every session.

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
**Repo:** Aegis (`src/lib/engine/`) · **Status:** `NOT STARTED`
Aaron Barrigan (Headguard, fully available) is never placed. Erin Berigan reported as "can't work" with no custom availability. Suspected systemic, not one-off.

- Diagnosis (fill in before fixing):
  - [ ] Dry-run built for the affected week; `per_employee_dispositions` dumped for Aaron, Erin, **and full roster**
  - [ ] Aaron's & Erin's `employees` rows pulled (`primary_role`, `qualified_roles`, `max_weekly_hours`, `active`) + their `availability` rows
  - [ ] Disposition reason identified (`not_qualified` / `availability_mismatch` / `max_hours_reached` / `eligible_but_unchosen` / …)
  - [ ] Determined: roster-wide pattern or isolated? (count how many employees show the same reason)
- Fix (only after diagnosis):
  - [ ] Root cause fixed (data re-tag OR code normalization in `isQualifiedForRole`, per evidence)
  - [ ] Dry-run re-run confirms the missing people are now placed
- **Done when:** the affected employees are scheduled in a dry-run, and no other employee is being silently dropped for the same reason.

### S2 · SCHED-EDIT-1 — Manual schedule edits don't persist
**Repo:** Homebase (`src/app/(app)/schedule/page.tsx`) · **Status:** `NOT STARTED`
Moving an employee between shifts updates the displayed card but not `schedules.data.assignments`; distribute then sends the new shift name with stale hours. **This gates safe distribution — no manual-edited schedule may be distributed until this is green.**

- Diagnosis:
  - [ ] Manual-edit save handler read; determined whether it persists to Supabase at all
  - [ ] Identified which fields it carries vs drops on a move (`shift_name` vs `start_time`/`end_time`/`role`/`hours`)
- Fix:
  - [ ] A move recomputes the **full** assignment object from the target slot and persists the complete `ScheduleData`
  - [ ] Verified: edit → reload → DB shows corrected hours → a (test) distribute reads correct hours
- **Done when:** a manual move round-trips to the DB with all fields correct and distribute reflects it.

### S3 · Manual TO approval in Homebase doesn't notify the employee
**Repo:** Homebase Time Off tab → Aegis notify bridge · **Status:** `NOT STARTED`
The email magic-link approval notifies the employee; the in-tab Homebase approval does not. Also set `decided_by`, and have Aegis acknowledge the acting manager.

- Diagnosis:
  - [ ] In-tab approve/deny path read; Aegis employee-notification function (used by the magic-link path) located
- Fix:
  - [ ] In-tab approval fires the same employee notification
  - [ ] `decided_by` set on the in-tab path
  - [ ] Manager gets a "got it — change made and employee notified" acknowledgment
- **Done when:** approving a TO in Homebase notifies the employee and the manager, and `decided_by` is populated.

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
- **Role Groups** — `shift_requirements.accepted_roles` (exists, NOT read yet); structural fix for Headguard coverage gaps. Engine eligibility before UI. (Distinct from ENGINE-1: that's a bug, this is a feature.)
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
