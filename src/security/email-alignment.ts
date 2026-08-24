// Inbound-email sender authentication with DMARC-style alignment.
//
// Why this exists (N-1, SECURITY_AUDIT_MASTER §8, 2026-08-24): the From: header
// is whatever the sender wrote. SPF only proves the *envelope* sender's domain
// authorised the sending server, and a DKIM pass only proves *some* domain
// signed the message. Neither is tied to From: unless we tie it. Without this
// check, anyone with their own mail domain could send
// "From: <a manager's saved address>" and Aegis would run the message as that
// manager — approve time off, distribute the schedule, request coverage.
//
// Rule (Alexander, 2026-08-24): a manager acts from the inbox saved for them in
// Homebase, full stop. So the domain that passed authentication must be the
// From: domain (relaxed alignment: same organisational domain, so a DKIM
// signature from `mail.club.com` still vouches for `manager@club.com`).
//
// Inputs are the raw SendGrid Inbound Parse fields:
//   SPF      → "pass" | "fail" | "softfail" | "neutral" | "none" | ...
//   dkim     → "{@club.com : pass}" or "{@a.com : pass, @b.com : fail}" or "none"
//   envelope → JSON {"to":["…"],"from":"bounce@club.com"}
//   from     → the display From: header, e.g. "Jane <jane@club.com>"

export interface EmailAuthInputs {
  fromHeader: string;
  spf: string;
  dkim: string;
  envelope: string;
}

export interface EmailAuthVerdict {
  authenticated: boolean;
  /** Which mechanism vouched for the From: domain, or why nothing did. */
  reason: 'spf-aligned' | 'dkim-aligned' | 'no-pass' | 'spf-unaligned' | 'dkim-unaligned' | 'no-from-domain';
  fromDomain: string | null;
  envelopeDomain: string | null;
  dkimPassDomains: string[];
}

export function extractAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return (match ? match[1] : raw.split(',')[0]).trim().toLowerCase();
}

export function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 0) return null;
  const d = address.slice(at + 1).trim().toLowerCase().replace(/[>\s]+$/, '');
  return d.length > 0 ? d : null;
}

/** Relaxed alignment: equal, or one is a subdomain of the other. */
export function domainsAligned(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith('.' + b) || b.endsWith('.' + a);
}

export function envelopeFromDomain(envelope: string): string | null {
  if (!envelope) return null;
  try {
    const parsed = JSON.parse(envelope) as { from?: unknown };
    if (typeof parsed.from === 'string') return domainOf(extractAddress(parsed.from));
    return null;
  } catch {
    // Not JSON — SendGrid sometimes hands a bare address here.
    return domainOf(extractAddress(envelope));
  }
}

/** Domains whose DKIM signature SendGrid reports as passing. */
export function dkimPassDomains(dkim: string): string[] {
  const out: string[] = [];
  if (!dkim) return out;
  // Each entry looks like "@domain : verdict"; tolerate braces, commas, spacing.
  const entries = dkim.replace(/[{}]/g, '').split(',');
  for (const entry of entries) {
    const m = entry.match(/@\s*([A-Za-z0-9.-]+)\s*:\s*([A-Za-z]+)/);
    if (m && m[2].toLowerCase() === 'pass') out.push(m[1].toLowerCase());
  }
  return out;
}

export function authenticateInboundEmail(input: EmailAuthInputs): EmailAuthVerdict {
  const fromDomain = domainOf(extractAddress(input.fromHeader));
  const envelopeDomain = envelopeFromDomain(input.envelope);
  const passDomains = dkimPassDomains(input.dkim);
  const spfPass = input.spf.trim().toLowerCase() === 'pass';

  const base = { fromDomain, envelopeDomain, dkimPassDomains: passDomains };

  if (!fromDomain) return { authenticated: false, reason: 'no-from-domain', ...base };

  if (passDomains.some((d) => domainsAligned(d, fromDomain))) {
    return { authenticated: true, reason: 'dkim-aligned', ...base };
  }
  if (spfPass && domainsAligned(envelopeDomain, fromDomain)) {
    return { authenticated: true, reason: 'spf-aligned', ...base };
  }

  // Something passed, but for a different domain than From: — the spoof shape.
  if (passDomains.length > 0) return { authenticated: false, reason: 'dkim-unaligned', ...base };
  if (spfPass) return { authenticated: false, reason: 'spf-unaligned', ...base };
  return { authenticated: false, reason: 'no-pass', ...base };
}
