# QURIA — PATH TO SELLABLE

**The single authoritative priority plan. Last updated: 2026-07-26 (B1 session).**

> ## ⚠️ READ ME FIRST — EVERY SESSION, EVERY CHAT
>
> This file is the **one source of truth for what to work on and in what order** as Quria gets ready to sell. If you are a Cowork / Claude Code chat working on Quria, **this file outranks the ranked order in `DEV_ROADMAP.md`.** The roadmap still holds the deep per-item history and diagnostics (cross-referenced here by item number, e.g. "#10"); this file holds the *plan*.
>
> **Copies of this file live in multiple places on purpose** (Aegis repo root, Homebase repo root, the Claude project, the landing-page repo). They must stay identical. **If you change the plan, change it HERE first, then re-sync every copy** — do not let them drift. If two copies disagree, the one in the Claude project is canonical.
>
> Do not re-derive priorities from scattered notes. Start here.

---

## Context (for a chat that knows nothing)

**Quria Solutions** builds AI employees for service businesses. Two products + one embedded assistant:
- **Aegis** — the AI assistant manager. Node/Express/TypeScript on Railway. Talks to employees & managers over **email** (SendGrid) today, SMS (Twilio → migrating to Telnyx) later. Onboards staff, builds/distributes schedules, handles time-off, availability, shift swaps, emergency coverage.
- **Homebase** — the manager control platform. Next.js/TypeScript on Vercel, Supabase (PostgreSQL) backend.
- **Soteria** — a Homebase-embedded conversational assistant that configures/edits the client's data (she configures; Aegis operates).

**First live client:** Watermark Country Club (`company_id: a1b2c3d4-e5f6-7890-abcd-ef1234567890`).

**WIN CONDITION — "sellable like a motherfucker":** Alexander can sign a new client and stand the product up for them, confidently, without babysitting it. Two thresholds, in order:
1. **Sellable to the first paying clients** — everything Watermark relies on is *proven live* (not just green in tests), plus a clean demo and client-facing guides to sell with.
2. **Repeatable to MANY clients** — a second/third/Nth tenant can be provisioned and run without single-tenant assumptions breaking.

**The through-line (never violate):** nothing hardcoded, nothing that silently fails — and **nothing is trusted until it's been clicked live.** The last month closed the correctness holes (Data Contract D1–D22, the fairness engine). The remaining gap is **verification debt + multi-tenant infrastructure**, not more features.

---

## THE PLAN AT A GLANCE

```
SELLABLE GATES (do these, in order):
  PHASE A — Prove it works live        ← ✅ COMPLETE (2026-07-26)
  PHASE B — Multi-tenant infrastructure ← ◀ CURRENT (the "sell to MANY" gate)
  PHASE C — Sell-with deliverables      ← build after A so examples are real
  PHASE D — Pre-sale hardening & polish ← fast, non-gating individually

AFTER SELLABLE (own coworker chats, parallelizable):
  ▸ SMS MIGRATION (its own beast)
  ▸ HOMEBASE UI OVERHAUL
  ▸ PAYROLL CONNECT
  ▸ GENERAL VISUAL POLISH
```

---

# PHASE A — PROVE IT WORKS LIVE (verification debt) — ✅ COMPLETE (2026-07-26)

**All Phase A workflows are live-verified in the sandbox.** Swap #10 (all paths: pickup, two-way trade, decline-reopen, deny-notify), coverage batch #11, my-shifts #12, custom availability #13 (date-limited + rotating), availability-vs-time-off parse #14.5, and onboarding #19 (fresh new-hire + D21 partial-TO) all passed real email round-trips (Sam `aegisscheduler@gmail.com` / Riley `lightningmakigga@gmail.com`; manager = `sandbox-mgr@quriasolutions.com` M365 mailbox), each DB effect confirmed in Supabase. Also landed live: opt-in-first onboarding + BUG-7, and the STOP/decline path. Full record: `claude/session-2026-07-25-phaseA-complete.md`.

**Known non-blocking follow-up (fix before the live demo):** onboarding availability-confirm can intermittently loop ("I didn't quite catch that" after a "Yes") — a duplicate-inbound/session-persistence race at the availability→availability_confirm transition. Logged in `EMAIL_WORKFLOWS_TRACKER.md`; slot it into the #18 demo-reset prep.

### A1 — Sandbox verification sweep (roadmap item 11.7) — ✅ DONE
Every built-but-unverified workflow (undirected swap #10 incl. SWAP-SAFETY #10.6, coverage batches #11, my-shifts #12, custom-availability #13, parse fixes #14.5 a/b/c) passed a genuine round-trip; results logged in `EMAIL_WORKFLOWS_TRACKER.md`.

### A2 — Onboarding: build + verify (roadmap item 19) — ✅ DONE
A brand-new hire went from "onboard X" to schedulable, live in the sandbox, with the Homebase Onboarding tab reflecting it; D21 partial-time-off-in-onboarding verified.

---

# PHASE B — MULTI-TENANT INFRASTRUCTURE (the "sell to MANY" gate) — ◀ CURRENT

Everything here breaks the moment client #2 exists. None of it blocks a single hand-held first client; ALL of it blocks selling *repeatably*.

- **B1 — TENANT-1: tenant-aware outbound From + threading** (roadmap Phase 4.5 in `EMAIL_WORKFLOWS_TRACKER.md`) — **THE core multi-tenant blocker. CODE COMPLETE / IN REVIEW as of 2026-07-26** (branch `feat/b1-tenant-aware-email`, commit `ba638ae`; NOT pushed — sandbox can't push, Aegis `main` is PR-protected). Model (fixed, do NOT re-open): ONE authenticated apex `From` (`env.SENDGRID_FROM_EMAIL`) for SPF/DKIM/DMARC; per-tenant routing via **Reply-To** = `company_channels.channel_value`. Done this session: (1) killed the multi-tenant footgun (D4) — `resolveCompanyId` no longer falls back to "the sole email-configured company"; strict exact-match, no-match → security_event + drop; +5 unit tests. (2) Audited all 30 `sendEmail` call sites — every one passes a tenant-derived `company_id`; no fixes needed. (3) Confirmed Reply-To/threading + that nothing routes off `from_address`. tsc clean; vitest 321/321. **DoD (still owed — LIVE):** stand up a 2nd sandbox tenant (`Sandbox_Tenant2_B1_Setup.sql`, Alexander runs it — MCP read-only) and prove send+receive+thread on two addresses with ZERO cross-talk. **SendGrid: `sandbox2@aegis.quriasolutions.com` rides the existing `aegis.quriasolutions.com` Inbound Parse route — no new infra.** Full record: `claude/session-2026-07-26-B1-tenant-email.md`.
- **B2 — New-tenant provisioning runbook.** A repeatable, documented path from "signed a client" to "live tenant": create `companies`/`company_profiles`, per-client Aegis email channel (`company_channels`), monitoring-inbox row (`company_monitoring_inboxes`), manager/owner `users` (auth-user-first per the FK), and initial config via Soteria document-ingestion (handbook/roster/existing schedule → roles → wages → shifts → policies → veteran rules). **DoD:** a written runbook + one clean dry-run standing up a fresh fake tenant end-to-end. *(The B1 SQL `Sandbox_Tenant2_B1_Setup.sql` is a concrete first draft of the data half of this runbook.)*
- **B3 — Per-client Aegis address/number config (data-driven, no hardcoding).** Confirm no client identity is baked into code (the D6 corollary — `loadCompanyName()`, no "Watermark" strings). Every client gets their own Aegis email now (own SMS number later). **DoD:** grep proves no client-name/address/number literals in send paths; all resolve from `companies`/`company_channels`. *(B1 audit already confirmed no client-name/UUID literals in the send paths.)*
- **B4 — Monitoring-inbox admin UI** (roadmap item 16, remaining slice). The BCC-every-outbound observer inbox is LIVE but DB-only (`company_monitoring_inboxes`). Add an admin UI to manage the flag per client, and thread the BCC through any operational sends that bypass `sendEmail`. **DoD:** a Quria admin can add/remove a client's monitoring inbox without touching SQL.

---

# PHASE C — SELL-WITH DELIVERABLES (build AFTER Phase A so examples reflect verified behavior)

- **C1 — Manager + employee handouts** (roadmap item 17). Two client-facing, **client-AGNOSTIC** (no Watermark specifics), foolproof guides — one per role. For each function: what it does, exactly how to phrase the message, example messages, and a step-by-step preview of the full exchange. Generalize + complete the existing Desktop drafts. **Do NOT surface payroll** (not real yet). **DoD:** a new user of either role can self-answer "is this working / did I do it right / how do I phrase this?"
- **C2 — Demo sandbox reset** (roadmap item 18). Reset the sandbox into a clean, realistic demo state: fresh published week, sensible roster/shifts, real test inboxes wired, **zero leftover test artifacts**, and a rehearsed happy-path. **DoD:** Alexander can run the full loop start-to-finish for a prospect with zero surprises.
- **C3 — Reference-doc rewrite** (roadmap item 14). Align docs 01–06 to reality. Fold in the resolved `SCHEMA_DRIFT_LOG.md` entries. **DoD:** a new engineer can trust 01–06 without cross-checking the trackers.

---

# PHASE D — PRE-SALE HARDENING & POLISH (fast, non-gating individually; collectively "no rough edges")

- **D1 — Deploy the two already-built redesigns (Alexander's lane).** The email visual redesign (branch-only) and the home dashboard redesign (`feat/home-dashboard-redesign`, commit `6b6a169`). Push → PR → deploy + runtime QA.
- **D2 — BUG-4: scrub Homebase CTAs from employee-facing emails.** Firm rule, still open.
- **D3 — Template-unification Piece 3: distribution-email grid parity.** Re-express `resolveCellAppearance`'s tint in Aegis `templated-grid.ts` as a careful pass on the sensitive grid renderer.
- **D4 — Phase-5 email cleanup.** ✅ **The `resolveCompanyId` sole-company fallback is DONE (removed) as part of B1 (2026-07-26).** Remaining: strip `[req]` global logger (`src/index.ts`) + `[email-trace]` (`src/webhooks/email.ts`; keep `[email-auth]`/`[sendgrid-verify]`); tighten the DKIM substring `' pass'` → `/:\s*pass\b/`.
- **D5 — `npm audit`.** Review deliberately (do NOT blind `audit fix`).
- **D6 — Config-over-code: fairness knobs into the Rules UI.** Wire `fairnessFloorEnabled` / `fairnessFloorRatio` / `fairnessExcludeTimeOff` / `fairnessLookbackWeeks` / `fairnessDecay` into the Homebase Rules screen.
- **D7 — Wax-seal hardening.** Add the timestamp-freshness/replay window on inbound signature verification; once stable, remove the dead IP-allowlist fallback + the `SKIP_SENDGRID_VERIFICATION` flag.
- **D8 (new, from B1) — add a UNIQUE index on `company_channels.channel_value`** (gated DDL). No unique constraint exists today; `resolveCompanyId`'s `.maybeSingle()` throws on a duplicate address. Provisioning discipline covers it for now; a DB-level guarantee is the durable fix.

---

# AFTER SELLABLE — THE BIGGER BEASTS (parallelizable coworker chats)

Explicitly **not** gates on selling. Start each in its own chat once Phases A–D are clear (or in parallel where it doesn't touch the sellable path).

## SMS MIGRATION — its own beast (the follow-on bonus, not a blocker)
Email is the sell; SMS is the ready-to-pull bonus. Twilio is already decommissioned. **⚠️ Deploy `chore/twilio-optional` BEFORE removing `TWILIO_*` env vars from Railway.** Remaining: Telnyx integration (outbound + inbound + signature verification), a 10DLC-compliant NUMBER-AGNOSTIC landing page, an A2P HELP/STOP responder (carrier-level), and the TCPA opt-in flow for SMS-channel employees.

## HOMEBASE UI OVERHAUL (roadmap item 15, ~40h) — use Cowork design mode
Full visual/UX overhaul of the manager platform. Largest single item; parallelizable with SMS.

## PAYROLL CONNECT (roadmap item 20) — sequenced after the UI overhaul
Real payroll/hours system. **Do NOT surface payroll in client-facing materials until it's genuinely built.**

## GENERAL VISUAL POLISH (ongoing)
Cross-cutting brand/voice consistency once the above land.

---

# WORKING PRINCIPLES (carry forward — do not violate)

- **Sandbox only for tests.** NEVER trigger anything against the live Watermark tenant, and never touch a real employee/manager inbox.
- **Smoke tests must not hit production SendGrid** — sandbox subuser or full mock.
- **Supabase MCP is read-only.** No prod writes, no DDL, no env/secret changes from an agent.
- **The sandbox cannot push.** All code work goes on a feature branch off `origin/main`; keep `tsc --noEmit` clean and the full vitest suite green; hand Alexander the exact git steps. Aegis + Homebase `main` are PR-protected.
- **Read the actual code/diff before claiming anything works.** "Tests pass" ≠ "verified live" — say which one you achieved.
- **Diagnose before you fix.** No fix without real evidence.
- **Verify columns against `information_schema` before any INSERT/UPDATE.** `src/db/types.ts` is INCOMPLETE.
- **Rule 0 / Rule 0b** — what the manager sees is the truth; one concept → one canonical column; one question → one function. See `07_Data_Contract.md`.
- **No client names in code** — client identity comes from `companies`/`company_profiles`, always.
- **"Feels like a person" tone on every Aegis string.**
- **Employee emails never link to Homebase** (BUG-4 rule).

# LOGGING DISCIPLINE (mandatory — nothing evaporates)
- Roadmap status + session log → `DEV_ROADMAP.md`
- Bug/workflow changes → `EMAIL_WORKFLOWS_TRACKER.md`
- Database surprises → `SCHEMA_DRIFT_LOG.md` (append-only)
- Identity/tenant changes → `TEST_IDENTITIES.md`
- How the system works → the relevant reference doc (01–07)
- **A change to THE PLAN → this file (`PATH_TO_SELLABLE.md`), then re-sync every copy.**

---

## Where this file must live (keep all copies identical)
- Aegis repo root: `/PATH_TO_SELLABLE.md` *(added 2026-07-26 — was previously missing from the Aegis repo)*
- Homebase repo root: `/PATH_TO_SELLABLE.md`
- Landing-page repo root: `/PATH_TO_SELLABLE.md`
- The Claude project (canonical copy)
- Anywhere else a coworker chat starts its work

*If you update the plan, update the canonical copy in the Claude project first, then propagate to every repo copy in the same change.*
