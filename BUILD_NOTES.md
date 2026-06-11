# BUILD_NOTES — `feature/max-consecutive-days` (Aegis)

Recovery build + verification + enforcement-gap fix, attended sessions. Branch
state at the start of the recovery: 7 docs-only commits ahead of `origin/main`,
3 engine files modified but uncommitted (plumbing only, no enforcement), `tsc`
red with 2 errors, no tests. Branch state at the end: all 5 assignment-mutation
sites enforce the cap, 4 new test fixtures (regression + enforcement + cascade
+ attribute-mix) plus a parser-chain smoke addition, all gates green.

Off-by-default. NOT pushed, NOT merged.

---

## What was actually implemented

### 1. Plumbing preserved as-is (`a7bc87f`)

The pre-existing uncommitted edits to `src/lib/constraints/{parser,types}.ts` and
`src/lib/engine/dispositions.ts` were committed verbatim so they can't be lost
on any later checkout. No code changes in this commit.

### 2. `tsc` baseline restored (`530105d`)

Two mechanical fixes that the prior session left undone:

- `src/lib/engine/dispositions.ts` — added `max_consecutive_days_reached` to
  `REASON_LABELS` (label: "at max consecutive worked days") and into
  `REASON_ORDER` between `max_hours_reached` and `doubles_blocked`.
- `src/workflows/schedule-build-email.ts` — added the matching `case
  'max_consecutive_days_reached': return 'at maximum consecutive worked days';`
  arm to `dispositionLabel()`'s exhaustive switch.

No semantic change. The disposition code now compiles end-to-end.

### 3. Enforcement in the fill loop (`f05df7a`)

`src/lib/engine/eligibility.ts` — new exported helper:

```ts
export function consecutiveDaysRunIncluding(
  empId: string,
  date: string,
  weekState: WeekState,
): number
```

Walks backward and forward through calendar days from `date`, counting how
many consecutive days (including `date` itself) the employee has at least one
assignment on. Day arithmetic anchors at noon UTC on the candidate date and
steps ±24h to dodge timezone edge cases. Bounded ±7 iterations (a single
build week, so the run can never exceed 7).

`src/workflows/schedule-build.ts` — three short-circuit checks added,
mirroring the existing `max_weekly_hours` check in style and placement:

1. `slotEligible` filter (the main fill loop's per-candidate gate).
2. `blockedByConflictOnly` filter (the cascade-resolution candidate gate).
3. The post-fill veteran-mode swap-pass candidate filter.

Each reads `settings.maxConsecutiveDaysWorked` — if `null`, the check is
skipped and behavior is unchanged for any tenant without the policy.

`src/lib/engine/dispositions.ts` — `classifyEmployeeForSlot` now emits
`'max_consecutive_days_reached'` between the `max_hours_reached` and
`doubles_blocked` branches, so gap descriptions explain why a candidate was
held out.

### 4. Tests (`f05df7a`)

`src/lib/engine/__tests__/max-consecutive-days.ts` — new file, smoke-style,
two functions invoked from a `require.main === module` guard:

- **(a) Regression** — 1 employee, 7-day demand, `DEFAULT_ENGINE_SETTINGS`
  (cap = `null`). Asserts: 7 assignments, 0 gaps, no
  `'max_consecutive_days_reached'` dispositions anywhere.
- **(b) Enforcement** — same fixture, `maxConsecutiveDaysWorked: 5`.
  Asserts: Mon–Fri + Sun filled (6 total); Sat is a single gap with
  disposition `(emp-solo, 'max_consecutive_days_reached')`; Sun's run resets
  after the Sat break and is placed.

The existing `src/lib/engine/__tests__/smoke.ts` was NOT modified and still
passes.

---

## Run / day-off definition used

- A "worked day" for employee `E` = `E` has ≥ 1 assignment with that
  `date` in `weekState.assignments`. Multiple shifts the same day count as one
  worked day, not multiple.
- The "consecutive run including `date`" for candidate `(E, date)` = the
  longest contiguous calendar-day window centered on `date` such that every
  day in the window is in `E`'s worked-day set (with `date` itself added).
  Days adjacent to `date` are walked outward in both directions, stopping at
  the first day not in the set.
- The candidate is REJECTED iff `settings.maxConsecutiveDaysWorked != null`
  AND that run length > `settings.maxConsecutiveDaysWorked`.
  - `max = 5` → 5 allowed, 6th rejected (matches the brief).
- A day with no assignment BREAKS the run. After 5 days of work + 1 day off,
  a 6th day of work is a fresh run of length 1, allowed.

This is the "consecutive-run-including-candidate" semantic from the step-3
spec. It is implemented exactly as written.

---

## Prior-week limitation (kept)

The run is computed strictly from assignments made within THIS build's
`weekState.assignments`. Counting consecutive days carried in from the prior
week is OUT OF SCOPE. The `TODO` comment on this is preserved in
`src/lib/constraints/types.ts` (next to the `EngineSettings.maxConsecutiveDaysWorked`
field) and a parallel `TODO` lives next to `consecutiveDaysRunIncluding` in
`src/lib/engine/eligibility.ts`.

When a Monday build is run for an employee who worked the prior Saturday and
Sunday, the engine treats Monday as the start of a fresh run. If the policy
becomes important enough to enforce across weeks, the helper needs to accept
prior-week assignments (likely via a `Set<string>` of prior worked dates,
passed in alongside `weekState`).

---

## Discrepancy between the step-4 brief and the step-3 spec — RESOLVED

The step-4 test brief reads:

> Enforcement: ONE eligible employee, available all 7 days, demand all 7 days,
> max=5. Expect: days 1–5 assigned, days 6–7 become GAPS with
> 'max_consecutive_days_reached' in that employee's per_employee_dispositions.

Under the step-3 spec ("a day with no assignment breaks it"), day 7's run is
NOT 7; it's 1, because day 6 was not placed. The spec-correct outcome is:
day 1–5 assigned, day 6 gap (`max_consecutive_days_reached`), day 7 ASSIGNED
(fresh run of 1, within the cap).

**DECISION (2026-06-10) — Semantic A is confirmed.** "Max consecutive days
worked" = a run of consecutive worked days that **RESETS on any day off**.
Work 5, off 1, work again = allowed; the cap blocks only the (cap+1)th
consecutive day. This is exactly what the implementation does, and the
step-4 brief's "days 6–7 both gap" expectation was the error, not the
implementation. The test locks in this semantic with an explicit assertion
that day 7 is placed.

**Semantic B (a weekly worked-days cap — e.g. "at most 5 days worked per
week, regardless of pattern") is explicitly OUT OF SCOPE.** If a tenant ever
wants that, it is a separate, separately-named constraint (e.g.
`max_worked_days_per_week`) with its own policy key, helper, and
disposition code — not a tweak to this one. Rationale: the two rules answer
different questions (consecutive vs. cumulative); coupling them under one
key would silently change behavior for any tenant that's already on
Semantic A.

---

## tsc + test output (verbatim, captured this session)

### `npx tsc --noEmit`

```
(no output)
tsc-exit: 0
```

### `node_modules/.bin/ts-node src/lib/engine/__tests__/max-consecutive-days.ts`

```
✓ Regression: totalRequired === 7 (got 7)
✓ Regression: all 7 demanded slots filled with the lone employee (totalFilled === 7, got 7)
✓ Regression: no gaps under default settings (got 0)
✓ Regression: every assignment goes to the solo employee
✓ Regression: zero 'max_consecutive_days_reached' dispositions anywhere (got 0)

✓ Enforcement: totalRequired === 7 (got 7)
✓ Enforcement: solo employee placed Mon–Fri + Sun, NOT Sat (got [2026-06-01, 2026-06-02, 2026-06-03, 2026-06-04, 2026-06-05, 2026-06-07])
✓ Enforcement: 6 of 7 slots filled — 1 gap on Sat (totalFilled === 6, got 6)
✓ Enforcement: exactly 1 gap on Sat 2026-06-06 (got 1)
✓ Enforcement: Sat gap classifies the 1 qualified employee (got 1)
✓ Enforcement: Sat gap disposition is (emp-solo, 'max_consecutive_days_reached') (got emp-solo/max_consecutive_days_reached)
✓ Enforcement: Sun has no gap — run reset after Sat (got 0)
✓ Enforcement: Sun is filled by the solo employee (got 1 assignments, employee emp-solo)
✓ Enforcement: no other gaps besides Sat (got 0)

All max-consecutive-days checks passed.
test-exit: 0
```

### `node_modules/.bin/ts-node src/lib/engine/__tests__/smoke.ts`

67 `✓` lines, 0 `✗` lines, final line: `All smoke checks passed.`, exit 0.
(Full output is long — gates: 67 passes, 0 failures.)

---

## Branch state at end of session

```
f05df7a feat(engine): enforce max_consecutive_days_worked in fill loop + tests
530105d fix(engine): restore tsc — add max_consecutive_days_reached label + switch case
a7bc87f wip(engine): max-consec-days plumbing, no enforcement yet
65d6f3d docs: session-9 sync — protected-main deploy flow, Remote Control, SEC-1 live, users.role='quria', backlog adds
9d98b7d docs(roadmap): Phase-1 PROD deploy (security DONE) + DOWNLOAD-500 & DELETE-USER diagnoses + protected-main operating model
cfe9b18 docs(roadmap): session-8 Phase-1 verification — schedule-download VERIFIED WORKING; security LOGIC VERIFIED 22/22; throwaway-branch + no-test-runner notes
5b73ffc docs: record users.role='quria' (not 'quria_admin') finding; correct TEST_IDENTITIES; flag getCompanyServer dup; SEC-1 review note
ee2a553 docs(roadmap+trackers): SEC-1..SEC-4 formalized; EMAIL tracker reconciled; session-7 log
c324844 docs(roadmap): SEC-1 create-user authz IN REVIEW (branch security/create-user-authz) + session-6 log
09a4010 docs(roadmap): log Cowork Phase-1 batch — security audit + schedule download IN REVIEW, Role Groups DRAFT
```

Status: tsc + new tests + existing smoke all green locally. IN REVIEW.
Off-by-default. NOT pushed, NOT merged, NOT deployed.

---

## Enforcement-gap fix (2026-06-10) — all 5 sites now covered

The verification pass found 2 silent cap-bypass paths. Both are now closed.

### Site coverage — final

| # | Site                                       | Cap enforced? |
|---|--------------------------------------------|---------------|
| 1 | `schedule-build.ts:630` (main fill `push`)  | ✅ COVERED — `slotEligible` + `blockedByConflictOnly` filters |
| 2 | `schedule-build.ts:615` (cascade apply)     | ✅ COVERED — via `cascade.ts:legalToPlace` cap check |
| 3 | `schedule-build.ts:784` (veteran swap)      | ✅ COVERED — candidate filter cap check |
| 4 | `attribute-mix.ts:286` (attribute-mix swap) | ✅ COVERED — `replacement` filter cap check |
| 5 | `cascade.ts:194` (cascade clone mutation)   | ✅ COVERED — `legalToPlace` gates every internal move |

### Diffs

`cascade.ts` — added `consecutiveDaysRunIncluding` to the imports and a single
short-circuit in `legalToPlace`, mirroring the existing `max_weekly_hours`
check. The cap check uses the same `viewState` (displaced-row hidden) that the
function already builds for `sameDayDoubleReason`. Null setting → no-op.

`attribute-mix.ts` — added `consecutiveDaysRunIncluding` to the imports and a
single short-circuit inside the `replacement` filter, between the
`max_weekly_hours` check and the `sameDayDoubleReason` check. Uses the
already-built `viewState` (displaced row hidden). Null setting → no-op.

### Test fixtures — what they prove

**(c) Cascade — direct unit test of `resolveBannedPairConflict`.** Setup tuned
so the resolver iterates two viable swap candidates: i=0 Mon-M (would extend
emp-X's run to 3 via Mon-Tue-Wed under the conservative `viewState`), and i=1
Fri-N (run length 2). With cap=null the resolver picks i=0 (first viable).
With cap=2 the cap check inside `legalToPlace` rejects i=0 and the resolver
picks i=1 — DIFFERENT moves, captured pasted below.

> The cascade swap branch's `legalToPlace` is intentionally over-conservative:
> it does NOT hide the partner row in `viewState`, so the cap check for
> moverEmp counts the partner's date as part of moverEmp's worked set. This
> over-predicts run length and rejects some swaps that wouldn't actually
> exceed the cap post-application. Direction is safe (over-reject, never
> under-reject). The fixture exploits this conservatism to demonstrate the
> cap check fires deterministically.

Asserts (5):
- cap=null returns a non-null op with ≥1 move (path entered + resolved).
- cap=2 also returns a non-null op (cap-respecting fallback exists).
- **cap=null vs cap=2 produce DIFFERENT moves** — proves the cap check
  rejected the natural pick.
- MUST-PASS invariant after applying the cap=2 op: no employee exceeds 2
  consecutive days.
- cap=null deterministic re-run (off-by-default).

**(d) Attribute-mix — direct unit test of `enforceAttributeMixForShift`.**
Setup: Mon shift required_count=2, pre-filled with two females, rule needs
≥1 male. Two male candidates available — `maleAdjacent` (already on Tue +
Wed) at the head of the employee list, and `maleFresh` (no rows). With
cap=null, `find` picks `maleAdjacent` first → his run becomes Mon-Tue-Wed = 3.
With cap=2, the `replacement` filter rejects `maleAdjacent` (run would be 3)
and picks `maleFresh` → run = 1.

Asserts (10):
- cap=null swap pass fires + applies a swap (path entered).
- cap=null picks `maleAdjacent` (confirms iteration order).
- cap=null makes `maleAdjacent` run = 3.
- cap=2 swap pass also resolves (with `maleFresh` instead).
- cap=2 picks `maleFresh` (cap check rejected `maleAdjacent`).
- MUST-PASS invariant: no employee exceeds cap=2 in final state.
- **DIFFERENT swap targets** between cap=null and cap=2 — direct evidence
  the cap-fix changed behavior.

**Plus the existing two fixtures** (regression default-null, single-employee
enforcement) and a new parser-chain smoke block in `smoke.ts` (4 asserts:
happy-path =5, fraction rejected, 0/8 out-of-range rejected).

### Final gate output (verbatim)

`npx tsc --noEmit` → exit 0, no output.

`ts-node src/lib/engine/__tests__/max-consecutive-days.ts` → 28 ✓ / 0 ✗.
The differentiating assertion (c) trace:
```
    cap=null moves: ["0->emp-X","4->emp-M"]
    cap=2   moves: ["1->emp-X","4->emp-N"]
✓ (c) cap-fix DIFFERENTIATING: cap=null vs cap=2 produce DIFFERENT swap moves
```
The differentiating assertion (d) trace:
```
✓ (d) cap=null vs cap=2 produce DIFFERENT swap targets
       null='emp-m-adj', cap=2='emp-m-fresh'
```

`ts-node src/lib/engine/__tests__/smoke.ts` → 71 ✓ / 0 ✗ (was 67; +4 parser
asserts for `max_consecutive_days_worked`).

---

## Open / follow-up

- ~~Confirm the run semantic~~ **CLOSED 2026-06-10** — Semantic A (resets on
  any day off) DECIDED; Semantic B (weekly cap) explicitly out of scope.
- ~~Two uncovered cap-bypass paths~~ **CLOSED 2026-06-10** — cascade
  `legalToPlace` and attribute-mix `replacement` filter both check the cap
  now; tests verify both with binding differentiating assertions.
- Prior-week consecutive-day carryover (`TODO` in `types.ts` and
  `eligibility.ts`). Still out of scope.
- No production policy row exists for this constraint yet — the parser will
  pick up any of `max_consecutive_days_worked`, `max_consecutive_days`, or
  `max_consecutive_work_days` policy keys (integer 1..7), but no tenant has
  one configured today, so behavior on prod is unchanged.
