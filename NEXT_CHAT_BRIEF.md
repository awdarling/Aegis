# NEXT CHAT BRIEF — Quria build queue (prepared 2026-06-18)

Self-contained kickoff for the next Cowork chat. Read `CLAUDE.md`, `DEV_ROADMAP.md` (the ▶ STATE & NEXT UP banner at the top), and `SESSION_HANDOFF.md` first — this brief assumes that context and just scopes the three builds.

## The job
Build three items, in order, each on its own branch off `main`. The first two are quick wins that ship independently; do the third last (it's the largest). Keep everything green; hand Alexander the git steps (you can't push from the sandbox).

1. Veteran tag in the emailed schedule (DEV_ROADMAP item 3, email half)
2. Plain-English Rules-page explainers (item 13)
3. Capabilities/help + role-aware scope guard (item 4)

## Ground rules (non-negotiable)
- **Two lanes.** Safe: branches, sandbox, reads, tsc/vitest, write migration SQL. Locked (Alexander only): merge to `main`, prod-DB writes, real sends. Prepare these; never do them.
- **Green or nothing.** `npx tsc --noEmit` + `npx vitest run` must pass in Aegis before handoff. When rewriting copy, preserve substrings the tests assert on (e.g. `>Approve</a>`, `>Deny</a>`, `reply YES`).
- **Branches, not merges.** One branch per item. Give Alexander the stale-main-safe git block from `SESSION_HANDOFF.md`.
- **Plain English everywhere** (these clients are non-technical) — no jargon in any user-facing string.

---

## BUILD 1 — Veteran tag in the emailed schedule (Aegis only) · branch `feat/veteran-email-tag`

**Goal.** The Homebase schedule grid already shows the "Veterans only / ≥N veterans" rule tag (PR #15). The **emailed** build/distribute (publish) report does NOT. Surface the same tag on the affected shift rows in the email so a manager reading the email sees which shifts are constrained — parity with the web grid.

**Where.**
- Rules already load during the build: `Aegis/src/workflows/schedule-build.ts` (~line 222 loads `shift_experience_rules` → maps to `EngineExperienceRule`; `veteranTargetsForGroup` ~848). The label logic lives in `Aegis/src/lib/engine/experience-rules.ts`.
- The email is rendered in `Aegis/src/workflows/schedule-build-email.ts`: the per-shift coverage block is ~line 184 (`<strong>${dateLabel} — ${g.shift_name} ${g.role}</strong>`); body assembled in `renderScheduleResultBodyHtml` (~line 387) and the plain-text mirror (~line 443).

**Approach.** Mirror the Homebase pattern (`ScheduleRenderer` took a `shiftRuleLabels?: Record<string, string>`). Build a `shiftRuleLabels` map in `schedule-build.ts` from the same active rules the engine used, key it the same way the coverage groups are keyed (shift + role + date/day), pass it into the email render, and append a small brand-orange tag (e.g. `· Veterans only` / `· ≥2 veterans`) to the matching shift row in both the HTML and plain-text outputs. Reuse the human label helper from `experience-rules.ts` — don't re-derive jargon.

**Test.** Add a unit test in `Aegis/src/workflows/__tests__/` that renders a schedule with one all-veterans rule + one min-2 rule and asserts the tags appear on the right shift rows (and only those). Keep existing schedule-build-email assertions green.

**Done when.** A built/published schedule email shows the veteran tag on exactly the constrained shifts, matching the web grid wording; tsc + vitest green.

---

## BUILD 2 — Plain-English Rules-page explainers (Homebase only) · branch `feat/rules-plain-english`

**Goal.** Rewrite the Rules-page info/explainer copy in dead-simple language. No "min-N," "scope," "attribute mix," "concurrent coverage," "policy_value_json," etc. A lifeguard manager with zero technical background should understand every word.

**Where.**
- `Homebase/src/app/(app)/rules/page.tsx`
- `Homebase/src/components/rules/AttributeMixModal.tsx` (the worst offender — even the name is jargon; rewrite the user-facing copy, and consider relabeling the heading to something like "Who works which shift")
- `Homebase/src/components/rules/ShiftVeteranRulesSection.tsx` (info/help text + field labels)

**Approach.** Copy-only / labels-only pass — no behavior change. For each explainer, lead with what it does for the manager in one plain sentence, then a concrete example in their world ("At least 2 veteran lifeguards on the Saturday morning shift"). Keep the brand voice (warm, direct). Don't touch the write paths or the `shift_experience_rules` contract.

**Test.** Homebase has no test runner; verify by reading the rendered copy and (optionally) a quick local `npm run build`. Grep the changed files to confirm no jargon terms remain in user-facing strings.

**Done when.** Every visible label/tooltip/explainer on the Rules page is plain-English, example-driven, jargon-free; no logic changed.

---

## BUILD 3 — Capabilities/help + role-aware scope guard (Aegis + Soteria) · branch `feat/capabilities-help`

**Goal.** Two halves: (a) a user can ask "what can you do for me?" / "help" and get a clear, **role-aware** list of what they're allowed to ask for (employee vs manager vs owner); (b) when they ask for something outside their access, it kindly explains it can't do that *for them* and tells them what they CAN ask for — never a dead-end "I didn't understand."

**Where (Aegis).** `Aegis/src/router/intent-router.ts`:
- `MANAGER_ONLY_INTENTS` (line 69) — the privilege set.
- Employee-blocked redirect (lines ~256–261) — already friendly; enrich it to name what the employee CAN do (it already lists some — make it the same canonical list as the help response).
- `default` fallback (lines ~397–402) — already says reply "help," but **there is no `help`/`capabilities` intent that actually answers it.** Add the intent + a `case` that returns the role-aware capability list. Make the classifier recognize "help" / "what can you do" / "what can I ask for."

**Where (Soteria mirror).** `Homebase/src/app/api/soteria/route.ts` (+ `execute/route.ts`) — same role-aware capabilities answer + out-of-scope redirect, so Aegis and Soteria say the same thing.

**Approach.** Define ONE source-of-truth capability list keyed by role (employee / manager / owner) and render it in both the help response and the scope-guard redirect, in both Aegis and Soteria, so the wording can't drift. Plain English, grouped by what the user is trying to get done. This is deliberately the foundation for item 19 (dynamic business partner) — structure the capability list so it can later be surfaced proactively at conversation start.

**Test.** Aegis: unit tests in `intent-router` coverage — (a) an employee asking a manager-only thing gets the redirect naming their allowed actions; (b) "help" / "what can you do" returns the role-correct list for employee vs manager. Keep all existing router tests green.

**Done when.** "help"/"what can you do" returns a correct role-aware list in both Aegis and Soteria; out-of-scope requests redirect kindly with the allowed list; one capability list drives all four paths; tsc + vitest green.

---

## Handoff checklist (end of the next chat)
- [ ] Each build on its own branch; tsc + vitest green in Aegis.
- [ ] Git steps handed to Alexander (stale-main-safe block), one PR per branch.
- [ ] DEV_ROADMAP ▶ banner + the trackers updated per the LOGGING PROTOCOL (flip item 3 email-half, 13, 4 to DONE as each ships).
- [ ] Note any sandbox test Alexander should run live before he merges.

---

## READY-TO-PASTE PROMPT (for the next Cowork chat)

> Read `~/Desktop/Aegis/CLAUDE.md`, `~/Desktop/Aegis/DEV_ROADMAP.md` (the ▶ STATE & NEXT UP banner), `~/Desktop/Aegis/SESSION_HANDOFF.md`, and `~/Desktop/Aegis/NEXT_CHAT_BRIEF.md` to get up to speed. Then build the three queued items in order, each on its own branch off `main`: (1) the veteran tag in the emailed schedule, (2) plain-English Rules-page explainers, (3) capabilities/help + role-aware scope guard in Aegis and Soteria. Follow the two-lane rule — branches only, keep tsc + vitest green, preserve test-asserted substrings, and hand me the git steps; don't merge or send anything live. Start with build 1 and check in after each one before moving to the next.
