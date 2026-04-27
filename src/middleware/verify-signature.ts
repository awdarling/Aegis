import type { Request, Response, NextFunction } from 'express';
import twilio from 'twilio';
import { env } from '../config/env';

// Twilio signs every webhook with HMAC-SHA1 using the auth token.
// Reject any request that doesn't pass this check — not just log it.
export function verifyTwilioSignature(req: Request, res: Response, next: NextFunction): void {
  const signature = req.headers['x-twilio-signature'] as string | undefined;

  if (!signature) {
    res.status(403).json({ error: 'Missing Twilio signature' });
    return;
  }

  // Reconstruct the full URL Twilio signed — must match what Twilio sees
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const params = req.body as Record<string, string>;

  const valid = twilio.validateRequest(
    env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    params
  );

  if (!valid) {
    console.warn('[middleware] Invalid Twilio signature from', req.ip);
    res.status(403).json({ error: 'Invalid Twilio signature' });
    return;
  }

  next();
}

// SendGrid Inbound Parse does not provide a cryptographic signature on the
// multipart webhook payload. We rely on:
//   1. The webhook URL being a secret path
//   2. Twilio-style sender verification at the application layer
// If SendGrid Event Webhook (separate from Inbound Parse) is used later,
// add ECDSA verification here using SENDGRID_WEBHOOK_VERIFICATION_KEY.
export function verifySendGridRequest(_req: Request, _res: Response, next: NextFunction): void {
  // No cryptographic verification available for SendGrid Inbound Parse.
  // Application-layer sender verification in verifySender() is the gate.
  next();
}
