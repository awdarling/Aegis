# QURIA SOLUTIONS — Business & Product Intelligence

**Version 3.0 — June 8, 2026**

*Confidential — Internal Development Reference*

---

## 1. Company Overview

Quria Solutions builds AI employees — autonomous agents called **doppelgangers** — for service businesses. Founded by Alexander Darling, headquartered in Michigan. Rather than dashboards, Quria builds operational systems where AI agents do the actual work of managing employees (scheduling, communicating, processing requests, coordinating coverage) with human managers retaining full oversight.

**Mission:** replace the operational burden of workforce management with intelligent AI employees, giving service-business managers their time back while delivering more consistent, responsive, data-driven operations than a human manager working alone.

### 1.1 The Doppelganger

An AI employee that performs a management role. The first is **Aegis** — an AI assistant manager. Each doppelganger operates through real channels (SMS, email), performs work autonomously within defined boundaries, reports to humans who keep final authority, keeps a full audit trail, and applies company rules consistently.

### 1.2 Development philosophy

**Do the simplest thing that works.** Build the data layer first, then rules, then system-state visibility, then AI compatibility, then UI. Keep the interface minimal and structured. Data is always structured, validated, transparent — no silent failures. Managers retain full control. AI boundaries are strict: Soteria assists internally, Aegis operates externally. No payroll/compliance/messaging platforms or vanity analytics. Iterate; never skip ahead.

### 1.3 Business model

B2B SaaS to service businesses (country clubs, hospitality, recreation). Per-company licensing — Homebase access plus Aegis deployment. Flexible billing (one-time setup or recurring). Quria manages deployment, configuration, and ongoing AI operation.

### 1.4 Contacts & accounts

| | |
|---|---|
| Founder | Alexander Darling |
| Email | awdarling@quriasolutions.com |
| Phone | +16163280114 |
| Website | quriasolutions.com (Netlify) |
| Privacy / Terms / SMS Consent | quriasolutions.com/privacy, /terms, /sms-consent |

### 1.5 Product north-star (end-state vision)

The development direction is a four-phase Forward Build Sequence (harden the live product → complete the comms loop → configurable correct rules → experience & leverage; tracked in `DEV_ROADMAP.md`). Once those phases land, the product is:

**Aegis** is a genuinely conversational AI assistant manager running the entire employee side of workforce operations over email — and over SMS once A2P clears: compliant onboarding, availability, time-off, swaps, emergency coverage, and weekly distribution (each employee gets their own shifts *plus* the full schedule), all in a human-feeling voice. It is backed by a deterministic engine that builds fair, rule-driven schedules and surfaces real coverage gaps with suggested fixes rather than silently overworking staff.

**Homebase** is the manager command center: data and rules that actually drive the engine (fairness, conflicts, coverage, doubles all wired), schedules that persist and download cleanly, one-click time-off / availability approval, coverage flags with suggested swaps, and natural-language admin via Soteria.

**The thesis:** config-over-code multi-tenancy (a new client is a *data* operation, not an engineering project), a deterministic auditable engine, and a flag-don't-force model that keeps humans in final authority while the AI does the legwork — with security solid enough to sell.

---

## 2. Products

- **Homebase** — manager-facing Next.js/Vercel control platform: structure data, define rules (the Rules tab feeds the engine's constraint vocabulary), review AI output, retain oversight. Embeds the Soteria assistant.
- **Aegis** — the external AI assistant manager (Node/Express/Railway): employee SMS/email comms, request processing, coverage coordination, and a **deterministic Schedule Engine V2** that generates schedules from each client's data.
- **Soteria** — the internal assistant embedded in Homebase: data entry, bulk operations, system understanding. Reads/writes via confirm cards; never communicates externally. claude-sonnet-4-6, 8192 tokens.

---

## 3. Clients

### 3.1 Watermark Country Club — Active (first production client; **launched June 5, 2026**)

| | |
|---|---|
| Company ID | a1b2c3d4-e5f6-7890-abcd-ef1234567890 |
| Location / Industry | Grand Rapids, Michigan area / country club (swim facility) |
| Status | **Live** — email workflows (time off, availability) in production use. Post-launch sprint (closed 2026-06-09) put three more capabilities live: the facility-wide **concurrent-coverage gender rule** (`sex_coverage`, validate-and-flag — replaced the old per-shift swap; hours now flatten and a coverage flag surfaces), **persistent manual schedule edits** (a manual move round-trips corrected hours to `schedules.data`), and **notifying in-tab time-off approvals** (an in-tab approve notifies the employee, sets `decided_by`, and acknowledges the manager). |
| Billing | one_time, $2,117 (211700 cents), status paid |
| Managers | Carolyn Ringler (c45ringler@gmail.com, +16168223809), Jack McCorkle (jackmc419@icloud.com, +16165519476) |
| Aegis SMS / email | +16167477953 / aegis@aegis.quriasolutions.com |
| Timezone | America/Detroit |
| Employees | ~30 active |

**Roles:** Manager, AManager (Assistant Manager — Erin Berigan, whose role maps to Headguard/Lifeguard in practice), Headguard, Lifeguard, Junior Lifeguard, Greeter. *The authoritative roster is the live `employees` table; any names listed in older docs are illustrative and may be stale — confirm `primary_role`/`qualified_roles` in Supabase when a scheduling question turns on a specific person.*

**Shift structure** (configured via `shift_types` + `shift_requirements`): AM Weekend/Weekday, Day/Weekday Greeter, Flex (Headguard/Lifeguard 13:00–21:00), PM, Afternoon manager. Watermark runs Sunday–Saturday weeks but sets `week_start_day = 'monday'` for building.

**Test/monitoring identities:** Bubba Ganush (lightningmakigga@gmail.com) is a manager row Alexander controls, kept through launch monitoring and to be removed after. See TEST_IDENTITIES.md.

---

## 4. Key Third-Party Services

- **Twilio (SMS)** — Account SID AC••• — redacted (Account SID; see Railway env / password manager), number +16167477953, Messaging Service MG••• — redacted (Messaging Service SID; see Railway env). A2P 10DLC (Low Volume Mixed) **pending approval**; toll-free verification submitted as the parallel faster path. Inbound webhook `…/webhooks/sms`. Launch is **email-first** until SMS clears.
- **SendGrid (Email)** — inbound `aegis@aegis.quriasolutions.com` (Inbound Parse on host `aegis.quriasolutions.com`, ECDSA signature verification enabled), outbound from apex `aegis@quriasolutions.com`, webhook `…/webhooks/email`. Routing via `company_channels`.
- **Stripe (Billing)** — live mode; webhook `…/api/stripe/webhook`; `billing_model` per company; amounts in cents.
- **Anthropic (AI)** — claude-sonnet-4-6, 8192 tokens, used for Soteria and Aegis intent/response only (the schedule build is LLM-free). `withAnthropicRetry`: 3 attempts, 1s/2s on 529.

---

## 5. URLs & Access

| | |
|---|---|
| Homebase (prod) | homebase-nine-phi.vercel.app |
| Aegis (prod) | aegis-production-3220.up.railway.app |
| Homebase repo / Aegis repo | github.com/awdarling/Homebase, github.com/awdarling/Aegis |
| Supabase | lpxbpfipanmvwiapriwt.supabase.co |
| Website | quriasolutions.com (incl. /sms-consent, /privacy, /terms) |

---

## 6. Environment Variables

**Vercel (Homebase):** `ANTHROPIC_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `AEGIS_URL`.

**Railway (Aegis):** `ANTHROPIC_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_MESSAGING_SERVICE_SID`, `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, `SENDGRID_WEBHOOK_PUBLIC_KEY` (ECDSA inbound verification), `AEGIS_REPLY_TO_EMAIL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BASE_URL`, `SKIP_TWILIO_VERIFICATION` (testing only), `SKIP_SENDGRID_VERIFICATION` (**false in production**).
