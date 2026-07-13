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
| **D4** | **`update_shift_type` never cascades to `shift_requirements`.** Soteria copies `shift_name/start_time/end_time/days_active` onto requirement rows at insert, then never updates them. | Engine is safe (it reads `shift_types`), but the **wage/coverage simulator reads `req.start_time/end_time`** → estimates diverge from reality. Legacy rows (`shift_type_id` null) match on a stale `shift_name` → their slots disappear. | Stop denormalizing (preferred), or cascade on update. |
| **D5** | **`update_role` rename misses two tables.** It cascades to `employees.primary_role`, `employees.qualified_roles`, `shift_requirements.role/accepted_roles` — but **not `wage_rates.role`** and **not `shift_experience_rules.role`**. `delete_role` doesn't check them either. | Renaming "Lifeguard"→"Guard" silently orphans its wage rate and every veteran rule. A role can be deleted out from under its own wage rate. | Extend the cascade + the reference check. |

### P1 — the product promises something it cannot do

| ID | Drift | Impact | Fix |
|---|---|---|---|
| **D6** | **Soteria's capability list over-promises.** `lib/soteria/capabilities.ts` tells the model she can *"approve or deny time-off"*, *"arrange emergency coverage"*, and *"swap a shift"*. **No executor action exists for any of the three.** | A manager asks Soteria to approve time off → dead end or improvisation. Same failure shape as the build bug. | Either implement the actions or stop advertising them. |
| **D7** | **No `distribute_schedule` action.** She can `trigger_schedule_build` but cannot send it out. | Manager must leave the chat and click a button — breaks the "never learn the system" promise. | Add the action (executor + planner vocabulary). |
| **D8** | **Banned pairs are Soteria/UI-only.** `employee_conflicts` has no entry in the Aegis manager-edit `ENTITY_TABLE`, and no Aegis workflow writes it. | A manager cannot set "never schedule these two together" over email. | Add to the Aegis edit surface. |

### P2 — configured-but-inert (writers set it; nothing reads it)

| ID | Column / setting | Reality |
|---|---|---|
| **D9** | `shift_requirements.days_active` | **Dormant.** Only `shift_types.days_active` is consulted; the loaded value is overwritten before canvas sees it. |
| **D10** | `shift_requirements.accepted_roles` | Not read from the DB at all (Role Groups unbuilt). Eligibility matches `qualified_roles` vs `slot.role`. |
| **D11** | `partial_shifts_allowed`, `conflict_resolution_preference` | Parsed by the constraint parser, then **never consulted** anywhere in the engine. |
| **D12** | `doubles_policy: 'emergency_only'` | Treated identically to `'never'` — emergency mode is not wired. |
| **D13** | `employee_conflicts.severity = 'avoid'` | Soft rank tiebreaker only, ranked *below* primary-role fit — so avoid-pairs are routinely co-scheduled. **Completely ignored in all swap paths.** |
| **D14** | `events.shift_overrides` | **Legacy.** Superseded by `events.event_shifts` (a strict superset). Two mechanisms for one concept — retire it. |

### P2 — integrity / consistency

| ID | Issue |
|---|---|
| **D15** | `delete_employee` (Soteria) cascades only to `availability` — orphans `time_off_requests`, `employee_conflicts` (both id columns), `custom_availability`. |
| **D16** | `update_employee` can set a `primary_role` that isn't in `qualified_roles` → the engine will never schedule them for it. |
| **D17** | `time_off_requests.decided_by` is never written by Aegis on either path (always NULL). |
| **D18** | Emergency coverage rewrites `schedules.data` **without** recomputing `staffing_report.estimated_wages`; both swap paths do. |
| **D19** | `coverage_session` is keyed `:<company_id>` — two concurrent call-outs at one company collide. |
| **D20** | `writeEmployeeAvailability` deletes by `employee_id` **without a `company_id` predicate**. |
| **D21** | Onboarding-created time-off omits `time_off_type` / `partial_days` — such requests can never be partial-day. |
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
