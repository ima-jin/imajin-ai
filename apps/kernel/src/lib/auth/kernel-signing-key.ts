/**
 * Publishes the public half of the kernel's own Ed25519 signing key
 * (`AUTH_PRIVATE_KEY`) for `GET /auth/.well-known/kernel-signing-key`
 * (#2244, child of epic #2241).
 *
 * `AUTH_PRIVATE_KEY` already signs two things consumers verify without a
 * kernel round-trip: session/app JWTs (`jwt.ts`, via jose/EdDSA) and
 * `CorpusAccessClaim`s (`corpus-access-claim.ts`, via `@imajin/auth`'s raw
 * Ed25519 crypto). This module exists so a verifier — today, corpus's
 * `CorpusAccessClaim` middleware — can fetch-and-pin the public half
 * instead of an operator hand-copying it into `CORPUS_KERNEL_PUBLIC_KEY`
 * (#2024's env-pinned trust root).
 *
 * Never touches or derives anything beyond the read-only
 * `authCrypto.getPublicKey()` projection of the configured private key; no
 * private material is held in the returned document or anywhere near it.
 */
import { createHash } from 'node:crypto';
import { crypto as authCrypto } from '@imajin/auth';

export const KERNEL_SIGNING_KEY_ALG = 'Ed25519' as const;

export interface KernelSigningKeyDocument {
  /** Stable per-key identifier — a short hash of the public key itself, so it changes iff the key does. */
  kid: string;
  alg: typeof KERNEL_SIGNING_KEY_ALG;
  /** Hex-encoded Ed25519 public key — same encoding `CORPUS_KERNEL_PUBLIC_KEY` has always used. */
  publicKey: string;
  /**
   * When this process started serving the *current* key value — captured
   * once per process, not the key's true historical mint date (this
   * codebase has never recorded that anywhere, and adding a persisted
   * "key metadata" table for a value nothing treats as an expiry isn't
   * worth the trade-off). Resets on restart or key rotation.
   */
  issuedAt: string;
}

let cachedIssuedAt: string | null = null;

function issuedAt(): string {
  cachedIssuedAt ??= new Date().toISOString();
  return cachedIssuedAt;
}

/** Test-only: clears the memoized `issuedAt` so a test can observe a fresh value. */
export function _resetKernelSigningKeyIssuedAtForTests(): void {
  cachedIssuedAt = null;
}

function computeKid(publicKeyHex: string): string {
  return `auth-${createHash('sha256').update(publicKeyHex).digest('hex').slice(0, 16)}`;
}

/**
 * Builds the well-known signing-key document, or `null` when
 * `AUTH_PRIVATE_KEY` isn't configured — e.g. a dev node relying on
 * `jwt.ts`'s ephemeral in-memory fallback key, which was never meant to be
 * published or pinned by anyone.
 */
export function getKernelSigningKeyDocument(): KernelSigningKeyDocument | null {
  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) return null;

  const publicKey = authCrypto.getPublicKey(privateKey);
  return {
    kid: computeKid(publicKey),
    alg: KERNEL_SIGNING_KEY_ALG,
    publicKey,
    issuedAt: issuedAt(),
  };
}
