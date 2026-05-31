import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

// Bearer-token auth middleware for /internal/* routes. The secret is shared
// between Aegis (Railway) and Homebase (Vercel) — both must hold the same
// AEGIS_INTERNAL_SECRET. Comparison is constant-time. Misconfiguration
// (env var unset) returns 500 — fail-closed.
export function requireInternalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const configured = process.env.AEGIS_INTERNAL_SECRET;
  if (!configured) {
    console.error('[internal-auth] AEGIS_INTERNAL_SECRET is not configured — refusing all internal requests');
    res.status(500).json({ error: 'Internal auth not configured' });
    return;
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const provided = header.slice('Bearer '.length);

  // Constant-time comparison requires equal-length buffers; if the lengths
  // differ we already know it's wrong, but we still allocate a same-length
  // buffer to avoid leaking length info via timing on the unequal branch.
  const a = Buffer.from(provided);
  const b = Buffer.from(configured);
  if (a.length !== b.length) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (!crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}
