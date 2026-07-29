# Aegis

Aegis is an AI assistant manager for companies using Homebase scheduling software, built by Quria Solutions. It handles inbound communication from employees and managers via SMS (Telnyx) and email (SendGrid Inbound Parse), classifying each message and executing the appropriate workflow: time-off requests, shift swaps, emergency coverage, schedule building, and general operational queries. Managers interact with Aegis through the same channels their team uses — no separate app or portal required.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | No | `development` | Runtime environment (`development`, `production`, `test`) |
| `PORT` | No | `3000` | HTTP server port. Railway injects this automatically. |
| `SUPABASE_URL` | **Yes** | — | Full Supabase project URL (Settings → API) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | — | Supabase service role key — bypasses RLS, keep secret |
| `TELNYX_API_KEY` | No* | — | Telnyx v2 API key (Bearer) for outbound SMS. *Required for SMS; unset = email-first. |
| `TELNYX_PUBLIC_KEY` | No* | — | Base64 Ed25519 public key to verify inbound Telnyx webhook signatures. *Required for SMS. |
| `TELNYX_MESSAGING_PROFILE_ID` | No | — | Messaging profile (portal/webhook config; not sent in the send body) |
| `EMAIL_ONLY` | No | `true` | While `true`, SMS is disabled and everything runs over email. Set `false` to enable SMS. |
| `SKIP_TELNYX_VERIFICATION` | No | — | `true` bypasses inbound signature checks — local/Tier-0 testing only, never production |
| `SENDGRID_API_KEY` | **Yes** | — | SendGrid API key with Mail Send and Inbound Parse permissions |
| `SENDGRID_FROM_EMAIL` | **Yes** | — | Verified sender email address for all outbound mail |
| `SENDGRID_FROM_NAME` | No | `Aegis` | Display name in the From field of outbound emails |
| `SENDGRID_WEBHOOK_VERIFICATION_KEY` | No | — | SendGrid signed webhook verification key (optional extra security) |
| `ANTHROPIC_API_KEY` | **Yes** | — | Anthropic API key (console.anthropic.com) |
| `BASE_URL` | **Yes** (production) | `http://localhost:3000` | Public HTTPS URL of this service — no trailing slash. Required for Approve/Deny links in manager emails. |

Copy `.env.example` to `.env` and fill in all required values before running.

---

## Running locally

```bash
npm install
cp .env.example .env
# Edit .env with real credentials
npm run dev
```

The server starts on `http://localhost:3000`. The `/health` endpoint returns `{"status":"ok","service":"aegis"}` when the service is up.

For local webhook testing, use [ngrok](https://ngrok.com/) or similar to expose your local port:

```bash
ngrok http 3000
# Then set BASE_URL=https://your-ngrok-url.ngrok.io in .env
# and point Telnyx + SendGrid webhooks at that URL
```

---

## Deploying to Railway

1. Push the repository to GitHub.
2. In the [Railway dashboard](https://railway.app), create a new project → **Deploy from GitHub repo**.
3. Select the repository. Railway detects the `Dockerfile` automatically via `railway.toml`.
4. In **Variables**, add every required environment variable from the table above. Set `NODE_ENV=production` and `BASE_URL` to the Railway-provided public domain (shown under **Settings → Domains** after first deploy).
5. Deploy. Railway builds the Docker image and starts the container. The `/health` endpoint is used for health checks.

To redeploy after a push, Railway triggers automatically if connected to the GitHub repo. To deploy manually: `railway up` from the CLI.

---

## Post-deployment checklist

### 1. Telnyx — SMS webhook

Each company has its own dedicated Telnyx number, tied to a Messaging Profile.
Point that profile's inbound webhook at Aegis:

1. Open the [Telnyx Portal → Messaging → Messaging Profiles](https://portal.telnyx.com/#/app/messaging).
2. Open the profile the company's number belongs to.
3. Under **Inbound Settings → Webhook URL**, set:
   - **Webhook URL**: `https://[BASE_URL]/webhooks/sms`
   - **Webhook API Version**: `API v2`
4. Enable the carrier-level **HELP/STOP (advanced opt-out)** auto-responses on the profile.
5. Save.

Aegis verifies the `telnyx-signature-ed25519` header (Ed25519 over `${timestamp}|${body}`) on every inbound request using `TELNYX_PUBLIC_KEY`, within a 5-minute replay window. Requests that fail verification are rejected with `403`.

### 2. SendGrid — Inbound Parse webhook

1. Open [SendGrid → Settings → Inbound Parse](https://app.sendgrid.com/settings/parse).
2. Click **Add Host & URL**.
3. Set:
   - **Receiving Domain**: the MX-configured subdomain you're using (e.g., `mail.yourdomain.com`)
   - **Destination URL**: `https://[BASE_URL]/webhooks/email`
   - Enable **POST the raw, full MIME message** if you need raw access (optional — Aegis uses the parsed fields)
4. Save, then configure your domain's MX record to point to `mx.sendgrid.net` as instructed.

### 3. `company_channels` table

For every client company, insert one row per active channel into the `company_channels` table in Supabase:

```sql
-- The Telnyx number assigned to this company (its own dedicated line)
INSERT INTO company_channels (company_id, channel_type, channel_value)
VALUES ('<company_uuid>', 'sms', '+15551234567');

-- The inbound email address this company's employees contact
INSERT INTO company_channels (company_id, channel_type, channel_value)
VALUES ('<company_uuid>', 'email', 'company@mail.yourdomain.com');
```

These values are used by Aegis to match inbound messages to the correct company and to send outbound SMS from the right number.

---

## How the webhooks work

### Telnyx (SMS)

When an SMS arrives at a company's Telnyx number, Telnyx makes an HTTP POST to the configured webhook URL with a JSON body (`data.event_type` = `message.received`, with the sender/recipient/text under `data.payload`). Aegis receives this at `POST /webhooks/sms`, verifies the `telnyx-signature-ed25519` header (Ed25519 over the exact `${timestamp}|${rawBody}` bytes) using `TELNYX_PUBLIC_KEY` to confirm the request genuinely came from Telnyx, then parses the sender's phone number and message body. The recipient number resolves to the tenant via `company_channels`, and the sender is looked up against `employees`/`users` to verify identity before any workflow logic runs. Delivery-receipt events (`message.sent`, `message.finalized`) are acknowledged and ignored. Telnyx expects a 2xx quickly — Aegis replies `200` immediately and processes the message asynchronously. The carrier-reserved keywords `STOP`/`HELP` are handled at the Telnyx messaging-profile (carrier) level and are never routed as workflow intents.

### SendGrid Inbound Parse (email)

When an email arrives at a domain configured for SendGrid Inbound Parse, SendGrid parses the raw MIME message and forwards it as an HTTP POST to the configured URL with `multipart/form-data` fields including `from`, `to`, `subject`, `text`, and `html`. Aegis receives this at `POST /webhooks/email`, extracts the sender address and message body, and performs the same identity verification against Homebase data before routing. The `Message-ID` header is preserved for email thread continuity so Aegis replies land in the same thread. SendGrid retries on non-2xx responses, so Aegis always returns `200 OK` immediately before processing.
