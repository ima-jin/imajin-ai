import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, identities, identityMembers } from '@/src/db';

export interface AppListing {
  visibility?: string;
  ownerDid?: string;
}

/**
 * Live group membership, not an invite or a copied profile preference. Reading
 * this each time makes joining/leaving effective on the next app-list read.
 * Agent delegation rows on personal identities are not group membership.
 */
export async function resolveAppOwnerDids(did: string): Promise<Set<string>> {
  const memberships = await db.select({ ownerDid: identityMembers.identityDid })
    .from(identityMembers)
    .innerJoin(identities, eq(identities.id, identityMembers.identityDid))
    .where(and(
      eq(identityMembers.memberDid, did),
      isNull(identityMembers.removedAt),
      inArray(identities.scope, ['business', 'community', 'family']),
    ));
  return new Set([did, ...memberships.map((membership) => membership.ownerDid)]);
}

/** Direct-link lookup/addition is broader than discovery, never web access. */
export function canAccessAppListing(app: AppListing, ownerDids: ReadonlySet<string>): boolean {
  const visibility = app.visibility ?? 'public';
  if (visibility === 'public' || visibility === 'unlisted') return true;
  return visibility === 'private' && !!app.ownerDid && ownerDids.has(app.ownerDid);
}

export function canDiscoverApp(app: AppListing, ownerDids: ReadonlySet<string>): boolean {
  return app.visibility !== 'unlisted' && canAccessAppListing(app, ownerDids);
}
