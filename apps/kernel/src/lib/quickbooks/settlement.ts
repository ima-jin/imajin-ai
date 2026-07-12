/**
 * #1210 settlement — phase 1: build the `.fair` manifest at invoice creation.
 *
 * When AgriFortress creates the QB invoice the sale is defined, so we build the
 * revenue-split manifest now and persist it on the lot (projection). Phase 2
 * (settlement, on paid) executes this manifest via `order.completed` — it does
 * not rebuild it.
 */
import { buildFairManifest } from '@imajin/fair';
import { publish } from '@imajin/bus';
import { eq } from 'drizzle-orm';
import { db, supplyLots } from '@/src/db';
import { readInvoices } from './connector';

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
export async function attachFairManifestToLot(
  correlationId: string,
  manifest: SupplyFairManifest,
  buyerDid?: string,
): Promise<void> {
  await db
    .update(supplyLots)
    .set({ fairManifest: manifest, ...(buyerDid ? { buyerDid } : {}) })
    .where(eq(supplyLots.correlationId, correlationId));
}

interface LotSettlementRow {
  status: string;
  fairManifest: unknown;
  buyerDid: string | null;
}

async function loadLot(correlationId: string): Promise<LotSettlementRow | null> {
  const rows = await db
    .select({ status: supplyLots.status, fairManifest: supplyLots.fairManifest, buyerDid: supplyLots.buyerDid })
    .from(supplyLots)
    .where(eq(supplyLots.correlationId, correlationId))
    .limit(1);
  return (rows[0] as LotSettlementRow | undefined) ?? null;
}

async function markLotSettled(correlationId: string): Promise<void> {
  await db
    .update(supplyLots)
    .set({ status: 'settled', updatedAt: new Date() })
    .where(eq(supplyLots.correlationId, correlationId));
}

export interface SettlementResult {
  /** Invoice ids settled on this run. */
  settled: string[];
  /** Invoice ids skipped (unpaid, no matching lot, or already settled). */
  skipped: string[];
}

/**
 * Process a supplier's paid invoices: for each PAID invoice (Balance == 0)
 * stamped with a lot correlationId whose lot carries a .fair manifest and is not
 * already settled, publish `order.completed` carrying that manifest so the settle
 * reactor executes it, then flip the lot to `settled`. Idempotent per lot.
 */
export async function settlePaidInvoices(ownerDid: string): Promise<SettlementResult> {
  const invoices = await readInvoices(ownerDid);
  const settled: string[] = [];
  const skipped: string[] = [];

  for (const invoice of invoices) {
    if (invoice.balance !== 0 || !invoice.correlationId) {
      skipped.push(invoice.id);
      continue;
    }

    const lot = await loadLot(invoice.correlationId);
    if (!lot || !lot.fairManifest || lot.status === 'settled') {
      skipped.push(invoice.id);
      continue;
    }

    await publish('order.completed', {
      issuer: ownerDid,
      subject: ownerDid,
      scope: 'supply',
      payload: {
        orderId: invoice.id,
        eventId: invoice.correlationId,
        eventDid: invoice.correlationId,
        buyerDid: lot.buyerDid ?? ownerDid,
        amount: Math.round(invoice.totalAmount * 100),
        currency: invoice.currency ?? 'CAD',
        fairManifest: lot.fairManifest as Record<string, unknown>,
        funded: true,
        funded_provider: 'quickbooks',
        metadata: { source: 'quickbooks', invoiceId: invoice.id },
      },
      correlationId: invoice.correlationId,
    });

    await markLotSettled(invoice.correlationId);
    settled.push(invoice.id);
  }

  return { settled, skipped };
}
