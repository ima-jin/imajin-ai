/**
 * POST /api/checkout
 *
 * Create a hosted Stripe Checkout session.
 * Returns a URL to redirect the customer to.
 *
 * #2757: with a `sellerDid` (or `metadata.sellerDid`) the session is created on
 * THE SELLER'S OWN Stripe account with their sealed restricted key (the #1785 BYO
 * connector, picked by `resolveCardRail`) — there is no Stripe Connect and no
 * platform-held fallback. A seller with no working card rail is a 400
 * `SELLER_NO_CARD_RAIL`. Such a payment settles from the seller's own
 * `payment_intent.succeeded` (`byo-checkout-settlement.ts`): the row is completed
 * and the originating service is told; no platform balance moves. Without a
 * seller the session is a platform-own charge, as before.
 *
 * Request:
 * {
 *   items: [{ name: string, description?: string, amount: number, quantity: number, image?: string }],
 *   currency: "USD" | "CAD" | "EUR" | "GBP",
 *   customerEmail?: string,
 *   sellerDid?: string,
 *   successUrl: string,
 *   cancelUrl: string,
 *   metadata?: Record<string, string>
 * }
 *
 * Response:
 * {
 *   id: string,
 *   url: string,
 *   expiresAt: string
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveActingDid } from '@imajin/auth';
import type { FiatCurrency } from '@/src/lib/pay';
import { db, transactions } from '@/src/db';
import { externalRefColumns, STRIPE_BYO_RAIL } from '@/src/lib/pay/external-ref';
import { generateId } from '@/src/lib/kernel/id';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { rateLimit, getClientIP } from '@imajin/config';
import { withLogger } from '@imajin/logger';
import { startHostedCheckout } from '@/src/lib/pay/hosted-checkout';
import {
  resolveCheckoutIdentity,
  taxLineItems,
  validateCheckoutBody,
  type CheckoutBody as CheckoutBodyBase,
} from '@/src/lib/pay/checkout';

type CheckoutBody = CheckoutBodyBase & { currency: FiatCurrency };

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';

export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 10, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } }
    );
  }

  try {
    const body: CheckoutBody = await request.json();

    const bodyValidation = validateCheckoutBody(body);
    if (!bodyValidation.ok) {
      return NextResponse.json({ error: bodyValidation.error }, { status: bodyValidation.status, headers: cors });
    }

    const identityResult = await resolveCheckoutIdentity(request);
    if (!identityResult.ok) {
      return NextResponse.json({ error: identityResult.error }, { status: identityResult.status, headers: cors });
    }
    const { identity, appDid } = identityResult;

    // #2419: tax is appended as its own manual Stripe line item, derived
    // from the manifest's `taxes[]` — never folded into `body.items` (the
    // merchandise-only subtotal/`basisAmount`). `[]` for a manifest without `taxes[]`.
    const items = [...body.items, ...taxLineItems(body.fairManifest)];
    const sessionMetadata: Record<string, string> = {
      ...body.metadata,
      // Add identity if authenticated
      ...(identity && { identity_id: identity.id }),
    };
    const txId = generateId('tx');

    // #2757: on the seller's own Stripe account (BYO connector) or a platform-own charge — never Connect.
    const started = await startHostedCheckout({ body, items, metadata: sessionMetadata, transactionId: txId });
    if (!started.ok) {
      log.warn({ status: started.status, code: started.code }, 'Checkout not started');
      return NextResponse.json(
        { error: started.error, ...(started.code && { code: started.code }) },
        { status: started.status, headers: cors },
      );
    }
    const { session: result, byoSellerDid } = started;

    // Create a pending transaction — totalAmount is the gross charge
    // (merchandise + tax), matching what Stripe actually collects.
    const totalAmount = items.reduce((sum, item) => sum + (item.amount * item.quantity), 0);

    await db.insert(transactions).values({
      id: txId,
      service: body.metadata?.service || 'unknown',
      type: body.metadata?.type || 'checkout',
      fromDid: identity ? resolveActingDid(identity) : null,
      // A BYO charge's `to_did` IS the seller: settlement only completes it for that owner's own event.
      toDid: byoSellerDid ?? (body.metadata?.to_did || body.metadata?.recipient_did || 'platform'),
      amount: (totalAmount / 100).toString(), // Convert cents to dollars
      currency: body.currency || 'CAD',
      status: 'pending',
      ...externalRefColumns(result.id, byoSellerDid ? STRIPE_BYO_RAIL : undefined),
      metadata: byoSellerDid
        ? { ...sessionMetadata, ...(body.customerEmail && { customer_email: body.customerEmail }), platform_fee_cents: 0 }
        : body.metadata,
      fairManifest: body.fairManifest || null,
      // #2642: an app-service-token checkout binds the payment to the calling app and
      // records the payee manifest it declared; checkout without one leaves all of
      // this NULL, and such rows are never settleable via the app path.
      ...(appDid && { appDid, payeeManifest: body.payeeManifest ?? body.fairManifest ?? null }),
    });

    return NextResponse.json({
      id: result.id,
      url: result.url,
      expiresAt: result.expiresAt.toISOString(),
      transactionId: txId,
    }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Checkout error');
    return NextResponse.json(
      { error: 'Checkout failed' },
      { status: 500, headers: cors }
    );
  }
});
