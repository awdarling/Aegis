# B1 — Tenant-aware outbound email (apex From + per-tenant Reply-To) — HARDEN + PROVE (2026-07-26)

Phase B, item B1 — "the core multi-tenant blocker." Branch `feat/b1-tenant-aware-email` off `origin/main`. Aegis repo. Supabase MCP read-only; no prod writes; sandbox can't push (committed locally only).

## Decision (fixed, NOT re-opened)
ONE authenticated apex `From` (`env.SENDGRID_FROM_EMAIL`, e.g. `aegis@quriasolutions.com`) for SPF/DKIM/DMARC alignment across every tenant; per-tenant routing via **Reply-To** = `company_channels.channel_value`. No per-tenant authenticated From/domains.

## What was already built (verified in-code, NOT redone)
- `src/messaging/email.ts`: `sendEmail()` requires `company_id`; `resolveTenantEmailAddress()` sets Reply-To from `company_channels` (`channel_type='email'`, `channel_value`), falling back to `AEGIS_REPLY_TO_EMAIL`. From = apex. In-Reply-To / References / Message-ID threading implemented. `saveConversation` writes `from_address = apex`.
- `src/webhooks/email.ts`: inbound recipient extracted from the email's `to`/envelope, **lowercased**, passed to `resolveCompanyId`; the inbound Message-ID is captured as `thread_id` (what the reply threads to).

## The fix — D4, the actual multi-tenant footgun (the one real code change)
`resolveCompanyId` (`src/security/sender-verification.ts`) had a fallback: on no exact `company_channels` match, for the email channel, "route to the sole email-configured company when exactly one exists." That fallback **silently stopped working the instant a 2nd tenant existed**, and before that it routed ANY unrecognized recipient into the single tenant — a cross-tenant hazard.

- Removed the fallback entirely → **strict exact-match routing.** No match → `null` → `verifySender` logs a `security_event` (company_id null) + drops, exactly as today.
- Exported `resolveCompanyId` and added `src/security/__tests__/sender-verification.test.ts` (5 cases): exact match routes; no-match returns null with NO fallback; lookup error → null; `verifySender` drops + logs a security_event (company_id null) on no-match; exact match routes to the correct tenant with no cross-talk (contact lookup scoped to the resolved tenant).
- Fixed a stale in-code doc comment that referenced a non-existent `company_channels.is_active` column; documented the lowercase-`channel_value` requirement inline.

## Call-site audit (task item #2) — all 30 sendEmail sites, no fixes needed
Every `sendEmail` call passes a **tenant-derived** `company_id`:
- `contact.company_id` (verified inbound contact) — reply.ts, day-closure, schedule-build conversational, onboarding, payroll (`companyId = contact.company_id`)
- `token.company_id` (magic-link action token) — decision.ts (×5)
- `tor.company_id` (time_off_request row) — time-off
- `session.company_id` (onboarding / coverage / broadcast session), `outreach.company_id` (coverage outreach) 
- `params.company_id` / `args.companyId` / function `companyId` params — threaded from the above
- The two fan-out endpoints (`/internal/distribute-schedule`, `/internal/notify-schedule-changes`) resolve `companyId` FROM the schedule row; `distributeScheduleCore` re-guards `.eq('id', scheduleId).eq('company_id', companyId)` and loads employees `.eq('company_id', companyId)` — tenant-scoped by construction.

Safety greps: no `company_id` set to a literal / `env.*` / hardcoded UUID; the Watermark prod UUID appears nowhere in `src`. `tsc` guarantees the field is present; this audit confirms it's *correct*.

## saveConversation / from_address (task item #4)
`saveConversation` writes `from_address = apex` on outbound — fine under this model. Verified read-only that **nothing downstream reads `from_address` to resolve a tenant or route a reply** (all `from_address` refs are writes / type-defs). Routing is by inbound `recipient` + stored `company_id`; threading by In-Reply-To/References + `thread_id`. `aegis_conversations.company_id` is NOT NULL → conversations always carry the tenant.

## Schema verification (read-only, information_schema)
- `company_channels`: `id, company_id, channel_type, channel_value, created_at`. **No `is_active` column.** **No unique constraint on `channel_value` visible to the read-only role** → keep every tenant's address globally unique (a duplicate would make `.maybeSingle()` throw). Recommend a UNIQUE index (gated DDL) — logged as D8.
- Inbound recipient is lowercased pre-match → `channel_value` MUST be stored lowercase.
- `aegis_conversations.company_id` NOT NULL; `security_events.company_id` nullable (drop logs null); `shift_requirements.shift_type_id` + `accepted_roles` NOT NULL (Rule-0 migration live).
- Existing tenants both receive on `aegis.quriasolutions.com`: Watermark `aegis@`, sandbox `sandbox@`. All in `SCHEMA_DRIFT_LOG.md` (2026-07-26).

## Definition of Done — status
- **Achieved:** code hardened + audited; `tsc --noEmit` clean; full vitest **321/321** (local gitignored dummy `.env`; the 3 no-`.env` sandbox LOAD failures are pre-existing/unrelated). Committed on `feat/b1-tenant-aware-email` (`ba638ae`).
- **OWED (LIVE, sandbox — "tests pass" ≠ "verified live"):** stand up the 2nd tenant and prove send+receive+thread on two addresses with ZERO cross-talk; verify in Supabase (conversations carry the right company_id; no misrouted security_events).

## Handoff for Alexander
1. **Run `Sandbox_Tenant2_B1_Setup.sql`** (repo root) in Supabase — stands up tenant B (`00000000-0000-0000-0000-000000000002`, `sandbox2@aegis.quriasolutions.com`, employee "Robin Vale" on Riley's inbox). Idempotent; sandbox only. Optional manager needs an auth user created first (Dashboard).
2. **SendGrid Inbound Parse: NO new infra needed** — `sandbox2@aegis.quriasolutions.com` is a new local-part on the existing `aegis.quriasolutions.com` route. (A new *subdomain* would need MX + a Parse route.)
3. **Push the branch + PR:** the cloud sandbox can't push. From an environment that can: re-create/push `feat/b1-tenant-aware-email` (commit `ba638ae`), open a PR, review the diff, merge → Railway auto-deploys.
4. **Run the live 2-tenant proof** (after deploy): from Riley's inbox email tenant A's address and tenant B's address ("what are my shifts?"); confirm each Aegis reply's Reply-To = that tenant's own address; reply to each; confirm each reply routes back to the CORRECT tenant, lands inbound, and threads in Gmail; verify `aegis_conversations.company_id` per message and no misrouted `security_events`.

## Files changed (branch `feat/b1-tenant-aware-email`)
- `src/security/sender-verification.ts` — strict exact-match; export `resolveCompanyId`; comment fixes.
- `src/security/__tests__/sender-verification.test.ts` — NEW (5 tests).
- `Sandbox_Tenant2_B1_Setup.sql` — NEW (2nd-tenant provisioning SQL).
- Docs (this session): `DEV_ROADMAP.md`, `EMAIL_WORKFLOWS_TRACKER.md`, `SCHEMA_DRIFT_LOG.md`, `TEST_IDENTITIES.md`, `PATH_TO_SELLABLE.md` (added to the repo root — was missing).
