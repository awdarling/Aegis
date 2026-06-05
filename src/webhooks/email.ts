import { Router } from 'express';
import multer from 'multer';
import { captureRawBody } from '../middleware/capture-raw-body';
import { verifySendGridRequest } from '../middleware/verify-signature';
import { verifySender } from '../security/sender-verification';
import { routeIntent } from '../router/intent-router';
import { saveConversation } from '../logger/conversation';
import { stripEmailBody, stripHtmlTags } from '../utils/strip-email';
import type { InboundMessage } from '../security/types';

// SendGrid Inbound Parse sends multipart/form-data
const upload = multer({ storage: multer.memoryStorage() });

export const emailWebhook = Router();

emailWebhook.post(
  '/',
  captureRawBody,
  verifySendGridRequest,
  upload.any(),
  async (req, res) => {
    console.log('[email-trace] handler entered', { bodyKeys: Object.keys(req.body || {}) });

    // Respond immediately — SendGrid will retry on non-2xx
    console.log('[email-trace] responding', { status: 200 });
    res.status(200).send('ok');

    console.log('[email-trace] body parsing start');
    const body = req.body as Record<string, string>;

    const senderRaw = body['from'] ?? body['sender'] ?? '';
    const recipient = body['to'] ?? body['envelope'] ?? '';
    const subject = body['subject'] ?? '';
    const rawText = (body['text'] ?? '').trim();
    const text = rawText
      ? stripEmailBody(rawText)
      : stripEmailBody(stripHtmlTags(body['html'] ?? ''));
    const messageId = body['headers']
      ? extractMessageId(body['headers'])
      : undefined;

    const sender = extractEmailAddress(senderRaw).toLowerCase();
    const recipientAddress = extractFirstEmailAddress(recipient).toLowerCase();
    console.log('[email-trace] body parsing complete', {
      hasSender: !!sender,
      hasRecipient: !!recipientAddress,
      hasText: !!text,
      subjectLen: subject.length,
    });

    if (!sender || !recipientAddress || !text) {
      console.log('[email-trace] returning early — missing required field', {
        hasSender: !!sender,
        hasRecipient: !!recipientAddress,
        hasText: !!text,
      });
      return;
    }

    // SPF/DKIM gate — From: is trivially spoofable without this.
    // Policy: accept if EITHER SPF or DKIM passes (handles forwarded mail
    // where one verdict fails). SendGrid Inbound Parse sets these fields.
    const spf = (body['SPF'] ?? '').trim().toLowerCase();
    const dkimRaw = (body['dkim'] ?? '').trim();
    const dkimPassed = dkimRaw.includes(': pass}') || dkimRaw.includes(' pass');

    if (spf !== 'pass' && !dkimPassed) {
      console.log('[email-auth] rejecting unauthenticated email', {
        sender,
        recipient: recipientAddress,
        spf,
        dkim: dkimRaw,
      });
      return;
    }

    console.log('[email-auth] authenticated', { sender, spf, dkim: dkimRaw });

    const message: InboundMessage = {
      sender,
      recipient: recipientAddress,
      body: text,
      channel: 'email',
      raw_subject: subject,
      thread_id: messageId,
    };

    console.log('[email-trace] calling verifySender', { sender, recipient: recipientAddress });
    const verification = await verifySender(message);
    console.log('[email-trace] verifySender complete', { ok: verification.ok });
    if (!verification.ok) {
      console.log('[email-trace] returning early — verification failed');
      return;
    }

    console.log('[email-trace] calling saveConversation', { company_id: verification.contact.company_id });
    await saveConversation({
      company_id: verification.contact.company_id,
      channel: 'email',
      direction: 'inbound',
      content: text,
      from_address: sender,
      to_address: recipientAddress,
      subject,
      thread_id: messageId,
    });
    console.log('[email-trace] saveConversation complete');

    console.log('[email-trace] calling routeIntent');
    await routeIntent(message, verification.contact);
    console.log('[email-trace] routeIntent complete — handler done');
  }
);

function extractEmailAddress(raw: string): string {
  // Handles "Name <email@example.com>" and bare "email@example.com"
  const match = raw.match(/<([^>]+)>/);
  return match ? match[1].trim() : raw.split(',')[0].trim();
}

function extractFirstEmailAddress(raw: string): string {
  try {
    // SendGrid sometimes sends envelope JSON: {"to":["addr"],"from":"addr"}
    const parsed = JSON.parse(raw) as { to?: string[] };
    if (parsed.to?.[0]) return parsed.to[0].toLowerCase();
  } catch {
    // Not JSON — treat as plain address or "Name <addr>"
  }
  return extractEmailAddress(raw).toLowerCase();
}

function extractMessageId(headers: string): string | undefined {
  const match = headers.match(/^Message-ID:\s*(<[^>]+>)/im);
  return match?.[1];
}
