/**
 * settleListingPurchase
 *
 * Calls POST /api/settle on the pay service after a listing purchase completes.
 * Settlement failure is non-fatal — the listing has already been updated.
 *
 * Uses the listing's .fair manifest chain for the fee split:
 *   protocol + node + buyer_credit + seller (remainder)
 *
 * Processing fees are deducted from the seller's share — they receive
 * (total - applicationFee) from Stripe, so the chain must reflect that.
 *
 * If the listing has no .fair manifest or no chain, settlement is skipped.
 */

import { createLogger } from '@imajin/logger';
import { db, listings } from '@/db';
import { eq } from 'drizzle-orm';
import { computeFeeCents, resolveSettlementChain } from '@imajin/fair';

const log = createLogger('market');

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL!;
const PAY_SERVICE_API_KEY = process.env.PAY_SERVICE_API_KEY!;

interface FairEntry {
  did: string;
  role: string;
  share: number; // 0–1 fraction
}

interface FairFee {
  role: string;
  name: string;
  rateBps: number;
  fixedCents: number;
}

interface FairManifest {
  version?: string;
  fees?: FairFee[];
  chain?: FairEntry[];
  distributions?: FairEntry[];
  [key: string]: unknown;
}

interface SettleListingPurchaseParams {
  listingId: string;
  sellerDid: string;
  buyerDid: string;
  amount: number;   // cents (from Stripe)
  currency: string;
  fairManifest: FairManifest | null;
}

export async function settleListingPurchase(params: SettleListingPurchaseParams): Promise<void> {
  const { listingId, buyerDid, amount, fairManifest } = params;

  // v0.3.0+ manifests have a chain with the full fee cascade
  const chain = fairManifest?.chain;
  if (!fairManifest || !chain?.length) {
    log.warn({ listingId }, '[settle] No .fair manifest chain for listing — skipping settlement');
    return;
  }

  // Resolve node DID from environment
  const NODE_DID = process.env.NODE_DID || process.env.RELAY_IMAJIN_DID || null;
  if (!NODE_DID) {
    log.warn({ listingId }, '[settle] NODE_DID not set — node fee recipient unresolved');
  }

  const { resolvedChain, expectedTotal } = resolveSettlementChain({
    amountCents: amount,
    chain,
    fees: fairManifest.fees,
    buyerDid,
    nodeDid: NODE_DID,
  });

  const body = {
    from_did: buyerDid,
    total_amount: expectedTotal,
    service: 'market',
    type: 'listing_purchase',
    funded: true,
    funded_provider: 'stripe',
    fair_manifest: { chain: resolvedChain },
    metadata: {
      listingId,
    },
  };

  try {
    const response = await fetch(`${PAY_SERVICE_URL}/api/settle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PAY_SERVICE_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      log.error({ status: response.status, text }, '[settle] pay /api/settle returned error');
      return;
    }

    const result = await response.json();
    log.info({ listingId, result }, '[settle] Settlement complete for listing');

    // Snapshot the resolved .fair receipt onto the listing metadata
    try {
      const resolvedFees = (fairManifest.fees || []).map((fee) => ({
        role: fee.role,
        name: fee.name,
        rateBps: fee.rateBps,
        fixedCents: fee.fixedCents,
        amount: Number.parseFloat((computeFeeCents(amount, fee.rateBps, fee.fixedCents) / 100).toFixed(2)),
        estimated: true,
      }));

      const fairSettlement = {
        version: fairManifest.version || (fairManifest as any).fair || '1.0',
        settledAt: new Date().toISOString(),
        totalAmount: amount / 100,
        netAmount: expectedTotal,
        currency: params.currency,
        fees: resolvedFees,
        chain: resolvedChain,
      };

      // Store on metadata.fairSettlement since listings don't have an orders table
      const [current] = await db.select().from(listings).where(eq(listings.id, listingId)).limit(1);
      const existingMetadata = (current?.metadata as Record<string, unknown>) || {};

      await db.update(listings)
        .set({ metadata: { ...existingMetadata, fairSettlement } })
        .where(eq(listings.id, listingId));

      log.info({ listingId }, '[settle] .fair settlement snapshot saved to listing metadata');
    } catch (snapshotError) {
      log.warn({ err: String(snapshotError) }, '[settle] Failed to snapshot .fair to listing (non-fatal)');
    }
  } catch (error) {
    log.error({ err: String(error) }, '[settle] Settlement request failed (non-fatal)');
  }
}
