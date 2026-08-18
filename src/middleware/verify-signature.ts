import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { verifySendGridSignature } from '../security/sendgrid-signature';
import {
  verifyTelnyxSignature,
  TELNYX_SIGNATURE_HEADER,
  TELNYX_TIMESTAMP_HEADER,
} from '../security/telnyx-signature';

// Telnyx signs every webhook with Ed25519 over the exact bytes
// `${telnyx-timestamp}|${rawBody}`. Verify (and reject on failure) before the
// SMS handler runs. The express.json() verify hook wired on /webhooks/sms in
// index.ts must have populated req.rawBody with the exact request bytes.
export function verifyTelnyxRequest(req: Request, res: Response, next: NextFunction): void {
  if (process.env.SKIP_TELNYX_VERIFICATION === 'true') {
    console.warn('[telnyx-verify] signature verification BYPASSED — test mode only. Never use in production.');
    next();
    return;
  }

  const publicKey = env.TELNYX_PUBLIC_KEY;
  if (!publicKey) {
    // No signing key configured → we cannot trust any inbound webhook, reject.
    res.status(403).json({ error: 'Telnyx not configured' });
    return;
  }

  const signature = req.get(TELNYX_SIGNATURE_HEADER);
  const timestamp = req.get(TELNYX_TIMESTAMP_HEADER);
  if (!signature || !timestamp) {
    res.status(403).json({ error: 'Missing Telnyx signature' });
    return;
  }

  if (!req.rawBody) {
    console.error('[telnyx-verify] rawBody missing — express.json verify hook not wired');
    res.status(500).json({ error: 'raw body not captured' });
    return;
  }

  const valid = verifyTelnyxSignature(publicKey, req.rawBody, signature, timestamp);
  if (!valid) {
    console.warn('[telnyx-verify] invalid signature from', req.ip);
    res.status(403).json({ error: 'Invalid Telnyx signature' });
    return;
  }

  next();
}

// SendGrid Inbound Parse exposes the same ECDSA signing scheme as the Event
// Webhook once you attach a security policy to the Parse setting. Headers
// are sent under the X-Twilio-Email-Event-Webhook-* namespace; if SendGrid
// ever publishes Parse-specific header names, swap them here.
//
// NOTE — the only correct "twilio" string left in this codebase. SendGrid is a
// Twilio-owned product and this is SendGrid's own header name; it has nothing to
// do with SMS. Aegis's SMS provider is Telnyx (see verifyTelnyxRequest above).
// Do not "clean this up".
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
