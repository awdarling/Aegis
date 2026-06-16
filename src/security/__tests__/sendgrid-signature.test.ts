import { describe, it, expect } from 'vitest';
import { PrivateKey, Ecdsa } from 'starkbank-ecdsa';
import { EventWebhook } from '@sendgrid/eventwebhook';
import { verifySendGridSignature } from '../sendgrid-signature';

// Sign the EXACT bytes SendGrid signs: `timestamp` || `rawBody`.
function sign(priv: PrivateKey, rawBody: Buffer, timestamp: string): string {
  const message = Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]);
  return Ecdsa.sign(message, priv).toBase64();
}

describe('verifySendGridSignature — byte-exact inbound verification', () => {
  const priv = new PrivateKey();
  const pem = priv.publicKey().toPem();
  const timestamp = '1781650189';

  it('verifies a plain ASCII body', () => {
    const body = Buffer.from('to=sandbox@aegis.quriasolutions.com&text=yes', 'utf8');
    expect(verifySendGridSignature(pem, body, sign(priv, body, timestamp), timestamp)).toBe(true);
  });

  it('verifies a body with non-UTF-8 / binary bytes (the reply-with-inline-image case)', () => {
    // 0xff/0xfe/0x80/0xc3 0x28 are invalid UTF-8 sequences — the kind of bytes an
    // inline image (or a non-UTF-8 charset part) puts into a quoted reply body.
    const body = Buffer.concat([
      Buffer.from('text=yes\r\n--boundary\r\n', 'utf8'),
      Buffer.from([0xff, 0xfe, 0x80, 0x00, 0xc3, 0x28, 0xa9]),
    ]);
    expect(verifySendGridSignature(pem, body, sign(priv, body, timestamp), timestamp)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body = Buffer.from('text=yes', 'utf8');
    const sig = sign(priv, body, timestamp);
    expect(verifySendGridSignature(pem, Buffer.from('text=no', 'utf8'), sig, timestamp)).toBe(false);
  });

  it('rejects a mismatched timestamp', () => {
    const body = Buffer.from('text=yes', 'utf8');
    const sig = sign(priv, body, timestamp);
    expect(verifySendGridSignature(pem, body, sig, '9999999999')).toBe(false);
  });

  it('regression: the old @sendgrid/eventwebhook path FAILS on binary bytes — our fix passes', () => {
    const body = Buffer.concat([Buffer.from('text=yes', 'utf8'), Buffer.from([0xff, 0xfe, 0x80])]);
    const sig = sign(priv, body, timestamp);

    // New byte-exact path: passes.
    expect(verifySendGridSignature(pem, body, sig, timestamp)).toBe(true);

    // Old path: `payload.toString()` corrupts the binary bytes before hashing,
    // so the signature no longer matches — exactly the production failure.
    const ew = new EventWebhook();
    const key = ew.convertPublicKeyToECDSA(pem);
    expect(ew.verifySignature(key, body, sig, timestamp)).toBe(false);
  });
});
