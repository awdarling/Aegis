import crypto from 'crypto';

// Byte-exact Ed25519 verification of a Telnyx signed webhook.
//
// Telnyx signs every webhook with Ed25519. The signed message is the exact
// bytes `${telnyx-timestamp}|${raw-request-body}` (ASCII timestamp, a literal
// pipe, then the raw JSON body). The signature arrives base64-encoded in the
// `telnyx-signature-ed25519` header and the unix-seconds timestamp in the
// `telnyx-timestamp` header. The verifying key is the account's base64 Ed25519
// public key from the Telnyx portal (Account Settings → Keys & Credentials, or
// the Messaging Profile). See the SendGrid verifier for why we hash the raw
// Buffer directly (no UTF-8 round-trip): a JSON body is valid UTF-8 today, but
// keeping it byte-exact means the verifier never silently breaks on an odd body.
//
// We derive the public key with Node's own crypto rather than pulling in a
// separate ed25519 library: a raw 32-byte Ed25519 public key becomes a valid
// SPKI key by prefixing the fixed 12-byte DER header below, and
// crypto.verify(null, …) does Ed25519 (the algorithm arg MUST be null).
const ED25519_SPKI_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export const TELNYX_SIGNATURE_HEADER = 'telnyx-signature-ed25519';
export const TELNYX_TIMESTAMP_HEADER = 'telnyx-timestamp';

// Default replay window Telnyx recommends (and its own SDK enforces): 5 minutes.
const DEFAULT_TOLERANCE_SECONDS = 300;

export interface TelnyxVerifyOptions {
  // Seconds of clock skew tolerated between the signed timestamp and now.
  // Pass 0 to disable the replay-window check (not recommended in production).
  toleranceSeconds?: number;
  // Injectable "now" (unix seconds) for deterministic tests.
  nowSeconds?: number;
}

export function verifyTelnyxSignature(
  publicKeyBase64: string,
  rawBody: Buffer,
  signatureBase64: string,
  timestamp: string,
  options: TelnyxVerifyOptions = {}
): boolean {
  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

  // Replay-window check first — a stale (or absurd) timestamp is rejected even
  // if the signature is otherwise valid.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (toleranceSeconds > 0) {
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > toleranceSeconds) return false;
  }

  // Exact bytes Telnyx signed: ASCII "timestamp|" followed by the raw body.
  const signedMessage = Buffer.concat([
    Buffer.from(`${timestamp}|`, 'utf8'),
    rawBody,
  ]);

  let signature: Buffer;
  let rawKey: Buffer;
  try {
    signature = Buffer.from(signatureBase64, 'base64');
    rawKey = Buffer.from(publicKeyBase64, 'base64');
  } catch {
    return false;
  }
  // Ed25519 public keys are 32 bytes; signatures are 64.
  if (rawKey.length !== 32 || signature.length !== 64) return false;

  try {
    const der = Buffer.concat([ED25519_SPKI_DER_PREFIX, rawKey]);
    const keyObject = crypto.createPublicKey({
      key: der,
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, signedMessage, keyObject, signature);
  } catch {
    return false;
  }
}
