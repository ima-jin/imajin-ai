/**
 * POST /api/listings/:id/purchase
 *
 * Initiates a checkout session via the pay service.
 * Market app does not touch Stripe directly — sovereign node model.
 */

import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
const log = createLogger('market');
import { db, listings } from '@/db';
import { getSession, requireHardDID , resolveActingDid } from '@imajin/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { publish } from '@imajin/bus';
import { eq } from 'drizzle-orm';
import { getAppServiceToken } from '@/lib/app-token';
import { buildPayeeChain, type FairManifest } from '@/lib/settle';
import { recordPendingCheckout, type PayeeChainEntry } from '@/lib/pending-checkout';

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL!;
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL!;

/**
 * Remember which kernel payment (`transactionId`) this Stripe session is, so the purchase
 * webhook can settle it. Non-fatal: the buyer's checkout has already been created.
 */
async function rememberCheckout(
  listingId: string,
  checkout: { id?: string; transactionId?: string },
  amountCents: number,
  chain: PayeeChainEntry[],
): Promise<void> {
  if (!checkout.id || !checkout.transactionId) {
    log.error({ listingId }, 'Pay checkout response had no session id / transactionId — purchase will not settle');
    return;
  }
  try {
    await recordPendingCheckout(listingId, checkout.id, { transactionId: checkout.transactionId, amountCents, chain });
  } catch (err) {
    log.error({ err: String(err), listingId }, 'Failed to record pending checkout — purchase will not settle');
  }
}

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    // 1. Fetch listing
    const [listing] = await db
      .select()
      .from(listings)
      .where(eq(listings.id, params.id))
      .limit(1);

    if (!listing) {
      return errorResponse('Listing not found', 404);
    }

    if (listing.status !== 'active') {
      return errorResponse('This listing is not available', 400);
    }

    if (listing.sellerTier === 'public_offplatform') {
      return errorResponse('This listing requires direct contact with the seller', 400);
    }

    // 2. Get buyer identity — trust_gated requires hard DID (preliminary+)
    let buyerDid: string | undefined;
    if (listing.sellerTier === 'trust_gated') {
      const authResult = await requireHardDID(request);
      if ('error' in authResult) {
        return errorResponse('This listing requires a verified identity to purchase', 403);
      }
      buyerDid = resolveActingDid(authResult.identity);
    } else {
      const session = await getSession();
      buyerDid = session ? resolveActingDid(session) : undefined;
    }

    // 3. Parse body for quantity
    let quantity = 1;
    try {
      const body = await request.json();
      if (body?.quantity && typeof body.quantity === 'number' && body.quantity > 0) {
        quantity = body.quantity;
      }
    } catch {
      // body is optional — default to quantity 1
    }

    // 4. Build .fair manifest (use listing's manifest if present)
    const fairManifest = (listing.fairManifest as object | null) ?? {
      version: '1.0',
      type: 'market:purchase',
      distributions: [
        { did: listing.sellerDid, share: 0.99, role: 'seller' },
        { did: 'did:imajin:platform', share: 0.01, role: 'platform' },
      ],
    };

    // 5. Declare the payees (#2740): a listing with a .fair chain checks out with market's
    // own app-service token, which binds the payment to market's app DID so it can settle
    // later. The chain is fixed here and re-posted verbatim at settle time.
    const amountCents = listing.price * quantity;
    const payeeChain = buildPayeeChain({
      amountCents,
      fairManifest: fairManifest as FairManifest,
      buyerDid,
    });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (payeeChain) {
      try {
        headers.Authorization = `Bearer ${await getAppServiceToken()}`;
      } catch (err) {
        // Without the token the payment could never settle — refuse rather than take money unsettleable.
        log.error({ err: String(err) }, 'Market app-service token unavailable');
        return errorResponse('Payment service unavailable', 503);
      }
    }

    // 6. POST to pay service
    const payResponse = await fetch(`${PAY_SERVICE_URL}/api/checkout`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        items: [{
          name: listing.title,
          description: listing.description || undefined,
          amount: listing.price,
          quantity,
        }],
        currency: listing.currency,
        successUrl: `${BASE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}&listing=${listing.id}`,
        cancelUrl: `${BASE_URL}/listings/${listing.id}`,
        fairManifest,
        ...(payeeChain && { payeeManifest: { chain: payeeChain } }),
        metadata: {
          service: 'market',
          listingId: listing.id,
          listingTitle: listing.title,
          sellerDid: listing.sellerDid,
          ...(buyerDid && { buyerDid }),
        },
      }),
    });

    if (!payResponse.ok) {
      const err = await payResponse.json();
      log.error({ err }, 'Pay service error');
      return errorResponse(err.error || 'Payment service error', 500);
    }

    const checkout = await payResponse.json();

    if (payeeChain) {
      await rememberCheckout(listing.id, checkout, amountCents, payeeChain);
    }

    publish('listing.purchase', {
      issuer: listing.sellerDid,
      subject: buyerDid || listing.sellerDid,
      scope: 'market',
      payload: { listingId: listing.id, sellerDid: listing.sellerDid, quantity },
    }).catch(() => {});

    return jsonResponse({ url: checkout.url, sessionId: checkout.id });

  } catch (error) {
    log.error({ err: String(error) }, 'Purchase error');
    return errorResponse('Purchase failed', 500);
  }
}
