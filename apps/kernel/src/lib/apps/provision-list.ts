/**
 * Read model for /jin's "Provision app" panel (#2745): every `succeeded`
 * `kernel.app_provisions` row, each flagged with whether its app has already
 * redeemed a claim code. The panel offers "Reissue claim code" only for
 * unclaimed apps (Ryan's 2026-10-09 ruling on #2745, option a), so this
 * survives an approved provision and a page reload — the panel no longer
 * depends on in-memory tracking of the proposal it just raised.
 *
 * Read-only; never touches secret material (the ledger holds none, and the
 * claims table stores only hashes — only the `status` column is read here).
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, appProvisions, appSigningKeyClaims } from '@/src/db';

export interface SucceededAppProvision {
  slug: string;
  appDid: string | null;
  repoUrl: string | null;
  /** True once any claim code for this app has been redeemed — its keystore is bound, so reissue is not offered. */
  claimed: boolean;
  updatedAt: Date;
}

/** The subset of `appDids` that have at least one redeemed (`claimed`) signing-key claim. */
async function findClaimedAppDids(appDids: string[]): Promise<Set<string>> {
  if (appDids.length === 0) return new Set();
  const rows = await db
    .select({ appDid: appSigningKeyClaims.appDid })
    .from(appSigningKeyClaims)
    .where(and(inArray(appSigningKeyClaims.appDid, appDids), eq(appSigningKeyClaims.status, 'claimed')));
  return new Set(rows.map((row) => row.appDid));
}

/** Every succeeded provision, ordered by slug, with its claimed state. */
export async function listSucceededAppProvisions(): Promise<SucceededAppProvision[]> {
  const rows = await db
    .select()
    .from(appProvisions)
    .where(eq(appProvisions.status, 'succeeded'))
    .orderBy(asc(appProvisions.slug));

  const appDids = rows.flatMap((row) => (row.appDid ? [row.appDid] : []));
  const claimed = await findClaimedAppDids(appDids);

  return rows.map((row) => ({
    slug: row.slug,
    appDid: row.appDid,
    repoUrl: row.repoUrl,
    claimed: row.appDid !== null && claimed.has(row.appDid),
    updatedAt: row.updatedAt,
  }));
}
