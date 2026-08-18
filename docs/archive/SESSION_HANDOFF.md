# Cowork session handoff — Quria / Aegis / Watermark

Paste this into a fresh Cowork chat to bring it up to speed.

---

You're picking up an in-flight build for **Quria Solutions**. Two repos, one shared Supabase database:
- **Aegis** (`~/Desktop/Aegis`) — the scheduling + email/text "brain" (Express, deploys to Railway).
- **Homebase** (`~/Desktop/homebase`) — the web app + the schedule engine's data layer + Soteria (its in-app NL agent) (Next.js, deploys to Vercel).

The live client is **Watermark Country Club** (a pool/lifeguard operation). The current mission is getting the product ready for **more clients**.

## Read these first (in order)
1. `~/Desktop/Aegis/CLAUDE.md` — the operating manual. Follow it exactly (it also lives in the Homebase repo). It covers who you're working with, the two-lane safety rule, and how to communicate.
2. `~/Desktop/Aegis/DEV_ROADMAP.md` — full roadmap. The **"NEXT BATCH — post-workflows polish"** section near the top is the live priority list.
3. `~/Desktop/Aegis/TEST_IDENTITIES.md` — sandbox + production IDs, test inboxes, routing.

## Who you're working with
Alexander (Lightning MaKigga in some test inboxes) — owns and directs the project, **not a software engineer**. Talk in plain English, no jargon. When he must run something, give **one** copy-paste block for his **zsh** terminal (never put `#` comments inside a command block — his shell runs them). Always tell him whether something touches the **live club**.

## The two lanes (never break this)
- **Safe lane, do freely:** create branches, work in the sandbox, read code + DB, run type-checks/tests, push branches, open PRs, write migration SQL.
- **Locked lane, Alexander only:** merging to `main` (deploys live), writing to the **production** DB, sending real emails/texts to real employees. You **prepare** these and hand him exact steps — never do them yourself.

## How work actually ships (important mechanics)
- **You can't reliably run git from the sandbox** (a fuse-mount lock blocks `.git` writes). So you **hand git to Alexander**. His local `main` frequently goes stale, so the safe pattern is:
  ```
  cd ~/Desktop/<repo>
  rm -f .git/index.lock .git/HEAD.lock .git/objects/maintenance.lock
  git stash
  git checkout main
  git pull
  git checkout -b <feature-branch>
  git stash pop
  git add <only the files you changed>
  git commit -m "..."
  git push -u origin <feature-branch>
  ```
  Then he opens a PR (main is branch-protected), merges, and Railway/Vercel auto-deploy.
- **Always run `npx tsc --noEmit` and `npx vitest run` in Aegis before handing off.** Keep tests green; when rewriting user-facing copy, preserve substrings the tests assert on.
- **The Supabase MCP here is read-only.** For schema changes, write a numbered migration SQL file (Homebase `migrations/NNN_*.sql`, mirror the latest one's RLS pattern) and have Alexander apply it in Supabase — **sandbox first, then production** (gated).
- **Deploy order for email-button features: Homebase before Aegis.** Most recent work has been Aegis-only or Homebase-already-supports, so check.

## Sandbox testing (no real employees get pinged)
- Sandbox `company_id` = `00000000-0000-0000-0000-000000000001`; inbound email address **sandbox@aegis.quriasolutions.com**.
- **Manager side:** Alexander sends from **xander.w.darling@gmail.com** — it's registered as Quria staff, which gives manager powers in any tenant.
- **Employee side:** "Shmubba Sploosh" = **aegisscheduler@gmail.com** (a real inbox he controls); "Test Guard B" = **lightningmakigga@gmail.com** (also his). Manager notifications route to the registered manager email, so the sandbox manager `users` row's email is pointed at his gmail.
- Reusable seed scripts live in `~/Desktop/Aegis/`: `SANDBOX_COVERAGE_SEED.sql`, `SANDBOX_INQUIRY_SEED.sql` (each test that ends in an accept consumes the seed data, so re-run before testing).

## Where things stand (done + live)
- **Veteran feature UI (items 3 grid-half + 7)** — DONE & LIVE (HB PR #15). VET badge on the schedule grid + per-shift rule indicator + the Homebase rules-management UI (`ShiftVeteranRulesSection.tsx` on the Rules page). The **emailed-schedule veteran tag (item 3 email half) is still open** — it's quick-win #1 of the next chat.
- **Publish button + republish/swap (items 9 + 12)** — DONE & LIVE + Alexander-tested (AG PR #38, HB PR #16; migration 016 applied via SQL editor). Publish flips `published_at` (timestamp is the source of truth, not the status enum — that clobber bug is closed). `publish_schedule_swap` atomically unpublishes the old schedule + publishes a new one for the same week, notifies **changed-only** employees, and supersedes the old wage/hours estimates. Old schedule is **archived** (superseded), not deleted.
- **MANAGER-COMM-1 (item 14)** — DONE & LIVE (AG PR #39). Manager headcount/coverage questions now answer deterministically from `schedule.data.assignments` in plain English — no more truncated-JSON hedging or leaked internals.
- **Every Aegis email workflow** is built + verified live: time off, availability (permanent, named-period, temporary/date-limited, **rotating**), emergency coverage (parallel blast + manager-gated next batch + writes the accepted shift onto the schedule), shift swaps, manager edits, and operational inquiries. All AI-output JSON parsing was hardened behind one tolerant parser (`src/utils/coerce-json.ts` — use it for any LLM JSON).
- **Veteran / experience shift rules** — DONE. A manager can say (to Soteria **or** Aegis email/text) "Saturday night lifeguards should be all veterans this summer" or "at least 2 veterans on the morning shift." Stored in `shift_experience_rules` (migration 015); the engine enforces all-veterans / min-N, day-of-week + season scoped (`src/lib/engine/experience-rules.ts` + the post-fill pass in `schedule-build.ts`); Soteria + Aegis (`operational-query.ts` → `handleExperienceRuleEdit` / `handleExperienceRuleConfirm`) both write it. Phase 2 (a custom-time event shift that *replaces* the normal one) is still open.
- **Quria-branded handout PDFs** (employee + manager) — DONE, built via `outputs_build_handouts.py` (weasyprint).
- **Voice + Quria branding pass** — DONE + live. Every Aegis HTML email rides one brand kit (`src/messaging/brand.ts`: `brandedEmailShell` dark frame with the Aegis "A" monogram + "Aegis" wordmark + orange `#f97316`, `brandedButtonRow`, `brandActionCard`) and a warm, conclusion-first assistant-manager voice; the logo is an inline **CID attachment** (`brand-logo.ts`), auto-attached by `email.ts sendEmail`. The Homebase magic-link Approve/Deny/error pages are rebranded too (`aegis-action/route.ts` → `renderActionResultPage`). Confirmed in real Gmail.
- **INBOUND-SIG-1** — DONE + live. Inbound REPLIES were failing ECDSA verification because `@sendgrid/eventwebhook` did `payload.toString()` (UTF-8), corrupting binary bytes (the inline logo image in a quoted reply). Fixed with byte-exact `src/security/sendgrid-signature.ts` (+ test). Any inbound email carrying non-UTF-8 bytes now verifies.
- **TO-RERUN-1** — DONE + live-verified (final fast-response polish pending one deploy). Managers can re-run a time-off recommendation against CURRENT approvals three ways: Homebase "Re-run check" button, an email-card magic-link that **replies in the original thread** with a refreshed card, and a conversational `recheck_time_off` command. On approve/deny (any channel) Aegis posts a **"✓ Resolved"** reply to each manager's thread; **click-guards** stop double-acting ("already approved by X on …"). Engine: `recomputeTimeOffRecommendation` / `recheckAndReplyToManager` (`time-off.ts`), `/internal/recompute-to-recommendation` + `/internal/recheck-to-reply`. NOTE: the recommendation counts only APPROVED time-off and DOES honor custom/rotating availability — it is correct; verify sandbox data (e.g. stale rotating availability) before suspecting the engine. `SANDBOX_RERUN_SEED.sql` sets up the flip-test.

## Voice / tone target
Aegis should read like a **smart, warm, understanding assistant-manager — not a bot.** Greet by first name, acknowledge naturally, make confirmations a real back-and-forth (a "no" or a tweak continues the conversation, never dead-ends). Example to match: *"Hey Lightning — happy to get that sorted. Just so I've got it right: you want the Afternoon on Sunday staffed with all veterans. Sound right? Say the word and I'll write it in across your systems — or just tell me what to tweak."* Don't use emojis unless the user does.

## Brand
Black / brushed-silver / **orange `#f97316`** (with subtle orange glow). Logo: `homebase/public/QuriaSolutionsBlack.jpg` (an orchid mark). The Homebase app theme is in `homebase/src/app/globals.css`.

## Immediate next work — QUEUED for the next chat (Alexander-chosen 2026-06-18; build in this order)
**Full brief + ready-to-paste prompt: `~/Desktop/Aegis/NEXT_CHAT_BRIEF.md`. Build each on its own branch off `main`; the two quick wins ship independently; do #3 last.**
1. **Veteran tag in the emailed schedule (item 3, email half).** Quick win. The grid badge is done; surface the same "Veterans only / ≥N" tag inside the build/distribute (publish) email report. Aegis-only, isolated. Reads `shift_experience_rules`.
2. **Plain-English rules explainers (item 13).** Quick win. Rewrite the Homebase Rules-page info/explainer text in dead-simple, no-jargon language (no "min-N," "scope," "attribute mix," "concurrent coverage"). Homebase copy, low-risk.
3. **Capabilities/help + role-aware scope guard (item 4).** Aegis (+ Soteria mirror). "What can you do for me?" → a clear role-aware list; an out-of-scope request gets a kind redirect to what they CAN ask for, never a dead-end. Largest of the three; foundation for item 19 (dynamic business partner).

### Backlog after the queue (see DEV_ROADMAP for full detail)
- **Item 18 — Shift-swap testing + investigation.** The swap workflow is fully BUILT (`shift-swap.ts`, directed + facilitated) but has ZERO tests and isn't live-verified.
- **Item 19 — Dynamic business partner.** Aegis + Soteria proactively explain themselves + guide users at conversation start (builds on item 4).
- **Item 8 — Soteria schedule-build trigger** (conversational build, the first concrete piece of item 16 parity).
- **Item 6 — Veteran rules Phase 2** (custom-time event shift that replaces the normal one).
- **Item 15 — Consistent assets/styling** across Homebase. **Item 17 — Access-management page** correctness pass (do live with Alexander). **SMS migration** (needs Alexander's provider research). **Item 11 — Homebase UI overhaul** (parked last).

Start by reading the three files above + `NEXT_CHAT_BRIEF.md`, then build the queue top-down. The two quick wins are fully decided — start with the veteran email tag.
