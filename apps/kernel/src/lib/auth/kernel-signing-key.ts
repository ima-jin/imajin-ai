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
 * Multi-key / rotation grace window (#2244's "on key rotation, serve both
 * old and new during a grace window"): the document always carries a
 * `keys` array plus `current` naming the active `kid`. There is no
 * automatic rotation mechanism in this codebase today — `AUTH_PRIVATE_KEY`
 * is a single env var an operator changes by hand — so the "old" key
 * during a rotation is whatever the operator explicitly names via
 * `AUTH_PREVIOUS_PUBLIC_KEY` (+ a required `..._VALID_UNTIL` bound, so
 * dual trust can never linger indefinitely by omission). See
 * `getPreviousKeyEntries()`.
 *
 * Never touches or derives anything beyond the read-only
 * `authCrypto.getPublicKey()` projection of the configured private key; no
 * private material is held in the returned document or anywhere near it.
 */
import { createHash } from 'node:crypto';
import { crypto as authCrypto } from '@imajin/auth';

export const KERNEL_SIGNING_KEY_ALG = 'Ed25519' as const;

export interface KernelSigningKeyEntry {
  /** Stable per-key identifier — a hash of the public key itself, so it changes iff the key does. */
  kid: string;
  /** Hex-encoded Ed25519 public key — same encoding `CORPUS_KERNEL_PUBLIC_KEY` has always used. */
  publicKey: string;
  algorithm: typeof KERNEL_SIGNING_KEY_ALG;
  /** When this key became (or, for the current key, is known to have become) valid. */
  validFrom: string;
  /** Present only on a grace-window "previous" key — when it stops being served/trusted. */
  validUntil?: string;
}

export interface KernelSigningKeyDocument {
  /** Every key currently vouched for — normally just the current one, plus a previous one during a rotation grace window. */
  keys: KernelSigningKeyEntry[];
  /** `kid` of the key `AUTH_PRIVATE_KEY` signs with right now. */
  current: string;
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
 * Optional grace-window entry for a just-rotated-out key (#2244). Requires
 * BOTH `AUTH_PREVIOUS_PUBLIC_KEY` and `AUTH_PREVIOUS_PUBLIC_KEY_VALID_UNTIL`
 * — a bare "previous key" with no expiry would mean indefinite dual trust
 * by omission, which defeats the point of a *grace window*. Once
 * `..._VALID_UNTIL` passes, the entry stops being served automatically
 * (the operator doesn't have to remember to remove it, only to set it).
 *
 * `AUTH_PREVIOUS_PUBLIC_KEY_VALID_FROM` is optional and defaults to the
 * unix epoch: this codebase has never recorded when a key was actually
 * minted, only that the previous key predates the current one.
 */
function getPreviousKeyEntries(): KernelSigningKeyEntry[] {
  const previousPublicKey = process.env.AUTH_PREVIOUS_PUBLIC_KEY;
  const validUntilRaw = process.env.AUTH_PREVIOUS_PUBLIC_KEY_VALID_UNTIL;
  if (!previousPublicKey || !validUntilRaw) return [];
  if (!authCrypto.isValidPublicKey(previousPublicKey)) return [];

  const validUntil = new Date(validUntilRaw);
  if (Number.isNaN(validUntil.getTime()) || validUntil.getTime() <= Date.now()) return [];

  const validFromRaw = process.env.AUTH_PREVIOUS_PUBLIC_KEY_VALID_FROM;
  const parsedValidFrom = validFromRaw ? new Date(validFromRaw) : null;
  const validFrom =
    parsedValidFrom && !Number.isNaN(parsedValidFrom.getTime()) ? parsedValidFrom.toISOString() : new Date(0).toISOString();

  return [
    {
      kid: computeKid(previousPublicKey),
      publicKey: previousPublicKey,
      algorithm: KERNEL_SIGNING_KEY_ALG,
      validFrom,
      validUntil: validUntil.toISOString(),
    },
  ];
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

  const currentPublicKey = authCrypto.getPublicKey(privateKey);
  const current: KernelSigningKeyEntry = {
    kid: computeKid(currentPublicKey),
    publicKey: currentPublicKey,
    algorithm: KERNEL_SIGNING_KEY_ALG,
    validFrom: issuedAt(),
  };

  return {
    keys: [current, ...getPreviousKeyEntries()],
    current: current.kid,
  };
}
