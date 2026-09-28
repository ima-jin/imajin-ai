/**
 * Bootstrap-key fetch authentication (#2411, restart-authentication ruling).
 *
 * The one-time claim code (`signing-key-claims.ts`) only ever authenticates
 * the FIRST boot. Every boot after that re-authenticates a signing-key
 * grant fetch by signing a fresh, short-lived challenge with the app's own
 * bootstrap private key — persisted only in the app's local keystore file,
 * never on the kernel — rather than spending a new operator-approved claim
 * code. This module verifies that signature against the bootstrap PUBLIC
 * key bound at claim time (`resolveActiveBootstrapBinding`).
 *
 * ## Canonical payload
 * The app signs `{ appDid, nonce, timestamp }`, canonicalized with
 * `@imajin/auth`'s `canonicalize` (sorted keys, deterministic). The exact
 * same three fields, in the exact same shape, must be reproduced verbatim
 * by `@ima-jin/auth-client`'s signer — see that package's
 * `bootstrap-key.ts` for the duplicated (dependency-free) implementation of
 * this same canonicalization, the same "packages/auth-client must not pull
 * in the heavier `@imajin/auth` dependency graph" rule already documented
 * on `packages/auth/src/vault-client.ts`.
 *
 * ## Replay protection
 * Single-instance, in-memory nonce guard — the same accepted trade-off
 * `apps/corpus/src/middleware/access-claim.ts`'s `NonceReplayGuard` already
 * documents for `CorpusAccessClaim`: state lives in process memory and is
 * lost on restart / not shared across replicas, acceptable given the short
 * timestamp window and that the kernel runs as a single process per node
 * today. Revisit if the kernel is ever horizontally scaled.
 */
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { resolveActiveBootstrapBinding, type BootstrapBinding } from './signing-key-claims';

/** How far a fetch request's own `timestamp` may drift from the kernel's clock, either direction. */
const MAX_CLOCK_SKEW_MS = 60_000;

/** Hard cap on tracked nonces, independent of the lazy expiry sweep below. */
const MAX_TRACKED_NONCES = 10_000;

/**
 * Tracks nonces seen within their own request's validity window; swept
 * lazily. See this module's docblock for the accepted in-memory trade-off.
 */
class NonceReplayGuard {
  private readonly seen = new Map<string, number>();

  /** Returns true when `nonce` was already used and has not yet expired. */
  isReplay(nonce: string, expiresAt: number, now: number): boolean {
    for (const [seenNonce, seenExpiresAt] of this.seen) {
      if (seenExpiresAt <= now) this.seen.delete(seenNonce);
    }
    if (this.seen.has(nonce)) return true;

    while (this.seen.size >= MAX_TRACKED_NONCES) {
      const oldestNonce = this.seen.keys().next().value;
      if (oldestNonce === undefined) break;
      this.seen.delete(oldestNonce);
    }
    this.seen.set(nonce, expiresAt);
    return false;
  }

  clear(): void {
    this.seen.clear();
  }
}

const replayGuard = new NonceReplayGuard();

/** Test-only: clears tracked nonces so each test starts from a clean slate. */
export function _resetBootstrapFetchNonceGuardForTests(): void {
  replayGuard.clear();
}

/** Canonical form of a bootstrap fetch challenge — must match `@ima-jin/auth-client`'s signer exactly. */
export function canonicalizeBootstrapFetchPayload(payload: { appDid: string; nonce: string; timestamp: number }): string {
  return canonicalize({ appDid: payload.appDid, nonce: payload.nonce, timestamp: payload.timestamp });
}

export type BootstrapFetchAuthOutcome =
  | { status: 'ok'; binding: BootstrapBinding }
  | { status: 'no_binding' | 'invalid_signature' | 'stale_timestamp' | 'replayed_nonce' };

/**
 * Verify a subsequent-boot signing-key fetch request. Resolution order
 * mirrors `CorpusAccessClaim`'s verifier (`apps/corpus/src/middleware/
 * access-claim.ts`): the signature is checked before the replay guard ever
 * marks the nonce as seen, so an invalid-signature attempt never burns a
 * nonce a legitimate retry might reuse.
 *
 * Never throws for an ordinary refusal — every outcome is a `status` value
 * so the route layer can respond and audit uniformly.
 */
export async function verifyBootstrapFetchAuth(params: {
  appDid: string;
  timestamp: number;
  nonce: string;
  signature: string;
}): Promise<BootstrapFetchAuthOutcome> {
  const { appDid, timestamp, nonce, signature } = params;

  const binding = await resolveActiveBootstrapBinding(appDid);
  if (!binding) {
    return { status: 'no_binding' };
  }

  const canonical = canonicalizeBootstrapFetchPayload({ appDid, nonce, timestamp });
  if (!authCrypto.verifySync(signature, canonical, binding.boundPublicKey)) {
    return { status: 'invalid_signature' };
  }

  const now = Date.now();
  if (Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) {
    return { status: 'stale_timestamp' };
  }

  if (replayGuard.isReplay(nonce, now + MAX_CLOCK_SKEW_MS, now)) {
    return { status: 'replayed_nonce' };
  }

  return { status: 'ok', binding };
}
