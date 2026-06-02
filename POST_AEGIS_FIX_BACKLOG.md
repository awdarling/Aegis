# Post-Aegis-Fix Backlog

**Purpose**: Parking lot for everything we've identified that doesn't block the email-workflow relaunch but matters for long-term system health. Distinct from the tracker doc, which focuses on the immediate email-workflow sprint.

**Last updated**: June 2, 2026

---

## Category 1 — Reference doc refresh (big batch)

The six docx files in the project folder are dated May 2026 and have drifted. Several schemas are stale. Doing this as one focused session post-launch is more efficient than spreading it across sprint days.

**01_Business_Overview.docx**
- A2P campaign status — verify approved/pending and update
- Confirm Watermark is still the only active client; add new clients if applicable
- Update SendGrid plan (free trial expires July 5, 2026 — see Category 5)

**02_Database_Schema.docx**
- New table: `aegis_action_tokens` (magic-link tokens) — schema, fields, TTL, security model
- `schedules` actual columns: `generated_at` not `created_at`, `generated_by` not `built_by`, plus `wages_file_url`, `approved_at`, `distributed_at` (all nullable)
- `company_channels.channel_value` (not `channel_address` as currently documented)
- `employees.individual_wage` column
- `schedules.status` now permits `'distributed'` (migration 013 applied)
- `generated_by` CHECK constraint allows only `('aegis', 'manager')`
- `time_off_requests.decided_by` is a FK to `users.id`

**03_Homebase_Reference.docx**
- Phase 1–4 magic-link infrastructure: tokens, dispatchers, /api/aegis-action endpoint
- Middleware exemption for /api/aegis-action (and the bug class it represents — see Category 4)
- aegis_internal helper for cross-repo POSTs with bearer auth

**04_Aegis_Reference.docx**
- SendGrid IP allowlist verification (`verifySendGridRequest`) replaces signature verification
- SPF/DKIM authentication gate in email webhook
- Reply-To header for subdomain inbound threading
- `sendInThreadAck` helper for email ack pattern (added Phase 1 of email-workflow sprint)
- `distributeScheduleCore` extracted from full distribute handler for internal callers
- `/internal/*` endpoints with bearer auth (notify-to-decision, distribute-schedule)
- `quria_staff` table is the cross-tenant admin auth path (separate from users/employees)

**05_Development_Guide.docx**
- May 30 incident postmortem (smoke test triggered real fan-out)
- Smoke-test isolation rules (sandbox company UUIDs, mock fetch, never live SendGrid)
- Email workflow debugging patterns (the [req] / [email-trace] / [email-auth] trace strategy used during this session)
- "Send Raw" must be unchecked on SendGrid Inbound Parse rules — non-obvious gotcha that cost us 90+ minutes today

**06_Supplemental_Reference.docx**
- Schema corrections (most overlap with 02)
- Email-subdomain DNS setup pattern (aegis.quriasolutions.com → mx.sendgrid.net)
- Outlook 365 + SendGrid coexistence on quriasolutions.com root

Effort: 4–6 hours focused work. Do as one batch.

---

## Category 2 — Code / architecture debt

| Item | Where | Effort | Notes |
|---|---|---|---|
| DKIM regex tightening | `src/webhooks/email.ts` | S | `' pass'` → `/:\s*pass\b/`. Could roll into Phase 5 of email sprint if appetite. |
| `resolveCompanyId` fallback footgun | `src/security/sender-verification.ts` lines 33–56 | M | When a second tenant onboards, "sole email-configured company" fallback breaks silently. Delete OR add explicit guardrail (only allow when exactly one). |
| `company_channels` exact-match bug | `src/security/sender-verification.ts` | M | Aegis logs "no exact match" for known-good channel_values and falls through to the fallback. Investigate case-sensitivity, whitespace, or schema field name. |
| Legacy SMS-channel TO decision tokens | Wherever the legacy TO approve/deny SMS flow lives | M | Migrate to unified `aegis_action_tokens` system used by email magic-links. Single token model is simpler. |
| xlsx → exceljs swap | Schedule download endpoints | M | Proper cell coloring in Excel exports. xlsx library doesn't support styled cells well. |
| Generalize ack pattern to SMS | TBD | S–M | Decision: does "Got it, building..." via SMS add value or just double message volume? Test with one user before rolling out. |
| Multi-turn email conversations | Intent classification | L | Aegis currently classifies each inbound email fresh. Replies in a thread should carry context (e.g., a reply to a TO-approval email knows it's about TO). Significant work. |

---

## Category 3 — Bug fixes

- **`TimeOffTab.tsx` doesn't set `decided_by` on UI approval** — only the magic-link approve path populates the column. Result: UI-approved TO records have NULL `decided_by`, which breaks any audit query that filters on it. Fix in `src/components/data/tabs/TimeOffTab.tsx`.

- **Stripe webhook middleware question** — `/api/stripe/webhook` is theoretically affected by the same middleware redirect that bit `/api/aegis-action`. Either it's silently failing in production or some unseen mechanism handles it. Verify in Stripe dashboard → Developers → Webhooks → Recent deliveries. If failing, add to the middleware exemption list.

- **Homebase `notify-assignment` calls Twilio directly** — bypasses Aegis. Should route through Aegis for consistency, logging, and ack-pattern coverage.

- **Activity-log dates from dispatcher use payload dates instead of actual TOR dates** — cosmetic. Magic-link approval action's `metadata.date` is from the token payload, not re-fetched from the TOR row after the update. Minor.

- **Schedule engine producing 100% staffed schedules** — observed during Phase 1 testing on June 2. Prior reference docs flag the schedule engine as broken. Either it was fixed silently or this week is easy and happened to fill cleanly. Worth deliberately testing edge cases (high TO volume, custom availability collisions, veteran-only days) post-launch.

---

## Category 4 — Security / auth hardening

- **Audit all Homebase `/api/*` endpoints for missing auth or middleware redirect issues** — same class as the original `/api/aegis-action` bug. Each route should be intentionally either auth-gated or explicitly public via the middleware allowlist. Currently inconsistent.

- **Mass fan-out code paths need explicit manager gate** — same pattern as Phase 2 notify safety guard. Any code that emails or texts more than N employees should require an explicit `confirmed: true` flag from the caller. Apply to `distribute_schedule`, `initiate_onboarding` fan-out, day-closure notifications.

- **Audit `verifySendGridRequest` IP allowlist for completeness** — currently only `159.26.*` is allowlisted. SendGrid uses additional IP ranges. Pull their published list and broaden if needed.

---

## Category 5 — Infrastructure / data cleanup

- **SendGrid free trial expires July 5, 2026** — decide on plan upgrade before deadline. Inbound Parse may have different limits on paid plans.

- **DKIM CNAMEs for Outlook 365 from admin.microsoft.com** — improves outbound deliverability when Aegis sends mail "from" `@quriasolutions.com`. Currently only SendGrid DKIM is set up.

- **Sandbox test data cleanup** — consumed tokens, finished sandbox TOR/schedule rows in production Supabase. Either move to a separate sandbox project or periodically purge.

- **Orphan smoke data in `aegis_action_tokens`** — `manager-smoke@test.local`, schedule UUID `smoke-schedule-uuid-fake`. Delete.

- **Orphaned SendGrid configs** — `em8322.quriasolutions.com` (Pending Sender Authentication) and `url280.quriasolutions.com` (Pending Link Branding) are half-started configs. Delete to reduce surface area.

- **Orphaned Inbound Parse rule** — `quriasolutions.com` (root) Inbound Parse rule points to Aegis webhook but root MX → Outlook, so it's never reachable. Delete to reduce surface area.

---

## Category 6 — Process improvements

- **Git-track the tracker doc** — commit each phase completion as a git commit so the timeline is preserved alongside code changes. Move `EMAIL_WORKFLOWS_TRACKER.md` to repo root.

- **Smoke vs prod environment separation** — May 30 incident root cause was prod data + local smoke run. Establish a separate Supabase project for sandbox tests, or at minimum enforce that smoke tests must mock all outbound mail/SMS.

- **Document the magic-link token security model** — TTL, single-use enforcement, signing, what happens on replay. Lives in code but not in any reference doc.

- **Establish a "diff review before push" discipline** — multiple times this session, an agent's report differed slightly from what was actually committed. Always read the actual diff (`git diff HEAD~1`) before pushing in agent-heavy sessions.

---

## Adding to this list

When something new surfaces during email-workflow work that isn't blocking, add a bullet here rather than letting it drift. Pattern: brief title, where it lives in the code, why it matters, rough effort (S/M/L).
