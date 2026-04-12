import { db, identities } from '@/src/db';
import { eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export interface IdentityLookup {
  did: string;
  scope: string;
  subtype: string | null;
  handle: string | null;
  name: string | null;
  avatarUrl: string | null;
  tier: string | null;
  metadata: unknown;
  createdAt: Date;
}

/**
 * Look up an identity by DID.
 * Mirrors the logic from app/auth/api/lookup/[id]/route.ts GET handler.
 * Returns null if not found.
 */
export async function lookupIdentity(did: string): Promise<IdentityLookup | null> {
  try {
    const [identity] = await db
      .select({
        id: identities.id,
        scope: identities.scope,
        subtype: identities.subtype,
        handle: identities.handle,
        name: identities.name,
        avatarUrl: identities.avatarUrl,
        tier: identities.tier,
        metadata: identities.metadata,
        createdAt: identities.createdAt,
      })
      .from(identities)
      .where(eq(identities.id, did))
      .limit(1);

    if (!identity) return null;

    return {
      did: identity.id,
      scope: identity.scope,
      subtype: identity.subtype,
      handle: identity.handle,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
      tier: identity.tier,
      metadata: identity.metadata,
      createdAt: identity.createdAt,
    };
  } catch (error) {
    log.error({ did, err: String(error) }, 'lookupIdentity error');
    return null;
  }
}
