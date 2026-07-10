/**
 * #1210 settlement — phase 1: build the `.fair` manifest at invoice creation.
 *
 * When AgriFortress creates the QB invoice the sale is defined, so we build the
 * revenue-split manifest now and persist it on the lot (projection). Phase 2
 * (settlement, on paid) executes this manifest via `order.completed` — it does
 * not rebuild it.
 */
import { buildFairManifest } from '@imajin/fair';
import { eq } from 'drizzle-orm';
import { db, supplyLots } from '@/src/db';

export type SupplyFairManifest = ReturnType<typeof buildFairManifest>;

/** Build the revenue-split manifest for a supply sale (seller = the supplier DID). */
export function buildSaleFairManifest(sellerDid: string, correlationId: string): SupplyFairManifest {
  return buildFairManifest({
    creatorDid: sellerDid,
    contentDid: correlationId,
    contentType: 'supply',
  });
}

/**
 * Persist the `.fair` manifest onto the lot so settlement can execute it on
 * payment. No-op if the lot row does not exist yet.
 */
export async function attachFairManifestToLot(correlationId: string, manifest: SupplyFairManifest): Promise<void> {
  await db
    .update(supplyLots)
    .set({ fairManifest: manifest })
    .where(eq(supplyLots.correlationId, correlationId));
}
