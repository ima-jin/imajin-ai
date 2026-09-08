/**
 * POST /api/checkout/balance
 *
 * Pays for tickets using the buyer's MJNx balance. Transfers funds from
 * buyer â†’ event creator via the pay service, then creates an order with
 * instantly-valid tickets (no hold period â€” payment is immediate).
 */

import { NextResponse } from 'next/server';
import { withLogger } from '@imajin/logger';
import { requireAuth , resolveActingDid } from '@imajin/auth';
import { db, eventInvites } from '@/src/db';
import { eq } from 'drizzle-orm';
import { rateLimit, getClientIP } from '@imajin/config';
import {
  validateCart,
  resolveInviteAccessForEvent,
  createOrderWithTickets,
  loadPublishedEvent,
  syncBuyerToEventChatFireAndForget,
  CheckoutValidationError,
} from '@/src/lib/checkout-common';
import {
  normalizeBalanceCart,
  resolveBalanceBuyerEmail,
  transferBuyerBalance,
  publishBalanceTicketsPurchased,
  sendBalanceConfirmationEmails,
} from '@/src/lib/balance-checkout-helpers';

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL!;

interface BalanceCheckoutRequest {
  eventId: string;
  ticketTypeId?: string;
  quantity?: number;
  items?: { ticketTypeId: string; quantity: number }[];
  invite?: string;
}

export const POST = withLogger('events', async (request, { log }) => {
  const ip = getClientIP(request);
  const rl = rateLimit(ip, 10, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    );
  }

  try {
    // Auth required â€” buyer must be logged in
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const buyerDid = resolveActingDid(authResult.identity);

    const body: BalanceCheckoutRequest = await request.json();

    if (!body.eventId) {
      return NextResponse.json({ error: 'eventId is required' }, { status: 400 });
    }

    // Normalize to cart (same pattern as Stripe/EMT routes)
    const cartResult = normalizeBalanceCart(body);
    if (!Array.isArray(cartResult)) {
      return NextResponse.json({ error: cartResult.error }, { status: cartResult.status });
    }
    const cart = cartResult;

    // Fetch event
    const eventResult = await loadPublishedEvent(body.eventId);
    if ('error' in eventResult) {
      return NextResponse.json({ error: eventResult.error }, { status: eventResult.status });
    }
    const { event } = eventResult;

    // Invite-only access check
    const inviteToken = body.invite || request.nextUrl.searchParams.get('invite');
    const inviteRecord = await resolveInviteAccessForEvent(event, inviteToken);

    // Validate cart (availability + release expired holds)
    const validated = await validateCart(body.eventId, cart, {
      releaseExpiredHolds: true,
      checkAvailability: true,
    });

    const { typesById, totalQuantity, totalAmount, currency } = validated;

    if (totalAmount === 0) {
      return NextResponse.json(
        { error: 'Use the free checkout for $0 tickets' },
        { status: 400 },
      );
    }

    // Resolve buyer email for ticket delivery
    const buyerEmail = await resolveBalanceBuyerEmail(buyerDid, log);

    // Transfer balance: buyer → event creator
    const transferResult = await transferBuyerBalance({
      payServiceUrl: PAY_SERVICE_URL,
      cookieHeader: request.headers.get('cookie') || '',
      fromDid: buyerDid,
      toDid: event.creatorDid,
      amountCents: totalAmount,
      eventId: body.eventId,
      cart,
      log,
    });

    if ('error' in transferResult) {
      return NextResponse.json({ error: transferResult.error }, { status: transferResult.status });
    }
    const { transactionId } = transferResult;

    // Create order + tickets (instantly valid)
    const { order, tickets } = await createOrderWithTickets({
      eventId: body.eventId,
      buyerDid,
      buyerEmail,
      cart,
      typesById,
      totalQuantity,
      totalAmount,
      currency,
      paymentMethod: 'balance',
      ticketStatus: 'valid',
      paymentId: transactionId,
      eventDid: event.did,
      eventPrivateKey: (event as any).privateKey,
      customerEmail: buyerEmail,
      log,
      incrementSold: true,
    });

    // Increment invite usedCount if invite-only
    if (inviteRecord) {
      await db
        .update(eventInvites)
        .set({ usedCount: inviteRecord.usedCount + 1 })
        .where(eq(eventInvites.id, inviteRecord.id));
    }

    // Fire ticket.purchased for each ticket (same pattern as webhook)
    publishBalanceTicketsPurchased(tickets, event, buyerDid, currency, log);

    // Send confirmation email if we have an email
    if (buyerEmail) {
      sendBalanceConfirmationEmails({
        buyerEmail,
        buyerDid,
        event,
        tickets,
        typesById,
        totalAmount,
        log,
      });
    }

    // Add buyer to event chat (fire and forget)
    syncBuyerToEventChatFireAndForget(event.did, buyerDid, log);

    return NextResponse.json({
      success: true,
      orderId: order.id,
      ticketIds: tickets.map((t) => t.id),
    });
  } catch (error) {
    if (error instanceof CheckoutValidationError) {
      return NextResponse.json(
        { error: error.message, ...(error.field ? { field: error.field } : {}) },
        { status: error.statusCode },
      );
    }
    log.error({ err: String(error) }, 'Balance checkout error');
    return NextResponse.json({ error: 'Balance checkout failed' }, { status: 500 });
  }
});