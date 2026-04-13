/**
 * POST /api/listings/:id/purchase
 *
 * Initiates a checkout session via the pay service.
 * Market app does not touch Stripe directly — sovereign node model.
 */

import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { createEmitter } from '@imajin/emit';
const log = createLogger('market');
const marketEvents = createEmitter('market');
import { db, listings } from '@/db';
import { getSession, requireHardDID } from '@imajin/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq } from 'drizzle-orm';

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL!;
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL!;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
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
      buyerDid = authResult.identity.id;
    } else {
      const session = await getSession(request);
      buyerDid = session?.identity?.id;
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
    const fairManifest = (listing.fairManifest as object | null) || {
      version: '1.0',
      type: 'market:purchase',
      distributions: [
        { did: listing.sellerDid, share: 0.99, role: 'seller' },
        { did: 'did:imajin:platform', share: 0.01, role: 'platform' },
      ],
    };

    // 5. POST to pay service
    const payResponse = await fetch(`${PAY_SERVICE_URL}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

    marketEvents.emit({ action: 'listing.purchase', did: buyerDid, payload: { listingId: listing.id, sellerDid: listing.sellerDid, quantity } });

    return jsonResponse({ url: checkout.url, sessionId: checkout.id });

  } catch (error) {
    log.error({ err: String(error) }, 'Purchase error');
    return errorResponse('Purchase failed', 500);
  }
}
