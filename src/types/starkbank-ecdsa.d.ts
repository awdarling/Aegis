// Minimal ambient declaration for `starkbank-ecdsa` (the ECDSA implementation
// that @sendgrid/eventwebhook depends on). The package ships no types. We only
// declare the surface we use for byte-exact inbound-webhook signature checks.
declare module 'starkbank-ecdsa' {
  export class PublicKey {
    static fromPem(pem: string): PublicKey;
    toPem(): string;
  }
  export class PrivateKey {
    constructor();
    publicKey(): PublicKey;
    toPem(): string;
  }
  export class Signature {
    static fromBase64(base64: string): Signature;
    toBase64(): string;
  }
  export const Ecdsa: {
    sign(message: Buffer | string, privateKey: PrivateKey, hashfunc?: string): Signature;
    verify(
      message: Buffer | string,
      signature: Signature,
      publicKey: PublicKey,
      hashfunc?: string
    ): boolean;
  };
}
