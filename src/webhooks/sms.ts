import { Router } from 'express';
import { verifyTelnyxRequest } from '../middleware/verify-signature';
import { verifySender } from '../security/sender-verification';
import { routeIntent } from '../router/intent-router';
import { saveConversation } from '../logger/conversation';
import { env } from '../config/env';
import type { InboundMessage } from '../security/types';

export const smsWebhook = Router();

// Carrier-reserved compliance keywords (A2P 10DLC advanced opt-out). These are
// handled at the CARRIER level by the Telnyx messaging profile — Telnyx auto-
// suppresses future sends on STOP and can auto-respond to HELP. We recognize
// them here only to make sure a bare keyword is NEVER routed as a workflow
// intent (spec §2.2 / §3.7). YES is deliberately NOT a carrier keyword — the
// onboarding opt-in is the one place a literal reply is a real workflow answer,
// so YES must route normally. START/UNSTOP ARE carrier resubscribe keywords
// (handled by Telnyx); the app must NOT re-answer them with the capabilities menu
// on top of the carrier's resubscribe confirmation (Batch-1.5 #19).
const STOP_KEYWORDS = new Set([
  'STOP',
  'STOPALL',
  'CANCEL',
  'END',
  'QUIT',
  'UNSUBSCRIBE',
  'REVOKE',
  'OPTOUT',
]);
const HELP_KEYWORDS = new Set(['HELP', 'INFO']);
// Carrier resubscribe keywords — Telnyx re-enables the number and sends the
// registered resubscribe confirmation. The app must not route or re-answer these
// (Batch-1.5 #19). YES is intentionally excluded (it's the opt-in workflow answer).
const RESUBSCRIBE_KEYWORDS = new Set(['START', 'UNSTOP']);

// Reference copy of the HELP/compliance text — VERBATIM from the registered A2P
// 10DLC campaign HELP message (Telnyx "Aegis SMS Scheduling — Quria Solutions").
// The live responder is configured on the Telnyx messaging profile (carrier
// level); this constant documents the registered wording so the two stay in sync.
// If you change this, change the Telnyx profile HELP reply AND the campaign
// registration to match — an auditor compares all three.
export const HELP_RESPONSE =
  'Aegis by Quria Solutions: Scheduling assistant for your employer. ' +
  'Msg freq varies. Msg & data rates may apply. Reply STOP to opt out. ' +
  'Support: awdarling@quriasolutions.com';

export function isStopKeyword(body: string): boolean {
  return STOP_KEYWORDS.has(body.trim().toUpperCase());
}
export function isHelpKeyword(body: string): boolean {
  return HELP_KEYWORDS.has(body.trim().toUpperCase());
}
export function isResubscribeKeyword(body: string): boolean {
  return RESUBSCRIBE_KEYWORDS.has(body.trim().toUpperCase());
}

// Minimal shape of a Telnyx inbound-message webhook.
interface TelnyxInboundPayload {
  from?: { phone_number?: string };
  to?: Array<{ phone_number?: string }>;
  text?: string;
}
interface TelnyxWebhookBody {
  data?: {
    event_type?: string;
    payload?: TelnyxInboundPayload;
  };
}

export interface ParsedTelnyxInbound {
  eventType: string | null;
  message: InboundMessage | null; // populated only for message.received
}

// Pure parser for a Telnyx webhook body. Telnyx posts many event types on this
// endpoint (message.received for inbound, message.sent / message.finalized for
// outbound delivery receipts); only message.received carries an inbound text.
export function parseTelnyxInbound(body: TelnyxWebhookBody): ParsedTelnyxInbound {
  const data = body?.data;
  const eventType = typeof data?.event_type === 'string' ? data.event_type : null;

  if (eventType !== 'message.received') {
    return { eventType, message: null };
  }

  const payload = data?.payload ?? {};
  const from = payload.from?.phone_number ?? '';
  const to = Array.isArray(payload.to) ? payload.to[0]?.phone_number ?? '' : '';
  const text = typeof payload.text === 'string' ? payload.text : '';

  const message: InboundMessage = {
    sender: normalizePhone(from),
    recipient: normalizePhone(to),
    body: text.trim(),
    channel: 'sms',
  };
  return { eventType, message };
}

smsWebhook.post('/', verifyTelnyxRequest, async (req, res) => {
  // Telnyx sends application/json; express.json() (wired in index.ts, which also
  // captures req.rawBody for signature verification) has already parsed it.
  const parsed = parseTelnyxInbound(req.body as TelnyxWebhookBody);

  // Acknowledge immediately — Telnyx retries on non-2xx. We then process async.
  res.status(200).json({ received: true });

  // Ignore anything that isn't an inbound message (delivery receipts, etc.).
  if (parsed.eventType !== 'message.received' || !parsed.message) {
    return;
  }
  const message = parsed.message;

  // Email-only mode: SMS is disabled, so ignore inbound rather than routing it.
  // Env-controlled — sandbox testing runs with EMAIL_ONLY=false.
  if (env.EMAIL_ONLY) {
    console.warn('[sms] EMAIL_ONLY mode — ignoring inbound SMS.');
    return;
  }

  console.log('[sms] message.received, starting async processing');

  try {
    if (!message.sender || !message.recipient || !message.body) {
      console.log('[sms] skipping — missing sender/recipient/body');
      return;
    }

    // Carrier-reserved keywords: never route as an intent. STOP suppression and
    // the HELP reply are owned by the Telnyx messaging profile (carrier level).
    if (isStopKeyword(message.body)) {
      console.log(`[sms] STOP keyword from ${message.sender} — carrier handles opt-out; not routing.`);
      return;
    }
    if (isHelpKeyword(message.body)) {
      console.log(`[sms] HELP keyword from ${message.sender} — carrier handles the HELP reply; not routing.`);
      return;
    }
    if (isResubscribeKeyword(message.body)) {
      console.log(`[sms] START/UNSTOP keyword from ${message.sender} — carrier handles resubscribe; not routing.`);
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
  // Telnyx sends E.164; strip whitespace just in case.
  return raw.trim();
}
