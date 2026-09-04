/**
 * Client-side Ed25519 keypair generation and signing.
 *
 * Shared by every browser flow that mints or uses a raw keypair — account
 * registration (`app/auth/register/page.tsx`) and key recovery
 * (`app/auth/recover/page.tsx`). Runs entirely in the browser: a generated
 * private key never leaves the caller, matching the "user is never handed a
 * key" invariant in docs/auth/recovery.md.
 *
 * `sign` encodes its message as UTF-8 bytes, matching `verifySignature` in
 * `src/lib/auth/crypto.ts` — callers pass the raw challenge/payload string,
 * not hex-decoded bytes.
 */

export interface BrowserKeypair {
  publicKey: string;
  privateKey: string;
}

async function loadEd25519() {
  const ed = await import('@noble/ed25519');
  const { sha512 } = await import('@noble/hashes/sha2.js');
  (ed.etc as { sha512Sync?: (...m: Uint8Array[]) => Uint8Array }).sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));
  return ed;
}

/** Encode bytes as a lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  return bytes.reduce((hex, byte) => hex + byte.toString(16).padStart(2, '0'), '');
}

/** Decode a hex string into bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const pairs = hex.match(/[0-9a-f]{2}/gi) ?? [];
  return Uint8Array.from(pairs.map((pair) => Number.parseInt(pair, 16)));
}

/** Generate a fresh Ed25519 keypair entirely client-side. */
export async function generateKeypair(): Promise<BrowserKeypair> {
  const privateKeyBytes = new Uint8Array(32);
  crypto.getRandomValues(privateKeyBytes);

  const ed = await loadEd25519();
  const publicKeyBytes = await ed.getPublicKeyAsync(privateKeyBytes);

  return {
    privateKey: bytesToHex(privateKeyBytes),
    publicKey: bytesToHex(publicKeyBytes),
  };
}

/** Sign a UTF-8 message with a hex-encoded Ed25519 private key. */
export async function sign(message: string, privateKeyHex: string): Promise<string> {
  const ed = await loadEd25519();
  const messageBytes = new TextEncoder().encode(message);
  const privateKeyBytes = hexToBytes(privateKeyHex);
  const signatureBytes = await ed.signAsync(messageBytes, privateKeyBytes);
  return bytesToHex(signatureBytes);
}
