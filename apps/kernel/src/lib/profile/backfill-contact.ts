import { and, eq, isNull } from 'drizzle-orm';
import { db, identities, profiles } from '@/src/db';

/** Independent NULL guards; a retry never replaces either stored address. */
export async function backfillContact(did: string, email: string) {
  return db.transaction(async (tx) => {
    const [updated] = await tx.update(identities)
      .set({ contactEmail: email })
      .where(and(eq(identities.id, did), isNull(identities.contactEmail)))
      .returning({ contactEmail: identities.contactEmail });
    const identity = updated ?? (await tx.select({ contactEmail: identities.contactEmail })
      .from(identities).where(eq(identities.id, did)).limit(1))[0];
    if (!identity) return null;
    const profileRows = await tx.update(profiles)
      .set({ contactEmail: identity.contactEmail ?? email })
      .where(and(eq(profiles.did, did), isNull(profiles.contactEmail)))
      .returning({ did: profiles.did });
    return {
      did,
      contactEmail: identity.contactEmail,
      backfilled: Boolean(updated) || profileRows.length > 0,
    };
  });
}
