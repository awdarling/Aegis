# 07 — Data Contract (Write / Read)

**Status:** v1, 2026-07-12. Derived from a full audit of the Aegis engine reads, all Aegis
workflow/webhook writes, and every Soteria executor action.

## Why this document exists

Quria has **three write channels** into one database — **Soteria** (Homebase chat),
**Aegis** (employee/manager email, later SMS), and the **Homebase UI** — and one set of
**engines** that read it (the schedule build engine, the constraint parser, the manual-edit
validator). If a channel writes a concept into a column no engine reads, the product lies to
the user: it confirms the change, shows it back, and then behaves as if it never happened.

That has already happened three times (stale `policy_value_json`; the Soteria build that
never fired; a hallucinated Soteria verdict). **This file is the contract that makes those
bugs impossible to reintroduce.**

### Rule 0 — WHAT THE MANAGER SEES IS THE TRUTH (Alexander, 2026-07-13)

> *"Whatever the manager sees, updates, and saves needs to be what the entire system uses
> across all of its features. There shouldn't be anything saved anywhere other than what the
> manager directly sees and interacts with, and that should be the only data any of the
> workflows pull — otherwise it's not actually tailored to the client."*

This outranks the three rules below; they are how you obey it. Concretely:

- **The row behind the manager's own edit surface is the canonical row.** For shifts that is
  `shift_types` (the shift box in the Data tab). For scheduling rules it is the Rules screen's
  policy row. If an engine reads something else, the engine is wrong — not the manager.
- **A field the manager cannot see must not influence behavior.** If code reads a column the
  manager never sets, that column is either a cache (and must be provably derived) or a bug.
- **Config-over-code multi-tenancy dies without this.** The whole product promise is that a
  client's behavior comes from their own data. A hidden copy the manager never touched is, by
  definition, not their data.

**First violation found — and now ELIMINATED (2026-07-13).** `shift_requirements` stored
copies of `shift_name` / `start_time` / `end_time` / `days_active`, stamped from `shift_types`
at creation and invisible to the manager. They drifted in production (D4 — 8 of 12 Watermark
rows, one by 2.5h) and were read by the Aegis coverage simulator, Homebase's `GapResolverPanel`
(which emails an employee their shift hours) and `ManualScheduleBuilder` (which writes the
schedule). **All readers now join `shift_types`; all writers stopped; `shift_type_id` is
`NOT NULL`; the four columns are DROPPED** (`Drop_Shift_Requirement_Mirrors.sql`). A shift is
now defined in exactly one place: the shift box. **The schema itself now enforces Rule 0 here —
there is nowhere else to put it.**

**Use this as the template.** When you find the next Rule 0 violation, the sequence is:
(1) make every engine/workflow read the manager's row, (2) stop every writer copying it,
(3) link/enforce the FK, (4) **drop the copy** — don't settle for keeping it in sync.

### Rule 0b — ONE QUESTION, ONE FUNCTION (Alexander, 2026-07-13)

Rule 0 governs **data**: one fact, one place. Rule 0b governs **logic**, and it exists because
duplicated logic rots in exactly the same way — someone fixes one copy, the others silently
disagree, and the product lies to a different user through a different channel.

> **If two workflows need the same answer, they call the SAME function.**
> A workflow that reimplements a check is a bug waiting to disagree with its siblings.

**The case that proved it.** *"Can this employee work this slot?"* was answered in **eight**
places, each with its own copy. Six compared against a **single** role string. So when a
manager configured a shift to accept *"Lifeguard **or** Headguard"* — an ordinary thing to want
in any business — the engine happily **scheduled** a Headguard onto it, and the swap workflow
then told that same Headguard they were **"not qualified"** for the very same shift. The
time-off simulator warned about gaps that didn't exist. The gap-resolver hid qualified staff
from the manager trying to fix the gap. **The column existed, the UI wrote to it, and seven of
eight readers ignored it.**

**Now:** every workflow routes through **`src/lib/qualification.ts`** — `isQualified()`,
`canFill()`, `acceptedRolesOf()`, `roleLabel()`. There is no role vocabulary, no fixed number
of roles, no assumption about what a business calls its jobs. Any client, any roles, any
combination — and every engine and workflow agrees, because there is only one answer.

**Corollary — NO CLIENT NAMES IN CODE.** `employee-onboarding.ts` hardcoded *"Welcome to
Watermark"* and *"Aegis — Watermark Country Club"* as email subjects; every future client's
employees would have been welcomed to Watermark. A `loadCompanyName()` helper already existed.
**If you are typing a client's name into a string, it is a config value.** Client identity comes
from `companies` / `company_profiles`, always.

### The three rules

1. **One concept → one canonical column.** Never mirror a concept into two columns. If two
   columns exist for one idea, one is legacy and must be retired — not dual-written.
2. **Every write must land where an engine reads.** If you add a writer, you must name the
   reader. A write with no reader is a bug, not a feature.
3. **Every channel must be able to express every supported concept.** If Soteria can set it
   but a manager on email cannot (or vice versa), that is a gap to close or a capability to
   stop advertising.

### ⚠️ The `policies` trap — read this before touching a policy write

`policies` looks like one table. It is **two tables wearing a trench coat.** The canonical
column depends on the `policy_key`, and the two families have **opposite** conventions:

| | Engine family | Time-off family |
|---|---|---|
| Reader | `lib/constraints/parser.ts` | `lib/time-off-policies.ts` |
| Canonical column | **`policy_value_json`** | **`policy_value` (TEXT)** |
| `policy_value` (text) | display only | **the source of truth** |
| `policy_type` | ignored | **load-bearing** — loader does `.eq('policy_type','time_off')` |
| Keys | the `*_KEYS` sets in `parser.ts` | `max_consecutive_days_off`, `min_notice_period_days` |

There is **no generic "write a policy"**. Writing the time-off family the way you'd write the
engine family — a human display string in `policy_value` — makes `parseInt10` return `NaN` →
`null` → **the rule silently switches OFF**. Writing the engine family the way you'd write the
time-off family leaves `policy_value_json` stale → **the engine keeps enforcing the old rule.**

**Therefore: never write `policies` directly. Go through `src/lib/policy-write.ts`
(`coercePolicyWrite`), which resolves the family and returns the exact column patch.** It
imports the key sets *from the parser*, so the writer and the reader cannot drift apart. A
key in neither family is **inert** — `coercePolicyWrite` refuses it rather than let a manager
configure a rule that does nothing.

---

## 1. The contract — concept → source of truth

| Concept | CANONICAL source of truth | Writers | Engine reader |
|---|---|---|---|
| Employee roster | `employees` (`name, primary_role, qualified_roles, max_weekly_hours, active, is_veteran, individual_wage, contact_*`) | Soteria, Aegis onboarding, Aegis manager-edit, UI | `schedule-build.loadData`; eligibility (`qualified_roles`, `active`, `is_veteran`); ranker (`primary_role`) |
| Standing availability | `availability` (`employee_id, day_of_week, start_time, end_time`) | Soteria, Aegis (employee + manager email), onboarding | `engine/eligibility.ts` |
| Temporary / rotating availability | `custom_availability` (`type, patterns, end_date, cycle_*, active`) — **newest active row wins; REPLACES standing availability** | Soteria, Aegis employee-initiated change | `lib/custom-availability.ts` |
| Approved time off | `time_off_requests` (`start_date, end_date, time_off_type, partial_days`, `status='approved'`) | Aegis (email flow + magic link), Soteria `batch_create_time_off`, Homebase UI | `lib/to-window.ts` |
| Shift structure | `shift_types` (`name, start_time, end_time, days_active, active`) — **the ONLY source of shift times & active days** | Soteria, Aegis manager-edit, UI | `engine/canvas.ts` |
| Staffing requirement | `shift_requirements` (`shift_type_id, role, required_count`) | Soteria, Aegis manager-edit, UI | `engine/canvas.ts` |
| Scheduling rules (**engine family**) | `policies.policy_value_json`. For THIS family `policy_value` (text) is display-only and `policy_type` is ignored. Keys = the exported `*_KEYS` sets in `lib/constraints/parser.ts` | Soteria (guarded), Aegis manager-edit (via `lib/policy-write.ts`), UI | `lib/constraints/parser.ts` |
| Time-off rules (**time-off family**) | `policies.policy_value` — **TEXT, and it is CANONICAL here** (read with `parseInt10`). **`policy_type='time_off'` is LOAD-BEARING** — the loader filters on it; lose it and the row is never even SELECTed. `policy_value_json` is ignored. Keys = `max_consecutive_days_off`, `min_notice_period_days` | Soteria, Aegis manager-edit (via `lib/policy-write.ts`), UI | `lib/time-off-policies.ts` |
| Special events / staffing exceptions | `events.event_shifts` — **canonical.** Supports per-role counts (`stretch`+`roles[]`), time changes, and brand-new one-off shifts (`mode:'add'`) | Soteria `add_event`/`update_event`, Aegis manager-edit | `lib/engine/event-shifts.ts` (via `canvas.ts`) |
| Banned / avoided pairs | `employee_conflicts` (`employee_id_1/2, severity`) — `'never'` = hard block; `'avoid'` = soft rank tiebreaker only | Soteria only (**Aegis cannot — see D8**) | `schedule-build` (hard), `engine/ranker.ts` (soft) |
| Veteran / experience rules | `shift_experience_rules` | Soteria, Aegis manager-edit | `engine/experience-rules.ts` |
| Wages | `employees.individual_wage` (**wins**) → falls back to `wage_rates.hourly_rate` | Soteria, Aegis manager-edit | `lib/schedule-simulator.ts` |
| The schedule itself | `schedules.data.assignments` (+ `staffing_report`) | Aegis build/swap/coverage, Homebase editor | Read back by swap/coverage/query paths |
| Conversation state | `aegis_memory` keyed by `source` (`pending_to:*`, `swap_*:*`, `onboarding:*`, `avail_pending_*`, `decision_token:*`, `edit_pending:*`, `coverage_session:*`) | Aegis workflows | Aegis router only — **never read by the engine** |

**Roles are strings, not rows.** There is **no canonical `roles` table for the engine**. A role
is a free-text string matched by exact equality across `employees.qualified_roles`,
`employees.primary_role`, `shift_requirements.role`, `wage_rates.role`,
`shift_experience_rules.role`. The `roles` table exists for the UI (name + colour) only. A typo
anywhere silently makes an employee unqualified.

---

## 2. DRIFT REGISTER — confirmed disconnects

### P0 — silently produces a wrong schedule or loses the user's intent

| ID | Drift | Impact | Fix |
|---|---|---|---|
| **D1** | ✅ **FIXED 2026-07-13.** Aegis manager email-edit wrote `policies` text-only (`update({[field]: value})`), leaving `policy_value_json` stale → engine kept enforcing the old rule. **The fix surfaced a bigger finding: `policies` has TWO reader families with opposite conventions** (see the trap table above) — so the "obvious" fix (convert everything to JSON) would have silently switched OFF the time-off rules. | — | **`src/lib/policy-write.ts` → `coercePolicyWrite(policy_key, raw)`** resolves the family and returns the exact column patch; imports the key vocabulary *from the parser* so writer and reader can't drift. Refuses inert keys, refuses out-of-range values the parser would silently drop, refuses free-text `attribute_mix`. 13 unit tests round-trip the written row back through the REAL `parseConstraints`. |
| **D2** | ✅ **FIXED 2026-07-13.** A swap could be `approved` while the schedule never changed. **Worse than first logged:** the *"your swap has been approved!"* emails to BOTH employees sat **outside** the `if (schedRow && receiver)` guard, so with no published schedule the row said approved, both people were told it was done, and the schedule was untouched. The person who believed they were covered wouldn't show up. Three silent exits (no schedule / no matching assignment / unchecked write), plus a **no-op write that reported success**. | — | **The schedule write is now authoritative.** `executeScheduleSwap`/`Trade` return `SwapApplyResult` (`{ok:true, schedule_id}` \| `{ok:false, code, reason}`) instead of `void`. `decision.ts` applies the schedule change **first**; only if it lands does it write `status='approved'` **together with the new `swap_requests.schedule_id` receipt**, and only then notify. On failure the row **stays `pending_manager`**, nobody is notified, and the manager gets a page telling them exactly why (e.g. "publish that week first"). The auto-approve path records `pending_manager` + honest "not final yet" messages instead of a false confirmation. **Requires migration `Add_Swap_Requests_Schedule_Id.sql`.** 7 new tests. |
| **D3** | ✅ **FIXED 2026-07-13.** `pending.field` (LLM-supplied) was interpolated into `.update({[field]: value})` and `create_fields` was arbitrary LLM JSON — any column on an allowed table was writable, including `employees.company_id` (cross-tenant write). | — | `EDITABLE_COLUMNS` / `CREATABLE_COLUMNS` allow-lists in `operational-query.ts`, verified against `information_schema`. Enforced **twice**: at confirmation time (so the manager isn't asked to confirm a change we'll refuse) and again at the write. `company_id` is always forced from the verified contact, never the model. Deliberate omissions documented in-code (`aegis_access`, denormalized `shift_requirements` copies, structured `event_shifts`). |
| **D3b** | ✅ **FIXED 2026-07-13 (found while fixing D3).** **Every write in `executeEdit` was unchecked** — `insert`/`update`/`delete` results were never inspected, so a rejected write (constraint violation, type error) fell straight through to the *"Done — updated"* reply. A pure orphan-output bug on the manager's most trusted surface. | Manager is told a change landed when the DB refused it. | All three now check `error` and throw; `handleEditConfirmation` passes the manager-facing reason through instead of a generic dead-end. |
| **D4** | ✅ **FIXED 2026-07-13.** `update_shift_type` never cascaded to the `shift_name/start_time/end_time/days_active` **copies** on `shift_requirements`. **Confirmed live, not theoretical: Watermark had 8 of 12 rows drifted** — `Day/Greeter` said 12:00–18:00 while the real shift type was 11:00–19:30 (**2.5h out**). The schedule engine was never affected (`canvas.ts` builds from `shift_types`). But the **Aegis time-off coverage simulator** read `req.start_time/end_time` to decide whether approving time off opens a gap → **wrong verdicts on a live workflow** — and **Homebase `GapResolverPanel`** built the employee-facing *"you've been added to the AM shift (11:30–15:30)"* message from it → **told the employee the wrong hours.** | — | Two-sided: (1) **Aegis** `schedule-simulator.ts` now resolves `start/end/name` from the parent `shift_type` (falls back to the local copy only for legacy `shift_type_id IS NULL` rows) — the canonical read. (2) **Homebase** `update_shift_type` now cascades to the mirrors, so every remaining mirror-reader stays honest. (3) `Repair_Shift_Requirement_Mirrors.sql` fixes the already-drifted rows. **End state: drop the mirror columns** (blocked today — they're NOT NULL and several UI components read them). |
| **D5** | ✅ **FIXED 2026-07-13.** `update_role` rename cascaded to `employees.primary_role`, `employees.qualified_roles`, `shift_requirements.role`/`accepted_roles` — but **not `wage_rates.role`** and **not `shift_experience_rules.role`**. `delete_role` didn't check them either. Renaming "Lifeguard"→"Guard" silently orphaned the role's pay rate **and every veteran/experience rule scoped to it** — they stop applying, with no error and no gap flagged. | — | Cascade extended to both tables; `delete_role` now blocks on wage-rate and experience-rule references and names them. **Also corrected a dangerous comment:** `shift_requirements.role` was labelled "legacy" — it is in fact **the column the engine matches on**; `accepted_roles` is the inert one (D10). |

### P1 — the product promises something it cannot do

| ID | Drift | Impact | Fix |
|---|---|---|---|
| **D6** | ✅ **FIXED 2026-07-13.** `capabilities.ts` is a **shared** Soteria+Aegis product list — and it was injected into Soteria's system prompt under the heading *"WHAT YOU CAN DO FOR THIS USER"*. So the model read *"approve or deny time-off"*, *"arrange emergency coverage"* and *"swap a shift"* as **her** abilities. **No executor exists for any of the three.** | — | **We did NOT build those actions — we stopped claiming them** (Alexander's call: Soteria configures, Aegis converses; if she absorbs his job the manager stops using him and the product loses its point). New `soteriaScopeSection()` states a **hard boundary**: what she does herself, what she may **ASK AEGIS** to do, and what is **Aegis's alone** — with the exact hand-off wording ("That one's Aegis's job — email him and say…"). The product list is retained but re-labelled as the product, not her. |
| **D7** | ✅ **FIXED 2026-07-13.** No `distribute_schedule` action — she could build but not send. | — | Added, as a thin pass-through to the **same** `/internal/distribute-schedule` endpoint the Homebase Distribute button uses (no second implementation). **Emails every employee**, so: company-scoped schedule lookup (never trusts the LLM's `schedule_id`), explicit confirmation required, and Aegis's `already_distributed` guard means an accidental second confirm cannot spam 30 people. All copy says **"I've asked Aegis to…"**, never "I've done it." Also fixed stale UI copy promising *"you'll receive a text"* — SMS is off under EMAIL_ONLY. |
| **D8** | ✅ **FIXED 2026-07-13.** `employee_conflicts` was settable in Homebase and via Soteria but **NOT by emailing Aegis** — the assistant the manager pays for couldn't do a thing their website could. | — | New `banned_pair` entity + `handleBannedPairEdit` in `operational-query.ts` (needs its own parse because it names TWO employees). Classifier examples added. Writes the **same table** the UI and Soteria write and the engine reads — a new CHANNEL, not a new concept. Unordered-pair matching (A,B ≡ B,A) so it can't duplicate or fail to delete. Severity defaults to `never` when the manager's wording isn't clearly hedged (**over-restricting is visible and undoable; under-restricting silently pairs people the manager wanted apart**). |

### P2 — configured-but-inert (writers set it; nothing reads it)

| ID | Column / setting | Reality |
|---|---|---|
| **D9** | `shift_requirements.days_active` | **Dormant.** Only `shift_types.days_active` is consulted; the loaded value is overwritten before canvas sees it. |
| **D10** | `shift_requirements.accepted_roles` | ✅ **FIXED 2026-07-13 — this was LIVE at Watermark.** Their **Flex** shift is set to accept *"Lifeguard **or** Headguard"*. The engine read only `role` (= the first entry), so **a Headguard could never fill it** — the build reported a phantom GAP while a qualified person sat available. Rule 0 inverted: visible data the engine ignored. `CanvasSlot` now carries `accepted_roles`; eligibility uses `isQualifiedForSlot` (any accepted role); gap copy uses `slotRoleLabel` ("Lifeguard or Headguard") so the flag matches what the manager configured. **Emergency coverage fixed too** — it had the same single-role blindness, so the builder and the call-out workflow disagreed about who was qualified for the same shift. Ranking still PREFERS `role`, so single-role slots are unchanged. 9 regression tests. |
| **D11** | `partial_shifts_allowed`, `conflict_resolution_preference` | ⚠️ **KNOWN INERT — accepted 2026-07-13, deliberately NOT fixed.** Parsed into `EngineSettings` and **never consulted anywhere.** A manager can set them; Soteria and Aegis will both confirm the change; **nothing happens.** Alexander's call: log and move on for now. **Do not let this rot — it is a live Rule 0 violation.** Fix = build them (partial shifts is real engine work: slot splitting, partial assignments, wage/coverage implications) **or** remove them from every manager surface. |
| **D12** | `doubles_policy` | ✅ **FIXED 2026-07-13.** Three values, only two behaviours: the BUILD treats `emergency_only` as `never` (correct — a routine build shouldn't create doubles), and **emergency coverage ignored the policy entirely**, always offering "Already Working" staff. So `never` and `emergency_only` were **identical everywhere** and the setting meant nothing. **Now `never` HARD-EXCLUDES already-working candidates** (Alexander's call). **Safety valve:** if that would leave **zero** candidates in every tier, they are surfaced anyway, explicitly labelled *"your rule says never schedule doubles… picking one means breaking that rule — your call."* Handing a manager an empty list and an uncovered shift is worse than the rule protects against; `never` still means never by default, it just never silently returns nobody. Read via `parseConstraints` (canonical `policy_value_json`, not the display text). |
| **D13** | `employee_conflicts.severity = 'avoid'` | ✅ **Swap paths FIXED 2026-07-13.** `loadHardConflicts` filtered `.eq('severity','never')`, so 'avoid' pairs were **invisible to every swap path** — a manager could say "keep these two apart" and a swap would put them on the same shift without a word. Now both severities load; `bannedCohabPartnerName` (hard) and the new `avoidCohabPartnerName` (soft) split them, and the manager's approval email carries a softer flag for 'avoid'. **Flag-don't-force preserved — neither blocks.** A row with no severity is treated as HARD (over-warn beats under-warn). 5 regression tests. **Still open:** in the BUILD engine, 'avoid' remains a rank tiebreaker below primary-role fit, so avoid-pairs can still be co-scheduled by the builder. |
| **D14** | `events.shift_overrides` | ✅ **FIXED 2026-07-14 (code) — column drop GATED.** The legacy pre-canvas reader `applyShiftOverrides` and all its plumbing (build result, staffing report, manager email HTML + plain-text, dev scripts) are DELETED; `events.event_shifts` → `applyEventShifts` is the sole mechanism. Column was NULL on every row, so zero behavior change (Aegis 253/253, tsc + smoke green). The `db/types.ts` entry + DB column remain until **`~/Desktop/Drop_Events_Shift_Overrides.sql`** is run (safety-checks non-null count = 0, then `DROP COLUMN`), which is the final "drop the copy" step of the Rule 0 template. |

### P2 — integrity / consistency

| ID | Issue |
|---|---|
| **D15** | ✅ **FIXED 2026-07-13, BOTH CHANNELS.** Deleting an employee cascaded only to `availability`. Their approved **time-off** kept blocking coverage maths, and a **banned-pair** rule kept being enforced about a person who no longer existed. Now cascades to `availability`, `custom_availability`, `time_off_requests` and `employee_conflicts` (**both** id columns), dependants first and the employee **last**, so a mid-way failure never leaves the person gone but their rules alive. Fixed in Soteria **and** the Aegis email path. |
| **D16** | ✅ **FIXED 2026-07-13, BOTH CHANNELS.** A `primary_role` outside `qualified_roles` made an employee **unschedulable for their own job** — the engine matches on `qualified_roles` (Rule 0b), so "make Jordan a Headguard" set the title and left the engine refusing to schedule Jordan as a Headguard, with a gap reason saying "not qualified" about the exact role on their record. Now **healed, not rejected**: a manager promoting someone plainly means they can work the role, so the role is added to `qualified_roles`. Identical behaviour in Soteria and Aegis. |
| **D17** | ✅ **NOT A BUG — mis-logged. Closed 2026-07-13.** `decided_by` **is** written where we legitimately know who decided: `lib/aegis-actions/dispatcher.ts` writes it from the token's `issued_to_user_id`. It is `NULL` only on the older **shared** magic-link path, where the link is not tied to a single manager — and **inventing an attribution there would be worse than an honest null**. `decided_at` + the activity log still record the decision. |
| **D18** | ✅ **FIXED 2026-07-13.** Emergency coverage rewrote `schedules.data` but left `staffing_report.estimated_wages` stale — so after a call-out the manager's cost figure described a schedule that no longer existed, and the coverer may be paid a different rate than the person they replaced. Both swap paths already recomputed; coverage was the odd one out. Now recomputes via `computeWageEstimate`. *(Also fixed in the same pass: `findShiftInfo` now carries `accepted_roles` off the assignment, so coverage can't silently re-narrow to one role — Rule 0b.)* |
| **D19** | ✅ **FIXED 2026-07-13.** `coverage_session` was keyed `:<company_id>`, so a second call-out **deleted** the first manager's session (their "more names" thread went dead). Now each call-out has its own `session_id` and its own stored row (`coverage_session:<session_id>`); `ActiveOutreach` and the batch-decision token carry it, so an acceptance/button resolves the exact call-out. The router (`routeManagerCoverageReply`) lists a manager's open sessions and routes a reply to the one whose absent-person/shift the reply names — **asking which one if still ambiguous** rather than guessing. Schedule was always correct (outreach is self-contained); this restores the manager's control of concurrent call-outs. **This is the groundwork for employee-initiated call-outs** (call-outs are now first-class objects). 6 regression tests. |
| **D20** | ✅ **FIXED 2026-07-13.** `writeEmployeeAvailability` deleted by `employee_id` with **no `company_id` predicate** — and, the part with real teeth, **neither the delete nor the insert checked for an error.** A failed DELETE + successful INSERT leaves an employee with BOTH their old and new availability (overlapping windows → looks available on days they just said they can't work); a failed INSERT after a successful DELETE leaves them with **none** — and both paths replied "saved". Now scoped by `company_id` and both writes throw. |
| **D21** | ✅ **FIXED 2026-07-13.** Onboarding time-off extracted only `start_date`/`end_date`, and `time_off_requests.time_off_type` **DEFAULTS to `'full_day'`** — so a new hire saying *"I need the afternoon of the 20th off"* had their **whole day blocked**. Onboarding now extracts `time_off_type`/`period_label`/`start_time`/`end_time` and resolves the window through the **same exported `resolvePartialWindow`** the real time-off flow uses, so the two can't drift on what "afternoon" means. Unresolvable partials fall back to `full_day` rather than dropping the request. |
| **D22** | `soteria_memory` is written straight from an LLM `<memory>` tag — the one Soteria write with no confirmation card and no executor. |

---

## 3. Enforcement (how we stop this recurring)

1. **No new column without a named reader.** A migration that adds a column must state which
   engine/parser reads it, in this file.
2. **No dual-writes.** If you find yourself mirroring a value into a second column to "make the
   engine see it", the schema is wrong — fix the reader or retire the legacy column.
3. **Channel parity check.** Any capability advertised to Soteria (`capabilities.ts`) or to the
   Aegis classifier must have a real executor/handler. Advertised-but-unimplemented is a P1 bug.
4. **Test:** add a contract test that fails if a Soteria action or Aegis edit writes to a
   table/column not listed as canonical in §1.
