/**
 * Public Key Resolver
 *
 * Resolves a DID to its Ed25519 public key using either:
 *  - DB mode: direct query against auth.identities (see `./resolve-db` —
 *    kept out of this module and its `@imajin/auth` root export on purpose,
 *    see the comment there)
 *  - HTTP mode: GET AUTH_SERVICE_URL/api/identity/:did
 */

export interface ResolvedIdentity {
  did: string;
  publicKey: string;
  type: string;
  tier: string;
}

export type PublicKeyResolver = (did: string) => Promise<ResolvedIdentity | null>;

/**
 * Create an HTTP-backed resolver targeting the public registry endpoint.
 *
 * Primary path: GET {serviceUrl}/registry/api/identity/{did} (#1443).
 * This is the canonical transport for did:imajin resolution (RFC-40 §4, transport #1).
 *
 * Interim fallback for callers without HTTP access to the registry:
 *   GET {relay}/proof/v1/identities/:did  (DFOS relay, relay 0.13.5)
 *
 * Trust comes from verifying the chain log, never from this transport alone.
 */
export function createHttpResolver(serviceUrl: string): PublicKeyResolver {
  return async (did: string): Promise<ResolvedIdentity | null> => {
    try {
      const encodedDid = encodeURIComponent(did);
      const res = await fetch(`${serviceUrl}/registry/api/identity/${encodedDid}`, {
        cache: 'no-store',
      });

      if (!res.ok) return null;

      const data = await res.json();
      // Soft/stub DIDs return { verifiable: false } — not resolvable to a key.
      if (!data.did || !data.publicKey) return null;

      return {
        did: data.did,
        publicKey: data.publicKey,
        type: data.type,
        tier: data.tier,
      };
    } catch {
      return null;
    }
  };
}

/**
 * Resolve a DID's public key.
 *
 * Uses DB mode when a db + table are provided, otherwise falls back to HTTP.
 */
export async function resolvePublicKey(
  did: string,
  resolver: PublicKeyResolver
): Promise<ResolvedIdentity | null> {
  return resolver(did);
}
