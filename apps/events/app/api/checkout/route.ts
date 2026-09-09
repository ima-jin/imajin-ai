/**
 * POST /api/checkout
 *
 * Creates a checkout session via the pay service.
 * Events app doesn't touch Stripe directly â€” sovereign node model.
 */

import { NextResponse } from 'next/server';
import { withLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { eventInvites, db } from '@/src/db';
import { eq } from 'drizzle-orm';
import { rateLimit, getClientIP, eventUrl } from '@imajin/config';
import {
  validateCart,
  resolveCheckoutIdentity,
  resolveInviteAccessForEvent,
  loadPublishedEvent,
  CheckoutValidationError,
} from '@/src/lib/checkout-common';
import {
  normalizeCheckoutCart,
  validateCheckoutCartLimits,
  buildStripeCheckoutItems,
  requestPayCheckoutSession,
} from '@/src/lib/checkout-helpers';

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL!;
const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL!;

interface CheckoutRequest {
  eventId: string;
  // Multi-type cart
  items?: Array<{ ticketTypeId: string; quantity: number }>;
  // Legacy single-type (still accepted)
  ticketTypeId?: string;
  quantity?: number;
  email?: string;
  invite?: string;
}

export const POST = withLogger('events', async (request, { log, correlationId }) => {
  const ip = getClientIP(request);
  const rl = rateLimit(ip, 10, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    );
  }

  try {
    const body: CheckoutRequest = await request.json();

    if (!body.eventId) {
      return NextResponse.json({ error: 'eventId is required' }, { status: 400 });
    }

    // Normalize to cart: accept items[] or legacy ticketTypeId+quantity
    const cartResult = normalizeCheckoutCart(body);
    if (!Array.isArray(cartResult)) {
      return NextResponse.json({ error: cartResult.error }, { status: cartResult.status });
    }
    const cart = cartResult;

    // Fetch event + status check up-front so invite check (which needs
    // accessMode) can run before per-type validation.
    const eventResult = await loadPublishedEvent(body.eventId);
    if ('error' in eventResult) {
      return NextResponse.json({ error: eventResult.error }, { status: eventResult.status });
    }
    const { event } = eventResult;

    // Invite-only access check
    const inviteToken = body.invite || request.nextUrl.searchParams.get('invite');
    const inviteRecord = await resolveInviteAccessForEvent(event, inviteToken);

    // validateCart: type existence + currency consistency. Max-per-order
    // and availability are checked inline below so error messages keep the
    // type-name prefix the route surfaced before this refactor.
    const eventMeta = (event.metadata || {}) as Record<string, any>;
    const { typesById, totalQuantity, currency: cartCurrency } = await validateCart(
      body.eventId,
      cart,
    );

    const cartError = validateCheckoutCartLimits(cart, typesById, eventMeta);
    if (cartError) return cartError;

    const identity = await resolveCheckoutIdentity(request, { email: body.email }, log);
    // Stripe only attributes purchases to hard-tier sessions; soft sessions
    // get no buyerDid (Stripe collects email instead).
    const buyerDid = identity.did;
    const customerEmail = identity.email;

    const fairManifest = eventMeta.fair || null;
    const stripeItems = buildStripeCheckoutItems(cart, typesById, event.title);

    const payResult = await requestPayCheckoutSession({
      payServiceUrl: PAY_SERVICE_URL,
      items: stripeItems,
      currency: cartCurrency,
      customerEmail,
      successUrl: `${EVENTS_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}&event=${event.id}`,
      cancelUrl: eventUrl(EVENTS_URL, event.id),
      fairManifest,
      sellerDid: event.creatorDid,
      metadata: {
        service: 'events',
        eventId: event.id,
        eventDid: event.did,
        cart: JSON.stringify(cart.map((c) => ({ ticketTypeId: c.ticketTypeId, quantity: c.quantity }))),
        totalQuantity: String(totalQuantity),
        ...(buyerDid && { buyerDid }),
      },
      log,
    });

    if ('error' in payResult) {
      return NextResponse.json({ error: payResult.error }, { status: payResult.status });
    }
    const { checkout } = payResult;

    publish('ticket.purchase', {
      issuer: buyerDid || '',
      subject: event.creatorDid,
      scope: 'events',
      payload: {
        eventId: body.eventId,
        cart: cart.map((c) => ({ ticketTypeId: c.ticketTypeId, quantity: c.quantity })),
        totalQuantity,
        sellerDid: event.creatorDid,
      },
      correlationId,
    }).catch((err) => log.error({ err: String(err) }, 'Publish error'));

    if (inviteRecord) {
      await db
        .update(eventInvites)
        .set({ usedCount: inviteRecord.usedCount + 1 })
        .where(eq(eventInvites.id, inviteRecord.id));
    }

    return NextResponse.json({
      url: checkout.url,
      sessionId: checkout.id,
    });

  } catch (error) {
    if (error instanceof CheckoutValidationError) {
      return NextResponse.json(
        { error: error.message, ...(error.field ? { field: error.field } : {}) },
        { status: error.statusCode },
      );
    }
    log.error({ err: String(error) }, 'Checkout error');
    return NextResponse.json(
      { error: 'Checkout failed' },
      { status: 500 }
    );
  }
});