/**
 * Settle reactor — makes HTTP POST to PAY_SERVICE_URL/api/settle.
 *
 * Implements fair chain resolution shared by both ticket and listing purchases.
 * Settlement failure is non-fatal — domain records have already been written.
 */

import { createLogger } from '@imajin/logger';
import type { FairManifest, FairEntry, OrderCompletedPayload, ListingPurchasedPayload } from '../types';

const log = createLogger('bus');

const SELLER_ROLES = new Set(['seller', 'creator', 'event']);

interface ResolvedEntry {
  did: string;
  amount: number;
  role: string;
}

interface ResolvedChain {
  chain: ResolvedEntry[];
  expectedTotal: number;
}

function resolveChain(
  entries: FairEntry[],
  fees: FairManifest['fees'],
  buyerDid: string,
  amountCents: number,
): ResolvedChain {
  const totalDollars = amountCents / 100;

  const nodeDid =
    process.env.NODE_DID || process.env.RELAY_IMAJIN_DID || 'did:imajin:node-unresolved';

  const feeList = fees || [];
  const processorFee = feeList.find((f) => f.role === 'processor');
  const estimatedFeeDollars = processorFee
    ? parseFloat(
        ((amountCents * processorFee.rateBps) / 10000 / 100 + processorFee.fixedCents / 100).toFixed(2),
      )
    : parseFloat(((amountCents * 370) / 10000 / 100 + 0.3).toFixed(2)); // fallback: 3.7% + 30¢

  const resolvedChain: ResolvedEntry[] = entries.map((entry) => {
    let did = entry.did;
    if (did === 'BUYER_PLACEHOLDER') did = buyerDid;
    if (did === 'NODE_PLACEHOLDER') did = nodeDid;

    let entryAmount = parseFloat((totalDollars * entry.share).toFixed(2));
    if (SELLER_ROLES.has(entry.role)) {
      entryAmount = parseFloat((entryAmount - estimatedFeeDollars).toFixed(2));
    }

    return { did, amount: entryAmount, role: entry.role };
  });

  const expectedTotal = parseFloat((totalDollars - estimatedFeeDollars).toFixed(2));

  // Fix rounding drift on the seller entry
  const chainSum = resolvedChain.reduce((sum, e) => sum + e.amount, 0);
  const drift = parseFloat((expectedTotal - chainSum).toFixed(2));
  if (drift !== 0 && resolvedChain.length > 0) {
    const seller = resolvedChain.find((e) => SELLER_ROLES.has(e.role));
    const target =
      seller ||
      resolvedChain.reduce((max, e) => (e.amount > max.amount ? e : max), resolvedChain[0]);
    target.amount = parseFloat((target.amount + drift).toFixed(2));
  }

  return { chain: resolvedChain, expectedTotal };
}

async function postSettle(body: Record<string, unknown>, contextId: string): Promise<void> {
  const payUrl = process.env.PAY_SERVICE_URL;
  const payKey = process.env.PAY_SERVICE_API_KEY;

  if (!payUrl || !payKey) {
    log.warn({ contextId }, '[bus/settle] PAY_SERVICE_URL or PAY_SERVICE_API_KEY not set — skipping');
    return;
  }

  const response = await fetch(`${payUrl}/api/settle`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${payKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    log.error({ status: response.status, text, contextId }, '[bus/settle] /api/settle returned error');
    return;
  }

  const result = await response.json();
  log.info({ contextId, result }, '[bus/settle] Settlement complete');
}

export async function onOrderCompleted(payload: OrderCompletedPayload): Promise<void> {
  const { ownerDid, orderId, eventId, fairManifest, amount, currency, metadata } = payload;

  const chain = fairManifest?.chain;
  if (!fairManifest || !chain?.length) {
    log.warn({ eventId }, '[bus/settle] No .fair manifest chain for event — skipping settlement');
    return;
  }

  const { chain: resolvedChain, expectedTotal } = resolveChain(
    chain,
    fairManifest.fees,
    ownerDid,
    amount,
  );

  const body = {
    from_did: ownerDid,
    total_amount: expectedTotal,
    service: 'events',
    type: 'ticket_purchase',
    funded: true,
    funded_provider: 'stripe',
    fair_manifest: { chain: resolvedChain },
    metadata: {
      orderId,
      ticketIds: metadata.ticketIds,
      stripeSessionId: metadata.stripeSessionId,
      eventId,
    },
  };

  await postSettle(body, orderId).catch((err) =>
    log.error({ err: String(err) }, '[bus/settle] order.completed settlement error (non-fatal)'),
  );
}

export async function onListingPurchased(payload: ListingPurchasedPayload): Promise<void> {
  const { buyerDid, listingId, fairManifest, amount, currency } = payload;

  const chain = fairManifest?.chain;
  if (!fairManifest || !chain?.length) {
    log.warn({ listingId }, '[bus/settle] No .fair manifest chain for listing — skipping settlement');
    return;
  }

  const { chain: resolvedChain, expectedTotal } = resolveChain(
    chain,
    fairManifest.fees,
    buyerDid,
    amount,
  );

  const body = {
    from_did: buyerDid,
    total_amount: expectedTotal,
    service: 'market',
    type: 'listing_purchase',
    funded: true,
    funded_provider: 'stripe',
    fair_manifest: { chain: resolvedChain },
    metadata: { listingId },
  };

  await postSettle(body, listingId).catch((err) =>
    log.error({ err: String(err) }, '[bus/settle] listing.purchased settlement error (non-fatal)'),
  );
}
