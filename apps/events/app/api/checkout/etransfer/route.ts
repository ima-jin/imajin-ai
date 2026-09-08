/**
 * POST /api/checkout/etransfer
 *
 * Creates an e-Transfer hold on N tickets (default 1) of one or more ticket
 * types. All N tickets are grouped under a single order with one memo
 * (ORD-{orderId}). Returns payment instructions for one combined e-Transfer.
 */

import { NextResponse } from 'next/server';
import { withLogger } from '@imajin/logger';
import {
  validateCart,
  resolveInviteAccessForEvent,
  createOrderWithTickets,
  loadPublishedEvent,
  CheckoutValidationError,
} from '@/src/lib/checkout-common';
import {
  normalizeAndCoalesceCart,
  resolveEtransferBuyer,
  findExistingEtransferOrder,
  resolveBuyerEmailFromDb,
  publishReservationEmail,
} from '@/src/lib/etransfer-helpers';

const HOLD_HOURS = 72;

interface ETransferCheckoutRequest {
  eventId: string;
  // Legacy single-type payload (still accepted)
  ticketTypeId?: string;
  quantity?: number;
  // Multi-type cart payload
  items?: Array<{ ticketTypeId: string; quantity: number }>;
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

    // Normalize + coalesce cart items (handles legacy and multi-type payloads)
    const cartResult = normalizeAndCoalesceCart(body);
    if ('error' in cartResult) {
      return NextResponse.json({ error: cartResult.error }, { status: cartResult.status });
    }
    const { cart, cartMap, totalQuantity } = cartResult;

    // Resolve identity from session (any tier). The anonymous-with-email branch
    // short-circuits to a "verification email sent" reply.
    const buyerResult = await resolveEtransferBuyer(request, body, totalQuantity, log);
    if (buyerResult instanceof NextResponse) {
      return buyerResult;
    }
    const { ownerDid, ownerEmail } = buyerResult;

    // Fetch event for downstream emtEmail + invite + emails
    const eventResult = await loadPublishedEvent(body.eventId);
    if ('error' in eventResult) {
      return NextResponse.json({ error: eventResult.error }, { status: eventResult.status });
    }
    const { event } = eventResult;

    const etransferEmail = (event as any).emtEmail;
    if (!etransferEmail) {
      return NextResponse.json({ error: 'e-Transfer is not available for this event' }, { status: 400 });
    }

    const inviteToken = body.invite || request.nextUrl.searchParams.get('invite');
    await resolveInviteAccessForEvent(event, inviteToken);

    // First validateCart pass: types exist + currency consistency. Availability
    // is deferred until AFTER duplicate-pending-order detection so a buyer
    // with an existing hold can still retrieve it when stock has since sold out.
    const initial = await validateCart(body.eventId, cart);
    const cartCurrency = initial.currency;

    // Return existing pending order when the buyer already has a matching hold.
    const existingOrder = await findExistingEtransferOrder(body.eventId, ownerDid, cartMap, etransferEmail);
    if (existingOrder) {
      return NextResponse.json(existingOrder);
    }

    // Second pass: release expired holds + availability check.
    const validated = await validateCart(body.eventId, cart, {
      releaseExpiredHolds: true,
      checkAvailability: true,
      availabilityStatusCode: 409,
    });

    const holdUntil = new Date();
    holdUntil.setHours(holdUntil.getHours() + HOLD_HOURS);

    // Resolve buyer email for order storage + notification.
    const buyerEmail = await resolveBuyerEmailFromDb(ownerDid, ownerEmail, log);

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

    publishReservationEmail({
      buyerEmail: buyerEmail ?? '',
      ownerDid,
      event,
      cart,
      typesById: validated.typesById,
      totalQuantity,
      amount,
      cartCurrency,
      etransferEmail,
      memo,
      holdUntil,
      log,
    });

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
