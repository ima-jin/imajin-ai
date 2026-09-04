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

interface CorpusAccessClaim {
  did: string;
  scope: CorpusAccessScope;
  aud: 'corpus';
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
  if (!header || !header.startsWith(CLAIM_SCHEME_PREFIX)) return null;
  const token = header.slice(CLAIM_SCHEME_PREFIX.length);
  const separatorIndex = token.lastIndexOf('.');
  if (separatorIndex <= 0 || separatorIndex === token.length - 1) return null;
  return { encodedClaim: token.slice(0, separatorIndex), signature: token.slice(separatorIndex + 1) };
}

function isCorpusAccessClaimShape(value: unknown): value is CorpusAccessClaim {
  if (typeof value !== 'object' || value === null) return false;
  const claim = value as Record<string, unknown>;
  return (
    typeof claim.did === 'string' &&
    (claim.scope === 'corpus:read' || claim.scope === 'corpus:write') &&
    claim.aud === 'corpus' &&
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

/** Tracks nonces seen within their own claim's validity window; swept lazily. */
class NonceReplayGuard {
  private readonly seen = new Map<string, number>();

  /** Returns true when `nonce` was already used and has not yet expired. */
  isReplay(nonce: string, expiresAt: number, now: number): boolean {
    for (const [seenNonce, seenExpiresAt] of this.seen) {
      if (seenExpiresAt <= now) this.seen.delete(seenNonce);
    }
    if (this.seen.has(nonce)) return true;
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
