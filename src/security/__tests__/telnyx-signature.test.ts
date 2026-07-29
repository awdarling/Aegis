import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { verifyTelnyxSignature } from '../telnyx-signature';

// Build an Ed25519 keypair and return the public key in the SAME base64 raw-key
// form the Telnyx portal gives you (32 bytes, base64), so the test exercises the
// exact decoding path production uses.
function makeKeypair(): { privateKey: crypto.KeyObject; publicKeyBase64: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const rawPub = der.subarray(der.length - 32); // raw 32-byte key is the SPKI tail
  return { privateKey, publicKeyBase64: rawPub.toString('base64') };
}

// Sign the EXACT bytes Telnyx signs: `${timestamp}|` || rawBody.
function sign(privateKey: crypto.KeyObject, timestamp: string, body: Buffer): string {
  const msg = Buffer.concat([Buffer.from(`${timestamp}|`, 'utf8'), body]);
  return crypto.sign(null, msg, privateKey).toString('base64');
}

describe('verifyTelnyxSignature — Ed25519 over `${timestamp}|${rawBody}`', () => {
  const { privateKey, publicKeyBase64 } = makeKeypair();
  const timestamp = '1785000000';
  const now = Number(timestamp); // pin "now" to the signed time for determinism
  const body = Buffer.from(
    JSON.stringify({ data: { event_type: 'message.received' } }),
    'utf8'
  );

  it('verifies a valid signature', () => {
    const sig = sign(privateKey, timestamp, body);
    expect(verifyTelnyxSignature(publicKeyBase64, body, sig, timestamp, { nowSeconds: now })).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = sign(privateKey, timestamp, body);
    const tampered = Buffer.from('{"data":{"event_type":"message.received","x":1}}', 'utf8');
    expect(verifyTelnyxSignature(publicKeyBase64, tampered, sig, timestamp, { nowSeconds: now })).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const other = makeKeypair();
    const sig = sign(other.privateKey, timestamp, body);
    expect(verifyTelnyxSignature(publicKeyBase64, body, sig, timestamp, { nowSeconds: now })).toBe(false);
  });

  it('rejects a timestamp mismatch (signature was over a different timestamp)', () => {
    const sig = sign(privateKey, timestamp, body);
    // Verify against a different timestamp within the tolerance window: the
    // signed message no longer matches, so it must fail.
    expect(verifyTelnyxSignature(publicKeyBase64, body, sig, '1785000001', { nowSeconds: now })).toBe(false);
  });

  it('rejects a stale timestamp outside the replay window', () => {
    const sig = sign(privateKey, timestamp, body);
    const wayLater = now + 3600; // 1 hour later, default tolerance is 5 min
    expect(verifyTelnyxSignature(publicKeyBase64, body, sig, timestamp, { nowSeconds: wayLater })).toBe(false);
  });

  it('accepts a stale timestamp when the replay window is disabled (toleranceSeconds: 0)', () => {
    const sig = sign(privateKey, timestamp, body);
    const wayLater = now + 3600;
    expect(
      verifyTelnyxSignature(publicKeyBase64, body, sig, timestamp, { nowSeconds: wayLater, toleranceSeconds: 0 })
    ).toBe(true);
  });

  it('rejects a malformed / wrong-length public key', () => {
    const sig = sign(privateKey, timestamp, body);
    expect(verifyTelnyxSignature('not-base64-and-too-short', body, sig, timestamp, { nowSeconds: now })).toBe(false);
  });

  it('rejects a non-numeric timestamp', () => {
    const sig = sign(privateKey, timestamp, body);
    expect(verifyTelnyxSignature(publicKeyBase64, body, sig, 'abc', { nowSeconds: now })).toBe(false);
  });

  it('is byte-exact: verifies a body containing non-UTF-8 bytes', () => {
    const binBody = Buffer.concat([Buffer.from('{"t":"', 'utf8'), Buffer.from([0xff, 0xfe, 0x80]), Buffer.from('"}', 'utf8')]);
    const sig = sign(privateKey, timestamp, binBody);
    expect(verifyTelnyxSignature(publicKeyBase64, binBody, sig, timestamp, { nowSeconds: now })).toBe(true);
  });
});
