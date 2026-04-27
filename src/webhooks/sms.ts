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

  if (!message.sender || !message.recipient || !message.body) return;

  const verification = await verifySender(message);
  if (!verification.ok) {
    // Already logged to security_events — do nothing else
    return;
  }

  await saveConversation({
    company_id: verification.contact.company_id,
    channel: 'sms',
    direction: 'inbound',
    content: message.body,
    from_address: message.sender,
    to_address: message.recipient,
  });

  await routeIntent(message, verification.contact);
});

function normalizePhone(raw: string): string {
  // Twilio always sends E.164; strip whitespace just in case
  return raw.trim();
}
