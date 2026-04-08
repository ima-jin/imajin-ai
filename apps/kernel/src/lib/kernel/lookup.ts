import { db, identities } from '@/src/db';
import { eq } from 'drizzle-orm';

export interface IdentityLookup {
  did: string;
  type: string;
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
        type: identities.type,
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
      type: identity.type,
      handle: identity.handle,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
      tier: identity.tier,
      metadata: identity.metadata,
      createdAt: identity.createdAt,
    };
  } catch (error) {
    console.error('lookupIdentity error:', error);
    return null;
  }
}
