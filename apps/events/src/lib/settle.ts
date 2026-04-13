/**
 * settleTicketPurchase
 *
 * Calls POST /api/settle on the pay service after a ticket purchase completes.
 * Settlement failure is non-fatal — the ticket has already been created.
 *
 * Uses the event's .fair manifest chain for the 4-way fee split:
 *   protocol (1%) + node (0.5%) + buyer_credit (0.25%) + seller (remainder)
 *
 * If the event has no .fair manifest or no chain, settlement is skipped.
 */

import { createLogger } from '@imajin/logger';
import { db, tickets } from '@/src/db';
import { eq, sql } from 'drizzle-orm';

const log = createLogger('events');

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL!;
const PAY_SERVICE_API_KEY = process.env.PAY_SERVICE_API_KEY!;

interface FairEntry {
  did: string;
  role: string;
  share: number; // 0–1 fraction
}

interface FairManifest {
  version?: string;
  chain?: FairEntry[];
  distributions?: FairEntry[];
  [key: string]: unknown;
}

interface SettleTicketPurchaseParams {
  eventId: string;
  eventDid: string;
  buyerDid: string;
  amount: number;   // cents (from Stripe)
  currency: string;
  fairManifest: FairManifest | null;
  metadata: {
    ticketId: string;
    ticketTypeId: string;
    stripeSessionId: string;
  };
}

export async function settleTicketPurchase(params: SettleTicketPurchaseParams): Promise<void> {
  const { eventId, buyerDid, amount, fairManifest, metadata } = params;

  // v0.3.0+ manifests have a chain with the full fee cascade
  const chain = fairManifest?.chain;
  if (!fairManifest || !chain?.length) {
    log.warn({ eventId }, '[settle] No .fair manifest chain for event — skipping settlement');
    return;
  }

  const totalDollars = amount / 100;

  // Resolve node DID from environment
  // Set NODE_DID or RELAY_IMAJIN_DID in .env.local (value from relay.relay_config.imajin_did)
  const NODE_DID = process.env.NODE_DID || process.env.RELAY_IMAJIN_DID || null;
  if (!NODE_DID) {
    log.warn({ eventId }, '[settle] NODE_DID not set — node fee recipient unresolved');
  }

  // Replace placeholder DIDs in the chain
  const resolvedChain = chain.map((entry) => {
    let did = entry.did;
    if (did === 'BUYER_PLACEHOLDER') did = buyerDid;
    if (did === 'NODE_PLACEHOLDER') did = NODE_DID || 'did:imajin:node-unresolved';
    return {
      did,
      amount: parseFloat((totalDollars * entry.share).toFixed(2)),
      role: entry.role,
    };
  });

  // Fix rounding drift: adjust largest recipient so chain sums to totalDollars exactly
  const chainSum = resolvedChain.reduce((sum, e) => sum + e.amount, 0);
  const drift = parseFloat((totalDollars - chainSum).toFixed(2));
  if (drift !== 0 && resolvedChain.length > 0) {
    const largest = resolvedChain.reduce((max, e) => e.amount > max.amount ? e : max, resolvedChain[0]);
    largest.amount = parseFloat((largest.amount + drift).toFixed(2));
  }

  const body = {
    from_did: buyerDid,
    total_amount: totalDollars,
    service: 'events',
    type: 'ticket_purchase',
    funded: true,
    funded_provider: 'stripe',
    fair_manifest: { chain: resolvedChain },
    metadata: {
      ticketId: metadata.ticketId,
      stripeSessionId: metadata.stripeSessionId,
      eventId,
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
    log.info({ ticketId: metadata.ticketId, result }, '[settle] Settlement complete for ticket');

    // Snapshot the resolved .fair manifest onto the ticket — immutable receipt
    try {
      const fairSettlement = {
        version: fairManifest.version || fairManifest.fair || '1.0',
        settledAt: new Date().toISOString(),
        totalAmount: totalDollars,
        currency: params.currency,
        chain: resolvedChain,
      };
      await db.update(tickets)
        .set({
          metadata: sql`COALESCE(${tickets.metadata}, '{}'::jsonb) || ${JSON.stringify({ fair_settlement: fairSettlement })}::jsonb`,
        })
        .where(eq(tickets.id, metadata.ticketId));
      log.info({ ticketId: metadata.ticketId }, '[settle] .fair settlement snapshot saved to ticket');
    } catch (snapshotError) {
      log.warn({ err: String(snapshotError) }, '[settle] Failed to snapshot .fair to ticket (non-fatal)');
    }
  } catch (error) {
    log.error({ err: String(error) }, '[settle] Settlement request failed (non-fatal)');
  }
}
