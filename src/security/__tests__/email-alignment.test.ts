// N-1 (SECURITY_AUDIT_MASTER §8, 2026-08-24): inbound email must be
// authenticated FOR ITS From: DOMAIN, not merely authenticated by anyone.
import { describe, it, expect } from 'vitest';
import {
  authenticateInboundEmail,
  dkimPassDomains,
  domainsAligned,
  envelopeFromDomain,
} from '../email-alignment';

const MANAGER = 'Jane Manager <jane@watermarkcc.com>';

describe('email sender alignment (N-1)', () => {
  it('accepts a normal reply: SPF pass and the envelope is the same domain as From:', () => {
    const v = authenticateInboundEmail({
      fromHeader: MANAGER, spf: 'pass', dkim: 'none',
      envelope: '{"to":["aegis@quriasolutions.com"],"from":"jane@watermarkcc.com"}',
    });
    expect(v.authenticated).toBe(true);
    expect(v.reason).toBe('spf-aligned');
  });

  it('accepts a DKIM pass signed by the From: domain (Google Workspace / M365 shape)', () => {
    const v = authenticateInboundEmail({
      fromHeader: MANAGER, spf: 'fail', dkim: '{@watermarkcc.com : pass}',
      envelope: '{"to":["aegis@quriasolutions.com"],"from":"jane@watermarkcc.com"}',
    });
    expect(v.authenticated).toBe(true);
    expect(v.reason).toBe('dkim-aligned');
  });

  it('accepts relaxed alignment — a signing subdomain vouches for the parent', () => {
    const v = authenticateInboundEmail({
      fromHeader: MANAGER, spf: 'none', dkim: '{@mail.watermarkcc.com : pass}', envelope: '',
    });
    expect(v.authenticated).toBe(true);
  });

  it('REJECTS the spoof: SPF pass for the attacker envelope, From: forged as the manager', () => {
    const v = authenticateInboundEmail({
      fromHeader: MANAGER, spf: 'pass', dkim: 'none',
      envelope: '{"to":["aegis@quriasolutions.com"],"from":"bounce@attacker-mail.net"}',
    });
    expect(v.authenticated).toBe(false);
    expect(v.reason).toBe('spf-unaligned');
  });

  it('REJECTS the spoof: DKIM pass from the attacker domain, From: forged as the manager', () => {
    const v = authenticateInboundEmail({
      fromHeader: MANAGER, spf: 'pass', dkim: '{@attacker-mail.net : pass}',
      envelope: '{"to":["aegis@quriasolutions.com"],"from":"bounce@attacker-mail.net"}',
    });
    expect(v.authenticated).toBe(false);
    expect(v.reason).toBe('dkim-unaligned');
  });

  it('REJECTS mail with no passing mechanism at all (the old gate did too)', () => {
    const v = authenticateInboundEmail({
      fromHeader: MANAGER, spf: 'softfail', dkim: '{@watermarkcc.com : fail}',
      envelope: '{"from":"jane@watermarkcc.com"}',
    });
    expect(v.authenticated).toBe(false);
    expect(v.reason).toBe('no-pass');
  });

  it('a DKIM verdict list with one attacker pass and one manager fail does not authenticate', () => {
    const v = authenticateInboundEmail({
      fromHeader: MANAGER, spf: 'none',
      dkim: '{@attacker-mail.net : pass, @watermarkcc.com : fail}', envelope: '',
    });
    expect(v.authenticated).toBe(false);
  });

  it('no From: domain at all is rejected, never passed through', () => {
    const v = authenticateInboundEmail({ fromHeader: 'garbage', spf: 'pass', dkim: 'none', envelope: '' });
    expect(v.authenticated).toBe(false);
    expect(v.reason).toBe('no-from-domain');
  });
});

describe('field parsers', () => {
  it('parses SendGrid dkim strings in the shapes seen in production', () => {
    expect(dkimPassDomains('{@watermarkcc.com : pass}')).toEqual(['watermarkcc.com']);
    expect(dkimPassDomains('{@a.com : pass, @b.com : fail}')).toEqual(['a.com']);
    expect(dkimPassDomains('{@A.COM:pass}')).toEqual(['a.com']);
    expect(dkimPassDomains('none')).toEqual([]);
    expect(dkimPassDomains('')).toEqual([]);
  });
  it('reads the envelope sender domain from JSON or a bare address', () => {
    expect(envelopeFromDomain('{"to":["x@y.com"],"from":"bounce@club.com"}')).toBe('club.com');
    expect(envelopeFromDomain('Bounce <bounce@club.com>')).toBe('club.com');
    expect(envelopeFromDomain('')).toBeNull();
  });
  it('aligns equal and parent/sub domains only', () => {
    expect(domainsAligned('club.com', 'club.com')).toBe(true);
    expect(domainsAligned('mail.club.com', 'club.com')).toBe(true);
    expect(domainsAligned('club.com', 'notclub.com')).toBe(false);
    expect(domainsAligned('evilclub.com', 'club.com')).toBe(false);
    expect(domainsAligned(null, 'club.com')).toBe(false);
  });
});
