import type { Request, Response, NextFunction } from 'express';
import twilio from 'twilio';
import { env } from '../config/env';

// Twilio signs every webhook with HMAC-SHA1 using the auth token.
// Reject any request that doesn't pass this check — not just log it.
export function verifyTwilioSignature(req: Request, res: Response, next: NextFunction): void {
  if (process.env.SKIP_TWILIO_VERIFICATION === 'true') {
    console.warn('[WARNING] Twilio signature verification BYPASSED — test mode only. Never use in production.');
    next();
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

// SendGrid Inbound Parse is not signed, so we allowlist by source IP.
// Behind Railway's proxy, req.ip is the proxy's internal IP — the real
// client IP arrives via x-forwarded-for. Fall back to req.ip when XFF
// is absent (e.g., local curl tests).
export function verifySendGridRequest(req: Request, res: Response, next: NextFunction): void {
  const xff = req.get('x-forwarded-for');
  const sourceIp = xff ? xff.split(',')[0].trim() : (req.ip || '');

  if (process.env.SKIP_SENDGRID_VERIFICATION === 'true') {
    console.log('[sendgrid-verify] skipped via env var');
    next();
    return;
  }

  if (sourceIp.startsWith('159.26.')) {
    console.log(`[sendgrid-verify] ip allowlisted: ${sourceIp}`);
    next();
    return;
  }

  console.log(`[sendgrid-verify] rejecting request from ${sourceIp}`);
  res.status(403).send('Forbidden: source IP not allowlisted');
}
