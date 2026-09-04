/**
 * Test-only helper that mints `Imajin-Claim` headers matching the wire format
 * `apps/corpus/src/middleware/access-claim.ts` verifies, without depending on
 * the kernel app (a separate package). Mirrors
 * `apps/kernel/src/lib/kernel/corpus-access-claim.ts`'s encoding exactly.
 */
import { canonicalize, crypto as authCrypto } from '@imajin/auth';

export type TestClaimScope = 'corpus:read' | 'corpus:write';

export interface TestClaimOverrides {
  did?: string;
  scope?: TestClaimScope;
  aud?: string;
  issuerDid?: string;
  issuedAt?: number;
  expiresAt?: number;
  nonce?: string;
}

let nonceCounter = 0;

/** Returns the full `Authorization` header value: `Imajin-Claim <encoded>.<sig>`. */
export function mintTestClaimHeader(privateKey: string, overrides: TestClaimOverrides = {}): string {
  const issuedAt = overrides.issuedAt ?? Date.now();
  const claim = {
    did: overrides.did ?? 'did:example:alice',
    scope: overrides.scope ?? 'corpus:read',
    aud: overrides.aud ?? 'corpus',
    issuerDid: overrides.issuerDid ?? 'did:imajin:test-kernel',
    issuedAt,
    expiresAt: overrides.expiresAt ?? issuedAt + 60_000,
    nonce: overrides.nonce ?? `test-nonce-${nonceCounter++}`,
  };

  const encodedClaim = Buffer.from(canonicalize(claim), 'utf8').toString('base64url');
  const signature = authCrypto.signSync(encodedClaim, privateKey);
  return `Imajin-Claim ${encodedClaim}.${signature}`;
}
