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
import * as bus from '@imajin/bus';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq } from 'drizzle-orm';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET!;

interface WebhookBody {
  type?: string;
  status?: string;
  secret?: string;
  metadata?: {
    listingId?: string;
    buyerDid?: string;
    amount?: number;
    currency?: string;
  };
}

function isWebhookAuthorized(headerSecret: string | null, bodySecret: unknown): boolean {
  return headerSecret === WEBHOOK_SECRET || bodySecret === WEBHOOK_SECRET;
}

function isPaymentSuccess(body: WebhookBody): boolean {
  return body.type === 'payment.succeeded' || body.status === 'paid' || body.status === 'succeeded';
}

async function applyListingPurchase(listingId: string, listing: typeof listings.$inferSelect): Promise<void> {
  if (listing.quantity === null || listing.quantity <= 1) {
    // Single item or unlimited — mark sold
    await db
      .update(listings)
      .set({ status: 'sold', updatedAt: new Date() })
      .where(eq(listings.id, listingId));
    return;
  }

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

function publishListingPurchased(body: WebhookBody, listing: typeof listings.$inferSelect, listingId: string): void {
  // Publish listing.purchased → attestation + settle + notify reactors
  bus.publish('listing.purchased', {
    issuer: body.metadata?.buyerDid || '',
    subject: listing.sellerDid,
    scope: 'market',
    payload: {
      context_id: listingId,
      context_type: 'market',
      amount: body.metadata?.amount || 0,
      currency: body.metadata?.currency || 'CAD',
      fairManifest: (listing.fairManifest as any) || null,
      funded: true,
      funded_provider: 'stripe',
      buyerDid: body.metadata?.buyerDid || '',
      metadata: { listingId },
      interestDids: [body.metadata?.buyerDid, listing.sellerDid].filter((did): did is string => Boolean(did)),
    },
  }).catch((err: unknown) => log.error({ err: String(err) }, 'Bus publish error'));
}

async function processSuccessfulPayment(body: WebhookBody): Promise<void> {
  const listingId = body.metadata?.listingId;
  if (!listingId) return;

  const [listing] = await db
    .select()
    .from(listings)
    .where(eq(listings.id, listingId))
    .limit(1);
  if (!listing) return;

  await applyListingPurchase(listingId, listing);
  publishListingPurchased(body, listing, listingId);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Verify webhook secret from header or body
    const headerSecret = request.headers.get('x-webhook-secret');
    if (!isWebhookAuthorized(headerSecret, body?.secret)) {
      return errorResponse('Unauthorized', 401);
    }

    if (isPaymentSuccess(body)) {
      await processSuccessfulPayment(body);
    }

    return jsonResponse({ received: true });
  } catch (error) {
    log.error({ err: String(error) }, 'Webhook error');
    return errorResponse('Webhook processing failed', 500);
  }
}
