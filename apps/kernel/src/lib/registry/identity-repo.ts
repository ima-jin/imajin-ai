import { and, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, identities, identityAliases } from '@/src/db';
import type { DbExecutor } from '@/src/lib/vault';
import type { IdentityAliasRepo } from './identity-alias';

/**
 * Map a partner-supplied entity type onto a canonical identity scope/subtype.
 * Travelers are people (actor); everything else is a business-scoped soft
 * entity. The raw partner type is always preserved in metadata.type.
 */
export function mapType(type: string): { scope: string; subtype: string } {
  if (type === 'traveler') return { scope: 'actor', subtype: 'human' };
  return { scope: 'business', subtype: type };
}

/** Drizzle-backed repository enforcing the unique (namespace, ref) constraint. */
export const identityRepo = (registeredByAppDid: string | null, executor: DbExecutor = db): IdentityAliasRepo => ({
  async findAlias(namespace, ref) {
    const [row] = await executor
      .select({ did: identityAliases.did })
      .from(identityAliases)
      .where(and(eq(identityAliases.namespace, namespace), eq(identityAliases.ref, ref)))
      .limit(1);
    return row?.did ?? null;
  },

  async claimAlias(namespace, ref, did) {
    const claimed = await executor
      .insert(identityAliases)
      .values({ namespace, ref, did })
      .onConflictDoNothing({ target: [identityAliases.namespace, identityAliases.ref] })
      .returning({ did: identityAliases.did });
    return claimed.length > 0;
  },

  async createIdentity(did, type, metadata) {
    const { scope, subtype } = mapType(type);
    const name = typeof metadata.name === 'string' ? metadata.name.slice(0, 100) : null;
    const [identity] = await executor
      .insert(identities)
      .values({
        id: did,
        scope,
        subtype,
        registeredByAppDid,
        publicKey: `soft_${nanoid(32)}`, // no keypair; placeholder satisfies NOT NULL UNIQUE
        handle: null,
        name,
        metadata,
      })
      .returning();
    return (identity.metadata as Record<string, unknown> | null) ?? metadata;
  },

  async getIdentityMetadata(did) {
    const [identity] = await executor
      .select({ metadata: identities.metadata })
      .from(identities)
      .where(eq(identities.id, did))
      .limit(1);
    if (!identity) return null;
    return (identity.metadata as Record<string, unknown> | null) ?? {};
  },

  async mergeMetadata(did, incoming) {
    // Atomic merge preserves server-owned state even across concurrent transfers.
    const [updated] = await executor
      .update(identities)
      .set({ metadata: sql`coalesce(${identities.metadata}, '{}'::jsonb) || ${JSON.stringify(incoming)}::jsonb`, updatedAt: new Date() })
      .where(eq(identities.id, did))
      .returning({ metadata: identities.metadata });
    return (updated?.metadata as Record<string, unknown> | null) ?? incoming;
  },

  mintDid() {
    return `did:imajin:${nanoid(44)}`;
  },
});

