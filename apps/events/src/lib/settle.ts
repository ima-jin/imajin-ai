/**
 * settleTicketPurchase
 *
 * Calls POST /api/settle on the pay service after a ticket purchase completes.
 * Settlement failure is non-fatal — the ticket has already been created.
 */

import { createLogger } from '@imajin/logger';

const log = createLogger('events');

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL!;
const PAY_SERVICE_API_KEY = process.env.PAY_SERVICE_API_KEY!;
const PLATFORM_DID = process.env.PLATFORM_DID || 'did:imajin:platform';
const PLATFORM_FEE_PERCENT = parseFloat(process.env.PLATFORM_FEE_PERCENT || '3');

interface FairAttribution {
  did: string;
  role: string;
  share: number; // 0–1 fraction
}

interface FairManifest {
  attribution?: FairAttribution[];
  distributions?: FairAttribution[];
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

  // Support both field names: "distributions" (current .fair format) and "attribution" (legacy)
  const recipients = fairManifest?.distributions || fairManifest?.attribution;
  if (!fairManifest || !recipients?.length) {
    log.warn({ eventId }, '[settle] No .fair manifest for event — skipping settlement');
    return;
  }

  const totalDollars = amount / 100;
  const platformAmount = parseFloat((totalDollars * (PLATFORM_FEE_PERCENT / 100)).toFixed(2));
  const remainingDollars = parseFloat((totalDollars - platformAmount).toFixed(2));

  // Build chain: attribution shares apply to the remaining (non-platform) portion
  // Use rounding with remainder correction to avoid penny drift
  const attributionChain = recipients.map((entry) => ({
    did: entry.did,
    amount: parseFloat((remainingDollars * entry.share).toFixed(2)),
    role: entry.role,
  }));

  // Fix rounding drift: adjust largest recipient so chain sums to totalDollars exactly
  const attributionSum = attributionChain.reduce((sum, e) => sum + e.amount, 0);
  const drift = parseFloat((remainingDollars - attributionSum).toFixed(2));
  if (drift !== 0 && attributionChain.length > 0) {
    // Give the remainder to the largest recipient
    const largest = attributionChain.reduce((max, e) => e.amount > max.amount ? e : max, attributionChain[0]);
    largest.amount = parseFloat((largest.amount + drift).toFixed(2));
  }

  const chain = [
    ...attributionChain,
    { did: PLATFORM_DID, amount: platformAmount, role: 'platform' },
  ];

  const body = {
    from_did: buyerDid,
    total_amount: totalDollars,
    service: 'events',
    type: 'ticket_purchase',
    funded: true,
    funded_provider: 'stripe',
    fair_manifest: { chain },
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
  } catch (error) {
    log.error({ err: String(error) }, '[settle] Settlement request failed (non-fatal)');
  }
}
