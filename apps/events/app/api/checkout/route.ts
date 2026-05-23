/**
 * POST /api/checkout
 *
 * Creates a checkout session via the pay service.
 * Events app doesn't touch Stripe directly — sovereign node model.
 */

import { NextResponse } from 'next/server';
import { withLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { db, events, eventInvites } from '@/src/db';
import { eq } from 'drizzle-orm';
import { rateLimit, getClientIP } from '@/src/lib/rate-limit';
import {
  validateCart,
  resolveCheckoutIdentity,
  validateInviteAccess,
  CheckoutValidationError,
  type CartItem,
} from '@/src/lib/checkout-common';
import { eventUrl } from '@imajin/config';

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL!;
const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL!;

interface CheckoutCartItem {
  ticketTypeId: string;
  quantity: number;
}

interface CheckoutRequest {
  eventId: string;
  // Multi-type cart
  items?: CheckoutCartItem[];
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
    let rawItems: CheckoutCartItem[];
    if (body.items && body.items.length > 0) {
      rawItems = body.items;
    } else if (body.ticketTypeId) {
      rawItems = [{ ticketTypeId: body.ticketTypeId, quantity: body.quantity ?? 1 }];
    } else {
      rawItems = [];
    }

    if (rawItems.length === 0) {
      return NextResponse.json(
        { error: 'items or ticketTypeId is required' },
        { status: 400 }
      );
    }

    const cart: CartItem[] = rawItems.map((item) => ({
      ticketTypeId: item.ticketTypeId,
      quantity: Math.max(1, Math.min(20, Math.floor(item.quantity ?? 1))),
    }));

    // Fetch event + status check up-front so invite check (which needs
    // accessMode) can run before per-type validation.
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, body.eventId))
      .limit(1);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    if (event.status !== 'published') {
      return NextResponse.json({ error: 'Tickets are not available for this event' }, { status: 400 });
    }

    // Invite-only access check
    let inviteRecord: typeof eventInvites.$inferSelect | undefined;
    if (event.accessMode === 'invite_only') {
      const token = body.invite || request.nextUrl.searchParams.get('invite');
      inviteRecord = await validateInviteAccess(body.eventId, token);
    }

    // validateCart: type existence + currency consistency. Max-per-order
    // and availability are checked inline below so error messages keep the
    // type-name prefix the route surfaced before this refactor.
    const eventMeta = (event.metadata || {}) as Record<string, any>;
    const { typesById, totalQuantity, currency: cartCurrency } = await validateCart(
      body.eventId,
      cart,
    );

    for (const item of cart) {
      const tt = typesById.get(item.ticketTypeId)!;
      const maxPerOrder = Math.min(tt.maxPerOrder ?? eventMeta.maxTicketsPerOrder ?? 10, 20);
      if (item.quantity > maxPerOrder) {
        return NextResponse.json(
          { error: `Maximum ${maxPerOrder} ${tt.name} tickets per order` },
          { status: 400 }
        );
      }
      if (tt.quantity !== null) {
        const available = tt.quantity - (tt.sold ?? 0);
        if (available < item.quantity) {
          return NextResponse.json(
            { error: `Only ${available} ${tt.name} ticket${available === 1 ? '' : 's'} available` },
            { status: 409 }
          );
        }
      }
    }

    const identity = await resolveCheckoutIdentity(request, { email: body.email }, log);
    // Stripe only attributes purchases to hard-tier sessions; soft sessions
    // get no buyerDid (Stripe collects email instead).
    const buyerDid = identity.did;
    const customerEmail = identity.email;

    const fairManifest = eventMeta.fair || null;

    const stripeItems = cart.map((c) => {
      const tt = typesById.get(c.ticketTypeId)!;
      return {
        name: `${event.title} — ${tt.name}`,
        description: tt.description || undefined,
        amount: tt.price,
        quantity: c.quantity,
      };
    });

    const payResponse = await fetch(`${PAY_SERVICE_URL}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
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
      }),
    });

    if (!payResponse.ok) {
      const error = await payResponse.json();
      log.error({ err: String(error) }, 'Pay service error');
      return NextResponse.json(
        { error: error.error || 'Payment service error' },
        { status: 500 }
      );
    }

    const checkout = await payResponse.json();

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
