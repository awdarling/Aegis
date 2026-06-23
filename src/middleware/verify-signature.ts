import type { Request, Response, NextFunction } from 'express';
import twilio from 'twilio';
import { env } from '../config/env';
import { verifySendGridSignature } from '../security/sendgrid-signature';

// Twilio signs every webhook with HMAC-SHA1 using the auth token.
// Reject any request that doesn't pass this check — not just log it.
export function verifyTwilioSignature(req: Request, res: Response, next: NextFunction): void {
  if (process.env.SKIP_TWILIO_VERIFICATION === 'true') {
    console.warn('[WARNING] Twilio signature verification BYPASSED — test mode only. Never use in production.');
    next();
    return;
  }

  // Twilio decommissioned (SMS → Telgorithm): with no auth token we cannot
  // verify any inbound signature, so reject. No Twilio numbers means no inbound
  // SMS reaches this route anyway.
  if (!env.TWILIO_AUTH_TOKEN) {
    res.status(403).json({ error: 'Twilio not configured' });
    return;
  }

  const signature = req.headers['x-twilio-signature'] as string | undefined;

  if (!signature) {
    res.status(403).json({ error: 'Missing Twilio signature' });
    return;
  }

  // Reconstruct the full public URL Twilio signed. Behind Railway's proxy
  // req.protocol/host reflect the internal address, not what Twilio sees, so
  // we use BASE_URL instead.
  const url = `${env.BASE_URL.replace(/\/$/, '')}${req.originalUrl}`;
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

// SendGrid Inbound Parse exposes the same ECDSA signing scheme as the Event
// Webhook once you attach a security policy to the Parse setting. Headers
// are sent under the X-Twilio-Email-Event-Webhook-* namespace; if SendGrid
// ever publishes Parse-specific header names, swap them here.
export const SENDGRID_SIGNATURE_HEADER = 'x-twilio-email-event-webhook-signature';
export const SENDGRID_TIMESTAMP_HEADER = 'x-twilio-email-event-webhook-timestamp';

// Inbound webhook security boundary. Two modes:
//   1. SENDGRID_WEBHOOK_PUBLIC_KEY is set → require a valid ECDSA signature
//      against the raw request body. Reject 403 if missing/invalid.
//   2. SENDGRID_WEBHOOK_PUBLIC_KEY is unset → legacy IP allowlist. Lets us
//      ship this code before the SendGrid-side security policy is attached.
// SKIP_SENDGRID_VERIFICATION=true bypasses both for local testing.
export function verifySendGridRequest(req: Request, res: Response, next: NextFunction): void {
  if (process.env.SKIP_SENDGRID_VERIFICATION === 'true') {
    console.log('[sendgrid-verify] skipped via env var');
    next();
    return;
  }

  const publicKey = env.SENDGRID_WEBHOOK_PUBLIC_KEY;

  if (publicKey) {
    const signature = req.get(SENDGRID_SIGNATURE_HEADER);
    const timestamp = req.get(SENDGRID_TIMESTAMP_HEADER);

    if (!signature || !timestamp) {
      console.warn('[sendgrid-verify] missing signature headers', {
        hasSignature: !!signature,
        hasTimestamp: !!timestamp,
      });
      res.status(403).send('Forbidden: missing SendGrid signature');
      return;
    }

    if (!req.rawBody) {
      // captureRawBody must run before this middleware on signed routes.
      console.error('[sendgrid-verify] rawBody missing — captureRawBody not wired');
      res.status(500).send('Internal error: raw body not captured');
      return;
    }

    try {
      // Byte-exact verification (see src/security/sendgrid-signature.ts). The
      // @sendgrid/eventwebhook helper decodes the body as UTF-8 first, which
      // corrupts non-UTF-8 bytes (e.g. an inline image in a quoted reply) and
      // makes those inbound messages fail verification.
      const valid = verifySendGridSignature(publicKey, req.rawBody, signature, timestamp);

      if (!valid) {
        console.warn('[sendgrid-verify] invalid ECDSA signature', {
          timestamp,
          bodyBytes: req.rawBody.length,
        });
        res.status(403).send('Forbidden: invalid SendGrid signature');
        return;
      }

      console.log('[sendgrid-verify] ECDSA signature verified', { bodyBytes: req.rawBody.length });
      next();
      return;
    } catch (err) {
      console.error('[sendgrid-verify] signature verification threw', err);
      res.status(403).send('Forbidden: signature verification failed');
      return;
    }
  }

  // Fallback: SendGrid-side security policy not yet configured. Keep the IP
  // allowlist so production keeps accepting valid traffic.
  const xff = req.get('x-forwarded-for');
  const sourceIp = xff ? xff.split(',')[0].trim() : (req.ip || '');

  if (sourceIp.startsWith('159.26.')) {
    console.log(`[sendgrid-verify] ip allowlisted (no public key configured): ${sourceIp}`);
    next();
    return;
  }

  console.log(`[sendgrid-verify] rejecting request from ${sourceIp}`);
  res.status(403).send('Forbidden: source IP not allowlisted');
}
