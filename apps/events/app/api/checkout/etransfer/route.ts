/**
 * POST /api/checkout/etransfer
 *
 * Creates an e-Transfer hold on N tickets (default 1) of one or more ticket
 * types. All N tickets are grouped under a single order with one memo
 * (ORD-{orderId}). Returns payment instructions for one combined e-Transfer.
 */

import { NextResponse } from 'next/server';
import { withLogger } from '@imajin/logger';
import { db, events, tickets, orders } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { publish } from '@imajin/bus';
import { getClient } from '@imajin/db';
import {
  validateCart,
  resolveCheckoutIdentity,
  validateInviteAccess,
  createOrderWithTickets,
  CheckoutValidationError,
  type CartItem,
} from '@/src/lib/checkout-common';
import { eventUrl, eventMyTicketsUrl } from '@imajin/config';

const AUTH_URL = process.env.AUTH_SERVICE_URL || process.env.AUTH_URL || 'http://localhost:3001';
const HOLD_HOURS = 72;
const MAX_QUANTITY = 20;

interface ETransferCartItem {
  ticketTypeId: string;
  quantity: number;
}

interface ETransferCheckoutRequest {
  eventId: string;
  // Legacy single-type payload (still accepted)
  ticketTypeId?: string;
  quantity?: number;
  // Multi-type cart payload
  items?: ETransferCartItem[];
  email?: string;
  name?: string;
  invite?: string;
}

export const POST = withLogger('events', async (request, { log }) => {
  try {
    const body: ETransferCheckoutRequest = await request.json();

    if (!body.eventId) {
      return NextResponse.json({ error: 'eventId is required' }, { status: 400 });
    }

    // Normalize to a cart. Accept either legacy {ticketTypeId, quantity} or {items: [...]}.
    const rawItems: ETransferCartItem[] = body.items && body.items.length > 0
      ? body.items
      : body.ticketTypeId
      ? [{ ticketTypeId: body.ticketTypeId, quantity: body.quantity ?? 1 }]
      : [];

    if (rawItems.length === 0) {
      return NextResponse.json({ error: 'items or ticketTypeId is required' }, { status: 400 });
    }

    // Coalesce duplicates and clamp quantities
    const cartMap = new Map<string, number>();
    for (const item of rawItems) {
      if (!item.ticketTypeId) continue;
      const q = Math.max(1, Math.min(MAX_QUANTITY, Math.floor(item.quantity ?? 1)));
      cartMap.set(item.ticketTypeId, (cartMap.get(item.ticketTypeId) ?? 0) + q);
    }
    const cart: CartItem[] = Array.from(cartMap.entries()).map(([ticketTypeId, quantity]) => ({
      ticketTypeId,
      quantity: Math.min(MAX_QUANTITY, quantity),
    }));
    const totalQuantity = cart.reduce((sum, c) => sum + c.quantity, 0);

    // Resolve identity from session (any tier). The new-magic-link branch
    // below handles the anonymous-with-email case before we touch any other
    // helpers, since it short-circuits to a "verification email sent" reply.
    const identity = await resolveCheckoutIdentity(request, { email: body.email }, log);

    let ownerDid: string;
    let ownerEmail: string | undefined;

    if (identity.did) {
      ownerDid = identity.did;
      ownerEmail = identity.email;

      // Validate we have an email for ticket delivery
      if (!ownerEmail) {
        return NextResponse.json(
          { error: 'Email required to send your ticket', field: 'email' },
          { status: 400 }
        );
      }
    } else if (body.email) {
      // Anonymous buyer with an email but no session: send a magic-link
      // verification email instead of creating a soft DID + hold blindly.
      // This proves the email is real and owned before we reserve inventory
      // or send any reservation email.
      // Tab-A-canonical: redirect goes to a simple affirmation page; cart stays
      // in component state and tab A picks up verification via polling.
      const eventsBase = process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai';
      const redirectUrl = `${eventUrl(eventsBase, body.eventId)}${
        body.invite ? `?invite=${encodeURIComponent(body.invite)}` : ''
      }`;
      let pollHandle: string | undefined;
      try {
        const onboardRes = await fetch(`${AUTH_URL}/api/onboard`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: body.email,
            name: body.name,
            redirectUrl,
            context: 'reserve your tickets',
            wantPolling: true,
          }),
        });
        if (!onboardRes.ok) {
          const errBody = await onboardRes.text().catch(() => '');
          log.error({ status: onboardRes.status, body: errBody }, 'Magic-link send failed');
          // Issue #13: pass through kernel status codes so the client can show
          // accurate messages (e.g. 429 rate-limit, 410 gone).
          const propagateStatus = onboardRes.status === 429 || onboardRes.status === 410
            ? onboardRes.status
            : 502;
          let message = 'Could not send verification email. Please try again.';
          try {
            const parsed = JSON.parse(errBody);
            if (parsed.error) message = parsed.error;
          } catch { /* ignore parse failure, use generic */ }
          return NextResponse.json({ error: message }, { status: propagateStatus });
        }
        const onboardData = await onboardRes.json();
        pollHandle = onboardData.pollHandle;
      } catch (err) {
        log.error({ err: String(err) }, 'Magic-link send error');
        return NextResponse.json(
          { error: 'Could not send verification email. Please try again.' },
          { status: 502 }
        );
      }
      return NextResponse.json({
        verificationSent: true,
        email: body.email,
        ...(pollHandle ? { pollHandle } : {}),
        message: `We sent a verification link to ${body.email}. Click it to confirm your email and reserve your ticket${totalQuantity > 1 ? 's' : ''}.`,
      });
    } else {
      return NextResponse.json(
        { error: 'Not authenticated. Please log in or provide an email address.' },
        { status: 401 }
      );
    }

    // Fetch event for downstream emtEmail + invite + emails
    const [event] = await db.select().from(events).where(eq(events.id, body.eventId)).limit(1);
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }
    if (event.status !== 'published') {
      return NextResponse.json({ error: 'Tickets are not available for this event' }, { status: 400 });
    }

    const etransferEmail = (event as any).emtEmail;
    if (!etransferEmail) {
      return NextResponse.json({ error: 'e-Transfer is not available for this event' }, { status: 400 });
    }

    if (event.accessMode === 'invite_only') {
      const token = body.invite || request.nextUrl.searchParams.get('invite');
      await validateInviteAccess(body.eventId, token);
    }

    // First validateCart pass: types exist + currency consistency. Availability
    // is deferred until AFTER duplicate-pending-order detection so a buyer
    // with an existing hold can still retrieve it when stock has since sold
    // out.
    const initial = await validateCart(body.eventId, cart);
    const cartCurrency = initial.currency;

    // Look for an existing pending EMT order from this buyer covering exactly
    // the same cart shape (same ticket types in same quantities). If found,
    // return its instructions instead of creating a duplicate hold.
    const existingOrders = await db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.eventId, body.eventId),
          eq(orders.buyerDid, ownerDid),
          eq(orders.status, 'pending'),
          eq(orders.paymentMethod, 'etransfer')
        )
      );

    for (const existing of existingOrders) {
      const heldTickets = await db
        .select()
        .from(tickets)
        .where(eq(tickets.orderId, existing.id));
      const existingCart = new Map<string, number>();
      for (const t of heldTickets) {
        existingCart.set(t.ticketTypeId, (existingCart.get(t.ticketTypeId) ?? 0) + 1);
      }
      const shapeMatches =
        existingCart.size === cartMap.size &&
        Array.from(cartMap.entries()).every(([k, v]) => existingCart.get(k) === v);
      if (!shapeMatches) continue;

      const earliestDeadline = heldTickets
        .map((t) => t.holdExpiresAt)
        .filter((d): d is Date => !!d)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      return NextResponse.json({
        orderId: existing.id,
        ticketIds: heldTickets.map((t) => t.id),
        instructions: {
          email: etransferEmail,
          amount: existing.amountTotal / 100,
          currency: existing.currency,
          memo: `ORD-${existing.id}`,
          deadline: earliestDeadline,
          quantity: existing.quantity,
          message: `Your ${existing.quantity} ticket${existing.quantity > 1 ? 's are' : ' is'} reserved. Send one e-Transfer for the full amount; once we confirm it, your tickets will be activated.`,
        },
      });
    }

    // Second pass: release expired holds + availability check. Re-fetches
    // types so post-release sold counts are accurate.
    const validated = await validateCart(body.eventId, cart, {
      releaseExpiredHolds: true,
      checkAvailability: true,
      availabilityStatusCode: 409,
    });

    const holdUntil = new Date();
    holdUntil.setHours(holdUntil.getHours() + HOLD_HOURS);

    // Resolve the buyer's email up-front so it can be stored on the order row.
    // Falls back to auth.identities.contact_email when the request didn't carry
    // one (e.g. logged-in user with no body.email).
    let buyerEmail: string | undefined = ownerEmail;
    if (!buyerEmail) {
      try {
        const sql = getClient();
        const rows = await sql<{ contact_email: string | null }[]>`
          SELECT contact_email FROM auth.identities WHERE id = ${ownerDid} LIMIT 1
        `;
        buyerEmail = rows[0]?.contact_email ?? undefined;
      } catch (err) {
        log.warn({ err: String(err) }, 'Failed to resolve buyer email for reservation');
      }
    }

    const { order, tickets: insertedTickets } = await createOrderWithTickets({
      eventId: body.eventId,
      buyerDid: ownerDid,
      buyerEmail,
      cart,
      typesById: validated.typesById,
      totalQuantity: validated.totalQuantity,
      totalAmount: validated.totalAmount,
      currency: validated.currency,
      paymentMethod: 'etransfer',
      ticketStatus: 'held',
      holdExpiresAt: holdUntil,
      orderMetadata: cart.length > 1 ? { cart } : {},
      log,
    });

    const memo = `ORD-${order.id}`;
    const amount = validated.totalAmount / 100;

    // Send the buyer a 'reserved — not yet confirmed' email so they have a
    // record of the hold, the memo, and the address to send to.
    if (buyerEmail) {
      const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai';
      const eventDate = new Date(event.startsAt);
      const eventImageUrl = event.imageUrl
        ? (event.imageUrl.startsWith('http') ? event.imageUrl : `${EVENTS_URL}${event.imageUrl}`)
        : undefined;
      const summary = cart.map((item) => ({
        typeName: validated.typesById.get(item.ticketTypeId)?.name ?? 'Ticket',
        quantity: item.quantity,
      }));
      const formattedAmount = new Intl.NumberFormat('en-CA', {
        style: 'currency',
        currency: cartCurrency,
      }).format(amount);
      const formattedDeadline = holdUntil.toLocaleString('en-CA', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      });
      publish('ticket.reserved', {
        issuer: ownerDid,
        subject: ownerDid,
        scope: 'events',
        payload: {
          email: buyerEmail,
          eventTitle: event.title,
          eventDate: eventDate.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          }),
          eventTime: eventDate.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            timeZoneName: 'short',
          }),
          ticketSummary: summary,
          totalQuantity,
          amount: formattedAmount,
          payToEmail: etransferEmail,
          memo,
          deadline: formattedDeadline,
          buyerEmail,
          myTicketsUrl: eventMyTicketsUrl(EVENTS_URL, event.id),
          eventImageUrl,
          context_id: event.id,
          context_type: 'event',
        },
      }).catch((err) => log.error({ err: String(err) }, 'Failed to publish ticket reserved event'));
    } else {
      log.warn({ ownerDid, eventId: body.eventId }, 'No buyer email available for reservation; skipping confirmation send');
    }

    return NextResponse.json(
      {
        orderId: order.id,
        ticketIds: insertedTickets.map((t) => t.id),
        instructions: {
          email: etransferEmail,
          amount,
          currency: cartCurrency,
          memo,
          deadline: holdUntil,
          quantity: totalQuantity,
          message: totalQuantity > 1
            ? `Your ${totalQuantity} tickets are reserved. Send one e-Transfer for the full amount; once we confirm it, all ${totalQuantity} tickets will be activated.`
            : `Your ticket is reserved. Once we confirm your e-Transfer, your ticket will be activated.`,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof CheckoutValidationError) {
      return NextResponse.json(
        { error: error.message, ...(error.field ? { field: error.field } : {}) },
        { status: error.statusCode },
      );
    }
    log.error({ err: String(error) }, 'e-Transfer checkout error');
    return NextResponse.json(
      { error: 'Failed to process e-Transfer' },
      { status: 500 }
    );
  }
});
