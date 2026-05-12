/**
 * POST /api/checkout
 * 
 * Creates a checkout session via the pay service.
 * Events app doesn't touch Stripe directly — sovereign node model.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { db, events, ticketTypes, eventInvites } from '@/src/db';


import { eq, and, sql } from 'drizzle-orm';
import { optionalAuth } from '@imajin/auth';
import { rateLimit, getClientIP } from '@/src/lib/rate-limit';
import { getClient } from '@imajin/db';
import { getContactEmail } from '@/src/lib/contact-email';

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL!;
const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL!;

interface CartItem {
  ticketTypeId: string;
  quantity: number;
}

interface CheckoutRequest {
  eventId: string;
  // Multi-type cart
  items?: CartItem[];
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
    
    // Validate
    if (!body.eventId) {
      return NextResponse.json(
        { error: 'eventId is required' },
        { status: 400 }
      );
    }

    // Normalize to cart: accept items[] or legacy ticketTypeId+quantity
    const rawItems: CartItem[] = body.items && body.items.length > 0
      ? body.items
      : body.ticketTypeId
      ? [{ ticketTypeId: body.ticketTypeId, quantity: body.quantity ?? 1 }]
      : [];

    if (rawItems.length === 0) {
      return NextResponse.json(
        { error: 'items or ticketTypeId is required' },
        { status: 400 }
      );
    }
    
    // Fetch event and ticket type
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
      if (!token) {
        return NextResponse.json({ error: 'This event requires an invite link' }, { status: 403 });
      }

      const [invite] = await db
        .select()
        .from(eventInvites)
        .where(and(eq(eventInvites.eventId, body.eventId), eq(eventInvites.token, token)))
        .limit(1);

      if (!invite) {
        return NextResponse.json({ error: 'Invalid invite token' }, { status: 403 });
      }

      if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
        return NextResponse.json({ error: 'This invite link has expired' }, { status: 403 });
      }

      if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) {
        return NextResponse.json({ error: 'This invite link has reached its maximum uses' }, { status: 403 });
      }

      inviteRecord = invite;
    }

    // Fetch all ticket types for this event
    const allTypes = await db
      .select()
      .from(ticketTypes)
      .where(eq(ticketTypes.eventId, body.eventId));
    const typesById = new Map(allTypes.map(t => [t.id, t]));

    // Validate and build cart
    const cart: { type: typeof allTypes[0]; quantity: number }[] = [];
    const eventMeta = (event.metadata || {}) as Record<string, any>;

    for (const item of rawItems) {
      const tt = typesById.get(item.ticketTypeId);
      if (!tt) {
        return NextResponse.json(
          { error: `Ticket type ${item.ticketTypeId} not found` },
          { status: 404 }
        );
      }

      const qty = Math.max(1, Math.min(20, Math.floor(item.quantity ?? 1)));

      // Enforce max per order
      const maxPerOrder = Math.min(tt.maxPerOrder ?? eventMeta.maxTicketsPerOrder ?? 10, 20);
      if (qty > maxPerOrder) {
        return NextResponse.json(
          { error: `Maximum ${maxPerOrder} ${tt.name} tickets per order` },
          { status: 400 }
        );
      }

      // Check availability
      if (tt.quantity !== null) {
        const available = tt.quantity - (tt.sold ?? 0);
        if (available < qty) {
          return NextResponse.json(
            { error: `Only ${available} ${tt.name} ticket${available !== 1 ? 's' : ''} available` },
            { status: 409 }
          );
        }
      }

      cart.push({ type: tt, quantity: qty });
    }

    if (cart.length === 0) {
      return NextResponse.json({ error: 'Empty cart' }, { status: 400 });
    }

    // All items must share a currency
    const currencies = new Set(cart.map(c => c.type.currency));
    if (currencies.size > 1) {
      return NextResponse.json(
        { error: 'All tickets must use the same currency' },
        { status: 400 }
      );
    }

    // Check if buyer is logged in (hard DID)
    const session = await optionalAuth(request);
    const buyerDid = (session && session.tier !== 'soft') ? session.id : undefined;

    // Resolve contact email for pre-filling Stripe checkout
    let customerEmail = body.email;
    if (buyerDid && !customerEmail) {
      const resolved = await getContactEmail(buyerDid, log);
      if (resolved) customerEmail = resolved;
    }

    const totalQuantity = cart.reduce((sum, c) => sum + c.quantity, 0);

    // Read .fair attribution from event metadata
    const fairManifest = eventMeta.fair || null;

    // Build Stripe line items from the full cart
    const stripeItems = cart.map(c => ({
      name: `${event.title} — ${c.type.name}`,
      description: c.type.description || undefined,
      amount: c.type.price,
      quantity: c.quantity,
    }));

    // Call pay service to create checkout session
    const payResponse = await fetch(`${PAY_SERVICE_URL}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: stripeItems,
        currency: cart[0].type.currency,
        customerEmail,
        successUrl: `${EVENTS_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}&event=${event.id}`,
        cancelUrl: `${EVENTS_URL}/${event.id}`,
        fairManifest,
        sellerDid: event.creatorDid,
        metadata: {
          service: 'events',
          eventId: event.id,
          eventDid: event.did,
          // Encode full cart in metadata for the webhook to reconstruct
          cart: JSON.stringify(cart.map(c => ({ ticketTypeId: c.type.id, quantity: c.quantity }))),
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
        cart: cart.map(c => ({ ticketTypeId: c.type.id, quantity: c.quantity })),
        totalQuantity,
        sellerDid: event.creatorDid,
      },
      correlationId,
    }).catch((err) => log.error({ err: String(err) }, 'Publish error'));

    // Increment invite used_count on successful checkout session creation
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
    log.error({ err: String(error) }, 'Checkout error');
    return NextResponse.json(
      { error: 'Checkout failed' },
      { status: 500 }
    );
  }
});
