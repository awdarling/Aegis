import './config/env'; // validates env vars before anything else
import express from 'express';
import { env } from './config/env';
import { emailWebhook } from './webhooks/email';
import { smsWebhook } from './webhooks/sms';
import { decisionWebhook } from './webhooks/decision';

const app = express();

// Raw body needed for Twilio signature verification — must come before json()
app.use(
  '/webhooks/sms',
  express.urlencoded({ extended: false }),
  smsWebhook
);

// SendGrid sends multipart/form-data — handled inside emailWebhook with multer
app.use('/webhooks/email', emailWebhook);

// Manager approve/deny clicks from time-off notification emails
app.use('/webhooks/decision', decisionWebhook);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'aegis' });
});

app.listen(env.PORT, () => {
  console.log(`Aegis running on port ${env.PORT} [${env.NODE_ENV}]`);
});
