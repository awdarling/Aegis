import './config/env'; // validates env vars before anything else
import express from 'express';
import { env } from './config/env';
import { emailWebhook } from './webhooks/email';
import { smsWebhook } from './webhooks/sms';
import { decisionWebhook } from './webhooks/decision';
import { internalRouter } from './webhooks/internal';
import { startCoverageTimeoutScheduler } from './scheduler/coverage-timeout';
import { startPayrollScheduler } from './scheduler/payroll-scheduler';

process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection] Unhandled rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

const app = express();

app.use((req, res, next) => {
  console.log('[req]', req.method, req.path, {
    ua: req.get('user-agent') || 'none',
    ct: req.get('content-type') || 'none',
    cl: req.get('content-length') || 'none',
    ip: req.ip,
  });
  next();
});

// Telnyx posts application/json and signs Ed25519 over the EXACT raw bytes, so
// capture req.rawBody in json()'s verify hook (before the body is parsed) for
// the signature middleware, then hand the parsed JSON to the SMS handler.
app.use(
  '/webhooks/sms',
  express.json({
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }),
  smsWebhook
);

// SendGrid sends multipart/form-data — handled inside emailWebhook with multer
app.use('/webhooks/email', emailWebhook);

// Manager approve/deny clicks from time-off notification emails
app.use('/webhooks/decision', decisionWebhook);

// Internal endpoints called by Homebase /api/aegis-action dispatcher after
// magic-link consumption. Bearer-token auth via AEGIS_INTERNAL_SECRET.
app.use('/internal', internalRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'aegis' });
});

app.listen(env.PORT, () => {
  console.log(`Aegis running on port ${env.PORT} [${env.NODE_ENV}]`);
  if (env.EMAIL_ONLY) {
    console.log('[sms] EMAIL_ONLY mode — SMS disabled (email-first).');
  } else if (env.TELNYX_API_KEY) {
    console.log('[sms] provider: Telnyx — sending number resolves per-tenant from company_channels.');
  } else {
    console.log('[sms] Telnyx not configured — SMS sends will be skipped.');
  }
  if (env.RUN_SCHEDULERS) {
    startCoverageTimeoutScheduler();
    startPayrollScheduler();
  } else {
    console.log('[schedulers] DISABLED (RUN_SCHEDULERS=false) — webhooks-only mode; no cross-tenant background jobs.');
  }
});
