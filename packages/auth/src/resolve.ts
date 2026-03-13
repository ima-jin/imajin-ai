/**
 * Public Key Resolver
 *
 * Resolves a DID to its Ed25519 public key using either:
 *  - DB mode: direct query against auth.identities
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
 * Create a DB-backed resolver.
 * Accepts a db instance and the identities table (to avoid hard coupling to the app).
 */
export function createDbResolver(
  db: { select: Function },
  identitiesTable: unknown
): PublicKeyResolver {
  return async (did: string): Promise<ResolvedIdentity | null> => {
    const { eq } = await import('drizzle-orm');
    const table = identitiesTable as any;

    const rows = await (db as any)
      .select({
        id: table.id,
        publicKey: table.publicKey,
        type: table.type,
        tier: table.tier,
      })
      .from(table)
      .where(eq(table.id, did))
      .limit(1);

    if (!rows || rows.length === 0) return null;

    return {
      did: rows[0].id,
      publicKey: rows[0].publicKey,
      type: rows[0].type,
      tier: rows[0].tier,
    };
  };
}

/**
 * Create an HTTP-backed resolver.
 * Calls GET {authServiceUrl}/api/identity/{did}
 */
export function createHttpResolver(authServiceUrl: string): PublicKeyResolver {
  return async (did: string): Promise<ResolvedIdentity | null> => {
    try {
      const encodedDid = encodeURIComponent(did);
      const res = await fetch(`${authServiceUrl}/api/identity/${encodedDid}`, {
        cache: 'no-store',
      });

      if (!res.ok) return null;

      const data = await res.json();
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
