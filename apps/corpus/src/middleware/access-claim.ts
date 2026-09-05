/**
 * CorpusAccessClaim verification middleware (#1751, folded into #2021's
 * "Service DID + CorpusAccessClaim middleware" checklist item).
 *
 * Every `/corpus/:did/*` route used to answer with no authentication at all —
 * anyone who could reach this service's port could read or write any DID's
 * corpus. This middleware requires a fresh, kernel-signed `CorpusAccessClaim`
 * (see `apps/kernel/src/lib/kernel/corpus-access-claim.ts`) naming exactly
 * the DID being addressed, and rejects everything else.
 *
 * Trust root: `CORPUS_KERNEL_PUBLIC_KEY`, the hex Ed25519 public key matching
 * the kernel's `AUTH_PRIVATE_KEY`. Env-pinned rather than fetched from the
 * kernel's DID document at startup — see the module comment on
 * `corpus-access-claim.ts` for why. No network call happens on this path at
 * all, which trivially satisfies the "no callback" requirement from
 * spikes/corpus-identity/README.md.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { crypto as authCrypto } from '@imajin/auth';

export type CorpusAccessScope = 'corpus:read' | 'corpus:write';

/** Crypto-agility rule: every signed envelope in this codebase carries `alg`. */
const SUPPORTED_ALG = 'Ed25519';
type SupportedAlg = typeof SUPPORTED_ALG;

interface CorpusAccessClaim {
  did: string;
  scope: CorpusAccessScope;
  aud: 'corpus';
  alg: SupportedAlg;
  issuerDid: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

/** Defensive ceiling against a kernel bug minting a too-long-lived claim. */
const MAX_CLAIM_TTL_MS = 5 * 60_000;

const CLAIM_SCHEME_PREFIX = 'Imajin-Claim ';

interface EncodedClaim {
  encodedClaim: string;
  signature: string;
}

function parseClaimHeader(header: string | undefined): EncodedClaim | null {
  if (!header?.startsWith(CLAIM_SCHEME_PREFIX)) return null;
  const token = header.slice(CLAIM_SCHEME_PREFIX.length);
  const separatorIndex = token.lastIndexOf('.');
  if (separatorIndex <= 0 || separatorIndex === token.length - 1) return null;
  return { encodedClaim: token.slice(0, separatorIndex), signature: token.slice(separatorIndex + 1) };
}

/** Rejects any claim whose `alg` isn't the one algorithm this verifier trusts today. */
function isCorpusAccessClaimShape(value: unknown): value is CorpusAccessClaim {
  if (typeof value !== 'object' || value === null) return false;
  const claim = value as Record<string, unknown>;
  return (
    typeof claim.did === 'string' &&
    (claim.scope === 'corpus:read' || claim.scope === 'corpus:write') &&
    claim.aud === 'corpus' &&
    claim.alg === SUPPORTED_ALG &&
    typeof claim.issuerDid === 'string' &&
    typeof claim.issuedAt === 'number' &&
    typeof claim.expiresAt === 'number' &&
    typeof claim.nonce === 'string'
  );
}

function decodeClaim(encodedClaim: string): CorpusAccessClaim | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encodedClaim, 'base64url').toString('utf8'));
    return isCorpusAccessClaimShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isExpired(claim: CorpusAccessClaim, now: number): boolean {
  const ttl = claim.expiresAt - claim.issuedAt;
  return now > claim.expiresAt || ttl <= 0 || ttl > MAX_CLAIM_TTL_MS;
}

/** Hard cap on tracked nonces, independent of the lazy expiry sweep below. */
const MAX_TRACKED_NONCES = 10_000;

/**
 * Tracks nonces seen within their own claim's validity window; swept lazily.
 *
 * Single-instance, in-memory only: state lives in process memory and is lost
 * on restart / not shared across replicas. That's an accepted trade-off given
 * claims are short-lived (≤5min) and corpus runs as a single process today —
 * revisit if corpus is ever horizontally scaled behind a load balancer.
 *
 * The expiry-based sweep in `isReplay` bounds steady-state size, but a burst
 * of many distinct (non-repeating) nonces arriving faster than they expire
 * could otherwise grow the map unbounded before any of them are swept. The
 * `MAX_TRACKED_NONCES` cap below evicts the oldest entries (Map preserves
 * insertion order) once that happens, trading replay protection for bounded
 * memory rather than growing without limit.
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
}

/**
 * Creates the access-claim middleware. A fresh instance (and nonce guard)
 * should be created per corpus app/router instance — this is what
 * `createCorpusRouter` does, and what tests should do for isolation.
 */
export function createAccessClaimMiddleware(): RequestHandler {
  const replayGuard = new NonceReplayGuard();

  return function verifyAccessClaim(request: Request, response: Response, next: NextFunction): void {
    // Env-pinned, never fetched or derived at runtime: corpus must never hold
    // (or be able to derive) the kernel's AUTH_PRIVATE_KEY (apps/kernel/.env.example),
    // only its public half. The corpus operator sets CORPUS_KERNEL_PUBLIC_KEY
    // to the hex Ed25519 public key matching that private key (see the module
    // comment above for why this is env-pinned rather than resolved over the
    // network). Documented in apps/corpus/.env.example, landing via #2022 —
    // not added here to avoid clobbering that concurrent change.
    const kernelPublicKey = process.env.CORPUS_KERNEL_PUBLIC_KEY;
    if (!kernelPublicKey) {
      response.status(401).json({ error: 'corpus service misconfigured: no trusted kernel public key' });
      return;
    }

    const parsed = parseClaimHeader(request.headers.authorization);
    if (!parsed || !authCrypto.verifySync(parsed.signature, parsed.encodedClaim, kernelPublicKey)) {
      response.status(401).json({ error: 'missing or invalid CorpusAccessClaim' });
      return;
    }

    const claim = decodeClaim(parsed.encodedClaim);
    if (!claim) {
      response.status(401).json({ error: 'invalid CorpusAccessClaim shape' });
      return;
    }

    const now = Date.now();
    if (isExpired(claim, now) || replayGuard.isReplay(claim.nonce, claim.expiresAt, now)) {
      response.status(401).json({ error: 'CorpusAccessClaim expired or replayed' });
      return;
    }

    if (claim.did !== request.params.did) {
      response.status(403).json({ error: 'CorpusAccessClaim does not authorize this DID' });
      return;
    }

    next();
  };
}
