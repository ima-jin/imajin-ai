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

const log = createLogger('market');

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL!;
const PAY_SERVICE_API_KEY = process.env.PAY_SERVICE_API_KEY!;

const SELLER_ROLES = new Set(['seller', 'creator', 'event']);

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

  const totalDollars = amount / 100;

  // Resolve node DID from environment
  const NODE_DID = process.env.NODE_DID || process.env.RELAY_IMAJIN_DID || null;
  if (!NODE_DID) {
    log.warn({ listingId }, '[settle] NODE_DID not set — node fee recipient unresolved');
  }

  // Calculate estimated processing fee to deduct from seller's share
  const fees = fairManifest?.fees || [];
  const processorFee = fees.find(f => f.role === 'processor');
  const estimatedFeeDollars = processorFee
    ? parseFloat(((amount * processorFee.rateBps / 10000 + processorFee.fixedCents) / 100).toFixed(2))
    : parseFloat(((amount * 370 / 10000 + 30) / 100).toFixed(2));  // fallback: 3.7% + 30¢

  // Replace placeholder DIDs and deduct processing fee from seller
  const resolvedChain = chain.map((entry) => {
    let did = entry.did;
    if (did === 'BUYER_PLACEHOLDER') did = buyerDid;
    if (did === 'NODE_PLACEHOLDER') did = NODE_DID || 'did:imajin:node-unresolved';

    let entryAmount = parseFloat((totalDollars * entry.share).toFixed(2));

    // Seller's actual payout = (total × sellerShare) - processingFee
    // Because Stripe deducts applicationFee (which includes processing) from connected account transfer
    if (SELLER_ROLES.has(entry.role)) {
      entryAmount = parseFloat((entryAmount - estimatedFeeDollars).toFixed(2));
    }

    return { did, amount: entryAmount, role: entry.role };
  });

  // Chain now sums to totalDollars - estimatedFeeDollars
  const expectedTotal = parseFloat((totalDollars - estimatedFeeDollars).toFixed(2));

  // Fix rounding drift: adjust seller so chain sums to expectedTotal exactly
  const chainSum = resolvedChain.reduce((sum, e) => sum + e.amount, 0);
  const drift = parseFloat((expectedTotal - chainSum).toFixed(2));
  if (drift !== 0 && resolvedChain.length > 0) {
    const seller = resolvedChain.find(e => SELLER_ROLES.has(e.role));
    const target = seller || resolvedChain.reduce((max, e) => e.amount > max.amount ? e : max, resolvedChain[0]);
    target.amount = parseFloat((target.amount + drift).toFixed(2));
  }

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
        amount: parseFloat(((amount * fee.rateBps / 10000 + fee.fixedCents) / 100).toFixed(2)),
        estimated: true,
      }));

      const fairSettlement = {
        version: fairManifest.version || (fairManifest as any).fair || '1.0',
        settledAt: new Date().toISOString(),
        totalAmount: totalDollars,
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
