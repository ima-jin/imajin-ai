/**
 * Minimal Ed25519 primitives for `@ima-jin/auth-client`'s bootstrap keypair
 * (#2411, restart-authentication ruling) — hex-encoded 32-byte keys, same
 * `@noble/ed25519` primitive `packages/auth/src/crypto.ts` already uses for
 * every DID keypair in this codebase (and the same library the /jin
 * dashboard already dynamically imports client-side for operator
 * countersignatures — `apps/kernel/app/jin/operator-approvals-panel.tsx`).
 *
 * Deliberately duplicated here rather than depending on `@imajin/auth`:
 * that package pulls in a much heavier dependency graph (the full
 * attestation/scope/broker vocabulary) that this lean, federated-app SDK
 * has no other reason to carry — the same "packages/auth-client must not
 * pull in the kernel's own internals" boundary `packages/auth/src/
 * vault-client.ts` already documents for the sibling `loadFromVault` case.
 */
import * as ed25519 from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// Required for @noble/ed25519 v2 — same one-time configuration
// packages/auth/src/crypto.ts performs.
ed25519.etc.sha512Sync = (...m) => sha512(ed25519.etc.concatBytes(...m));

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export interface BootstrapKeypair {
  /** Hex-encoded 32-byte Ed25519 public key. */
  publicKey: string;
  /** Hex-encoded 32-byte Ed25519 private key. Persist only in the local keystore file. */
  privateKey: string;
}

/** Generate a fresh Ed25519 bootstrap keypair, hex-encoded. */
export function generateBootstrapKeypair(): BootstrapKeypair {
  const privateKeyBytes = ed25519.utils.randomPrivateKey();
  const publicKeyBytes = ed25519.getPublicKey(privateKeyBytes);
  return { privateKey: bytesToHex(privateKeyBytes), publicKey: bytesToHex(publicKeyBytes) };
}

/** Sign a UTF-8 string with a hex-encoded Ed25519 private key. Returns a hex-encoded signature. */
export function signBootstrapPayload(message: string, privateKeyHex: string): string {
  const signature = ed25519.sign(new TextEncoder().encode(message), hexToBytes(privateKeyHex));
  return bytesToHex(signature);
}

/**
 * Canonical form of a bootstrap-key fetch challenge — MUST match the
 * kernel's `apps/kernel/src/lib/apps/bootstrap-fetch-auth.ts`'s
 * `canonicalizeBootstrapFetchPayload` byte-for-byte. Keys are listed in a
 * fixed alphabetical order rather than relying on the generic recursive
 * `canonicalize` this package deliberately does not depend on (see this
 * module's docblock).
 */
export function canonicalizeBootstrapFetchPayload(payload: { appDid: string; nonce: string; timestamp: number }): string {
  return `{"appDid":${JSON.stringify(payload.appDid)},"nonce":${JSON.stringify(payload.nonce)},"timestamp":${payload.timestamp}}`;
}
