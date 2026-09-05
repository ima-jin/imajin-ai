/**
 * CorpusAccessClaim minting (#1772, folded into #2021's "Service DID +
 * CorpusAccessClaim middleware" checklist item).
 *
 * The corpus service (`apps/corpus/`) has no session/cookie auth of its own —
 * it is invoked only through the kernel's MCP proxy (`mcp/tools/corpus.ts`)
 * and the DID-dashboard client (`corpus-client.ts`). Historically both sent
 * plain, unsigned HTTP calls, so anyone who could reach the corpus service's
 * port could read or write any DID's corpus. Every proxied call must now
 * carry a fresh, short-lived, signed claim naming exactly which DID it may
 * act as, so corpus can verify the request without a per-request callback to
 * the kernel.
 *
 * Signing key: reuses `AUTH_PRIVATE_KEY`, the kernel node's existing Ed25519
 * key already used to sign .fair manifests (`sign-fair-manifest.ts`) and
 * identity-sign payloads (`app/auth/api/identity/[did]/sign/route.ts`) — no
 * new keypair is minted for this.
 *
 * Verification key distribution (corpus side): env-pinned
 * (`CORPUS_KERNEL_PUBLIC_KEY`, the hex public key matching `AUTH_PRIVATE_KEY`),
 * mirroring the `AUTH_PRIVATE_KEY` / `INTERNAL_API_KEY` env-secret pattern
 * already used at every other kernel-to-service boundary in this codebase
 * (see `identity/[did]/sign/route.ts`'s `INTERNAL_API_KEY` check). This is
 * simpler than the fetch-and-cache-from-DID-document approach sketched in
 * `spikes/corpus-identity/README.md` — that approach isn't used by any
 * shipped service yet and would add a startup dependency on the kernel being
 * reachable from corpus. Revisit once corpus mints its own service DID for
 * the ingestion-attestation work (#2021).
 */
import { randomUUID } from 'node:crypto';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';

export type CorpusAccessScope = 'corpus:read' | 'corpus:write';

/** Claims live at most 60s — comfortably under the 5-minute ceiling corpus enforces. */
const CORPUS_ACCESS_CLAIM_TTL_MS = 60_000;

/** Fixed audience so a claim minted for corpus can never be replayed at another service. */
const CORPUS_ACCESS_CLAIM_AUDIENCE = 'corpus';

/**
 * Crypto-agility rule: every signed envelope in this codebase carries `alg`,
 * so a future key/algorithm rotation has somewhere to branch from instead of
 * silently reinterpreting old and new claims the same way. Only one value
 * exists today; the corpus verifier rejects anything else with 401.
 */
const CORPUS_ACCESS_CLAIM_ALG = 'Ed25519';

export interface CorpusAccessClaim {
  /** DID this claim authorizes access to — must equal the `:did` path param on corpus. */
  did: string;
  scope: CorpusAccessScope;
  aud: typeof CORPUS_ACCESS_CLAIM_AUDIENCE;
  alg: typeof CORPUS_ACCESS_CLAIM_ALG;
  /** DID of the claim issuer — the kernel's own node DID. */
  issuerDid: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

/**
 * Mint a signed CorpusAccessClaim for `did`/`scope`, ready to attach as
 * `Authorization: Imajin-Claim <claim>.<sig>` on a proxied corpus call.
 *
 * Throws if `AUTH_PRIVATE_KEY` isn't configured — callers should let this
 * fail the request rather than silently falling back to an unsigned call.
 */
export async function mintCorpusAccessClaim(did: string, scope: CorpusAccessScope): Promise<string> {
  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('AUTH_PRIVATE_KEY not configured — cannot mint CorpusAccessClaim');
  }

  // Deferred (not a top-level import): node-identity.ts opens a DB client at
  // module load time, which throws when DATABASE_URL isn't set. A static
  // import here would make merely importing this module (e.g. transitively,
  // via corpus-client.ts) fail in any test/tooling context without a DB —
  // a dynamic import defers that cost to when a claim is actually minted.
  const { getNodeDid } = await import('./node-identity');

  const issuedAt = Date.now();
  const claim: CorpusAccessClaim = {
    did,
    scope,
    aud: CORPUS_ACCESS_CLAIM_AUDIENCE,
    alg: CORPUS_ACCESS_CLAIM_ALG,
    issuerDid: await getNodeDid(),
    issuedAt,
    expiresAt: issuedAt + CORPUS_ACCESS_CLAIM_TTL_MS,
    nonce: randomUUID(),
  };

  // Sign over the exact bytes transmitted (the encoded claim), not the parsed
  // object, so the verifier never needs to re-canonicalize to check the
  // signature — it just verifies the signature against the literal string,
  // then decodes it to read the fields.
  const encodedClaim = Buffer.from(canonicalize(claim), 'utf8').toString('base64url');
  const signature = authCrypto.signSync(encodedClaim, privateKey);
  return `${encodedClaim}.${signature}`;
}

/** The `Authorization` header scheme used for CorpusAccessClaims. */
export const CORPUS_CLAIM_AUTH_SCHEME = 'Imajin-Claim';

/** Build the full `Authorization` header value for a minted claim. */
export async function corpusAccessClaimHeader(did: string, scope: CorpusAccessScope): Promise<string> {
  return `${CORPUS_CLAIM_AUTH_SCHEME} ${await mintCorpusAccessClaim(did, scope)}`;
}
