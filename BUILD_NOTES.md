# BUILD_NOTES — `feature/max-consecutive-days` (Aegis)

Recovery build, attended session. Branch state at the start: 7 docs-only commits
ahead of `origin/main`, 3 engine files modified but uncommitted (plumbing only,
no enforcement), `tsc` red with 2 errors, no tests. Branch state at the end:
plumbing preserved, `tsc` clean, enforcement implemented in the fill loop,
2 new tests + existing engine smoke all green.

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

## Discrepancy between the step-4 brief and the step-3 spec — flagged

The step-4 test brief reads:

> Enforcement: ONE eligible employee, available all 7 days, demand all 7 days,
> max=5. Expect: days 1–5 assigned, days 6–7 become GAPS with
> 'max_consecutive_days_reached' in that employee's per_employee_dispositions.

Under the step-3 spec ("a day with no assignment breaks it"), day 7's run is
NOT 7; it's 1, because day 6 was not placed. The spec-correct outcome is:
day 1–5 assigned, day 6 gap (`max_consecutive_days_reached`), day 7 ASSIGNED
(fresh run of 1, within the cap).

The implementation follows the spec. The test asserts the spec-correct
outcome and includes an explicit assertion that day 7 is placed — so the
"run-reset semantic" is itself locked in by the test, not just produced as a
side effect. A comment in the test file points this out.

If the step-4 outcome was the real intent (a "post-cap lockout for the
remainder of the week" semantic), the helper signature and the fill-loop
checks would need to change — that would be a different rule, not a tweak.
Flagging it here so the right call can be made before merge.

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

## Open / follow-up

- Confirm the run semantic (consecutive-run-including-candidate vs.
  post-cap-rest-of-week lockout) — see the discrepancy section above.
- Prior-week consecutive-day carryover (`TODO` in `types.ts` and
  `eligibility.ts`).
- No production policy row exists for this constraint yet — the parser will
  pick up any of `max_consecutive_days_worked`, `max_consecutive_days`, or
  `max_consecutive_work_days` policy keys (integer 1..7), but no tenant has
  one configured today, so behavior on prod is unchanged.
- Doc / tracker updates: `DEV_ROADMAP.md` will be corrected in an additive
  commit (step 8) so the prior optimistic-progress lines are explicit.
