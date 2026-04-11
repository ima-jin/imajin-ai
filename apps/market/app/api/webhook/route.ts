/**
 * POST /api/webhook
 *
 * Called by the pay service after a successful payment.
 * Updates listing status/quantity accordingly.
 */

import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
const log = createLogger('market');
import { db, listings } from '@/db';
import { emitAttestation } from '@imajin/auth';
import { notify } from '@imajin/notify';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq } from 'drizzle-orm';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET!;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Verify webhook secret from header or body
    const headerSecret = request.headers.get('x-webhook-secret');
    const bodySecret = body?.secret;

    if (headerSecret !== WEBHOOK_SECRET && bodySecret !== WEBHOOK_SECRET) {
      return errorResponse('Unauthorized', 401);
    }

    // Handle successful payment
    const isSuccess =
      body.type === 'payment.succeeded' ||
      body.status === 'paid' ||
      body.status === 'succeeded';

    if (isSuccess) {
      const listingId = body.metadata?.listingId;

      if (listingId) {
        const [listing] = await db
          .select()
          .from(listings)
          .where(eq(listings.id, listingId))
          .limit(1);

        if (listing) {
          if (listing.quantity === null || listing.quantity <= 1) {
            // Single item or unlimited — mark sold
            await db
              .update(listings)
              .set({ status: 'sold', updatedAt: new Date() })
              .where(eq(listings.id, listingId));
          } else {
            // Multi-quantity — decrement and mark sold if depleted
            const newQuantity = listing.quantity - 1;
            await db
              .update(listings)
              .set({
                quantity: newQuantity,
                status: newQuantity === 0 ? 'sold' : listing.status,
                updatedAt: new Date(),
              })
              .where(eq(listings.id, listingId));
          }
        }

        // Fire and forget — never block the response
        emitAttestation({
          issuer_did: body.metadata?.buyerDid,
          subject_did: listing.sellerDid,
          type: 'listing.purchased',
          context_id: listingId,
          context_type: 'market',
          payload: { amount: body.metadata?.amount },
        }).catch((err: unknown) => log.error({ err: String(err) }, 'Attestation emit error'));

        // Record interest signals — listing.purchased → market scope (buyer + seller)
        if (body.metadata?.buyerDid) {
          notify.interest({ did: body.metadata.buyerDid, attestationType: 'listing.purchased' })
            .catch((err: unknown) => log.error({ err: String(err) }, 'Interest signal error'));
        }
        if (listing.sellerDid) {
          notify.interest({ did: listing.sellerDid, attestationType: 'listing.purchased' })
            .catch((err: unknown) => log.error({ err: String(err) }, 'Interest signal error'));
        }
      }
    }

    return jsonResponse({ received: true });

  } catch (error) {
    log.error({ err: String(error) }, 'Webhook error');
    return errorResponse('Webhook processing failed', 500);
  }
}
