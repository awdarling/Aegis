import { Ecdsa, Signature, PublicKey } from 'starkbank-ecdsa';

// Byte-exact ECDSA verification of a SendGrid signed inbound webhook.
//
// WHY WE DON'T USE @sendgrid/eventwebhook's `verifySignature` HERE:
// that helper does `payload.toString()` before hashing, which decodes the body
// as UTF-8. SendGrid signs sha256 over the EXACT request bytes (`timestamp` ||
// `rawBody`). Any inbound message whose body contains non-UTF-8 bytes — e.g. an
// inline image carried in a quoted email reply, or a non-UTF-8 charset part —
// gets mangled by that toString() (invalid byte sequences become U+FFFD), so the
// recomputed hash no longer matches the signature and verification fails. That
// is exactly why short text-only emails verified but replies-with-quoted-content
// did not.
//
// This implementation hashes the raw bytes directly (Buffer, no string
// round-trip) using the SAME ECDSA primitives (PublicKey.fromPem /
// Signature.fromBase64 / Ecdsa.verify) the SendGrid helper uses internally, so
// for valid-UTF-8 bodies it is identical to the old path, and for binary-bearing
// bodies it is correct where the old path silently failed.
export function verifySendGridSignature(
  publicKeyPem: string,
  rawBody: Buffer,
  signature: string,
  timestamp: string
): boolean {
  // Exact bytes SendGrid signed: ASCII timestamp followed by the raw body.
  const message = Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]);
  const key = PublicKey.fromPem(publicKeyPem);
  const decodedSignature = Signature.fromBase64(signature);
  // Ecdsa.verify hashes `message` via crypto.createHash('sha256').update(...);
  // passing a Buffer hashes the raw bytes with no encoding round-trip.
  return Ecdsa.verify(message, decodedSignature, key);
}
