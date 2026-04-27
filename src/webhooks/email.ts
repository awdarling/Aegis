import { Router } from 'express';
import multer from 'multer';
import { verifySendGridRequest } from '../middleware/verify-signature';
import { verifySender } from '../security/sender-verification';
import { routeIntent } from '../router/intent-router';
import { saveConversation } from '../logger/conversation';
import type { InboundMessage } from '../security/types';

// SendGrid Inbound Parse sends multipart/form-data
const upload = multer({ storage: multer.memoryStorage() });

export const emailWebhook = Router();

emailWebhook.post(
  '/',
  verifySendGridRequest,
  upload.any(),
  async (req, res) => {
    // Respond immediately — SendGrid will retry on non-2xx
    res.status(200).send('ok');

    const body = req.body as Record<string, string>;

    const senderRaw = body['from'] ?? body['sender'] ?? '';
    const recipient = body['to'] ?? body['envelope'] ?? '';
    const subject = body['subject'] ?? '';
    const text = (body['text'] ?? body['html'] ?? '').trim();
    const messageId = body['headers']
      ? extractMessageId(body['headers'])
      : undefined;

    const sender = extractEmailAddress(senderRaw).toLowerCase();
    const recipientAddress = extractFirstEmailAddress(recipient).toLowerCase();

    if (!sender || !recipientAddress || !text) return;

    const message: InboundMessage = {
      sender,
      recipient: recipientAddress,
      body: text,
      channel: 'email',
      raw_subject: subject,
      thread_id: messageId,
    };

    const verification = await verifySender(message);
    if (!verification.ok) {
      return;
    }

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

    await routeIntent(message, verification.contact);
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
