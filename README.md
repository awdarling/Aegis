# Aegis

Aegis is an AI assistant manager for companies using Homebase scheduling software, built by Quria Solutions. It handles inbound communication from employees and managers via SMS (Twilio) and email (SendGrid Inbound Parse), classifying each message and executing the appropriate workflow: time-off requests, shift swaps, emergency coverage, schedule building, and general operational queries. Managers interact with Aegis through the same channels their team uses — no separate app or portal required.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | No | `development` | Runtime environment (`development`, `production`, `test`) |
| `PORT` | No | `3000` | HTTP server port. Railway injects this automatically. |
| `SUPABASE_URL` | **Yes** | — | Full Supabase project URL (Settings → API) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | — | Supabase service role key — bypasses RLS, keep secret |
| `TWILIO_ACCOUNT_SID` | **Yes** | — | Twilio Account SID (Twilio Console dashboard) |
| `TWILIO_AUTH_TOKEN` | **Yes** | — | Twilio Auth Token — also used to verify inbound webhook signatures |
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
# and point Twilio + SendGrid webhooks at that URL
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

### 1. Twilio — SMS webhook

For each company's dedicated Twilio phone number:

1. Open [Twilio Console → Phone Numbers → Active Numbers](https://console.twilio.com/us1/develop/phone-numbers/manage/active).
2. Click the number.
3. Under **Messaging → A Message Comes In**, set:
   - **Webhook**: `https://[BASE_URL]/webhooks/sms`
   - **HTTP Method**: `HTTP POST`
4. Save.

Aegis verifies the `X-Twilio-Signature` header on every inbound request using `TWILIO_AUTH_TOKEN`. Requests that fail signature verification are silently dropped.

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
-- The Twilio number assigned to this company
INSERT INTO company_channels (company_id, channel_type, channel_value)
VALUES ('<company_uuid>', 'sms', '+15551234567');

-- The inbound email address this company's employees contact
INSERT INTO company_channels (company_id, channel_type, channel_value)
VALUES ('<company_uuid>', 'email', 'company@mail.yourdomain.com');
```

These values are used by Aegis to match inbound messages to the correct company and to send outbound SMS from the right number.

---

## How the webhooks work

### Twilio (SMS)

When an SMS arrives at a Twilio number, Twilio makes an HTTP POST to the configured webhook URL with URL-encoded form fields (`From`, `To`, `Body`, and others). Aegis receives this at `POST /webhooks/sms`, verifies the `X-Twilio-Signature` header using the Auth Token to confirm the request genuinely came from Twilio, then parses the sender's phone number and message body. The sender is looked up against the `company_channels` and `employees`/`users` tables to verify their identity before any workflow logic runs. Twilio expects a 2xx response quickly — Aegis replies with `200 OK` immediately and processes the message asynchronously.

### SendGrid Inbound Parse (email)

When an email arrives at a domain configured for SendGrid Inbound Parse, SendGrid parses the raw MIME message and forwards it as an HTTP POST to the configured URL with `multipart/form-data` fields including `from`, `to`, `subject`, `text`, and `html`. Aegis receives this at `POST /webhooks/email`, extracts the sender address and message body, and performs the same identity verification against Homebase data before routing. The `Message-ID` header is preserved for email thread continuity so Aegis replies land in the same thread. SendGrid retries on non-2xx responses, so Aegis always returns `200 OK` immediately before processing.
