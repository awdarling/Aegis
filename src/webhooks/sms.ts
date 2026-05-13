import { Router } from 'express';
import { verifyTwilioSignature } from '../middleware/verify-signature';
import { verifySender } from '../security/sender-verification';
import { routeIntent } from '../router/intent-router';
import { saveConversation } from '../logger/conversation';
import type { InboundMessage } from '../security/types';

export const smsWebhook = Router();

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
