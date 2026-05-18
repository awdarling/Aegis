import { Router } from 'express';
import twilio from 'twilio';
import { verifyTwilioSignature } from '../middleware/verify-signature';
import { verifySender } from '../security/sender-verification';
import { routeIntent } from '../router/intent-router';
import { saveConversation } from '../logger/conversation';
import { env } from '../config/env';
import type { InboundMessage } from '../security/types';

export const smsWebhook = Router();

const HELP_KEYWORDS = new Set(['HELP', 'INFO']);
const HELP_RESPONSE =
  'Aegis by Quria Solutions: Scheduling assistant for your employer. ' +
  'Msg freq varies. Msg & data rates may apply. Reply STOP to opt out. ' +
  'Support: awdarling@quriasolutions.com';

const twilioClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

async function sendHelpResponse(to: string): Promise<void> {
  const payload: { to: string; body: string; from?: string; messagingServiceSid?: string } = {
    to,
    body: HELP_RESPONSE,
  };
  if (env.TWILIO_MESSAGING_SERVICE_SID) {
    payload.messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID;
  } else if (env.TWILIO_FROM_NUMBER) {
    payload.from = env.TWILIO_FROM_NUMBER;
  } else {
    throw new Error('No TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER configured');
  }
  await twilioClient.messages.create(payload);
}

smsWebhook.post('/', verifyTwilioSignature, async (req, res) => {
  // Twilio sends URL-encoded body; express.urlencoded() has already parsed it
  const body = req.body as Record<string, string>;

  const message: InboundMessage = {
    sender: normalizePhone(body['From'] ?? ''),
    recipient: normalizePhone(body['To'] ?? ''),
    body: (body['Body'] ?? '').trim(),
    channel: 'sms',
  };

  // Respond to Twilio immediately — it retries if we don't reply within 15s
  // We return 200 before awaiting full processing, then process async
  res.status(200).type('text/xml').send('<Response></Response>');

  console.log('[sms] request received, starting async processing');

  try {
    if (!message.sender || !message.recipient || !message.body) {
      console.log('[sms] skipping — missing sender/recipient/body');
      return;
    }

    if (HELP_KEYWORDS.has(message.body.toUpperCase())) {
      console.log(`[sms] HELP keyword received from ${message.sender}, sending compliance response`);
      try {
        await sendHelpResponse(message.sender);
      } catch (err) {
        console.error('[sms] HELP response send failed:', err);
      }
      return;
    }

    console.log('[sms] verifying sender:', message.sender);
    const verification = await verifySender(message);
    if (!verification.ok) {
      console.log('[sms] verification failed:', verification.reason);
      return;
    }
    console.log('[sms] sender verified:', JSON.stringify(verification.contact));

    await saveConversation({
      company_id: verification.contact.company_id,
      channel: 'sms',
      direction: 'inbound',
      content: message.body,
      from_address: message.sender,
      to_address: message.recipient,
    });

    console.log('[sms] routing message, body:', message.body);
    await routeIntent(message, verification.contact);
    console.log('[sms] routing complete');
  } catch (err) {
    console.error('[sms] FATAL unhandled error:', err);
  }
});

function normalizePhone(raw: string): string {
  // Twilio always sends E.164; strip whitespace just in case
  return raw.trim();
}
