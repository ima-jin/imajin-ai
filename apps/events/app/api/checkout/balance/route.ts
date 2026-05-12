/**
 * POST /api/checkout/balance
 *
 * Pays for tickets using the buyer's MJNx balance. Transfers funds from
 * buyer → event creator via the pay service, then creates an order with
 * instantly-valid tickets (no hold period — payment is immediate).
 */

import { NextResponse } from 'next/server';
import { withLogger } from '@imajin/logger';
import { requireAuth } from '@imajin/auth';
import { db, events, eventInvites } from '@/src/db';
import { eq, and, sql } from 'drizzle-orm';
import { publish } from '@imajin/bus';
import { getClient } from '@imajin/db';
import { rateLimit, getClientIP } from '@/src/lib/rate-limit';
import {
  validateCart,
  validateInviteAccess,
  createOrderWithTickets,
  CheckoutValidationError,
  type CartItem,
} from '@/src/lib/checkout-common';

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL!;
const MAX_QUANTITY = 20;

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
    // Auth required — buyer must be logged in
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const buyerDid = authResult.identity.actingAs || authResult.identity.id;

    const body: BalanceCheckoutRequest = await request.json();

    if (!body.eventId) {
      return NextResponse.json({ error: 'eventId is required' }, { status: 400 });
    }

    // Normalize to cart (same pattern as Stripe/EMT routes)
    const rawItems = body.items && body.items.length > 0
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

    // Fetch event
    const [event] = await db.select().from(events).where(eq(events.id, body.eventId)).limit(1);
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
      await validateInviteAccess(body.eventId, token);

      // Fetch the invite record for usedCount increment later
      if (token) {
        const [invite] = await db
          .select()
          .from(eventInvites)
          .where(and(eq(eventInvites.eventId, body.eventId), eq(eventInvites.token, token)))
          .limit(1);
        inviteRecord = invite;
      }
    }

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
    let buyerEmail: string | undefined;
    try {
      const pgClient = getClient();
      const rows = await pgClient<{ contact_email: string | null }[]>`
        SELECT contact_email FROM auth.identities WHERE id = ${buyerDid} LIMIT 1
      `;
      buyerEmail = rows[0]?.contact_email ?? undefined;
    } catch (err) {
      log.warn({ err: String(err) }, 'Failed to resolve buyer email');
    }

    // Transfer balance: buyer → event creator
    const payRes = await fetch(`${PAY_SERVICE_URL}/pay/api/balance/transfer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': request.headers.get('cookie') || '',
      },
      body: JSON.stringify({
        from_did: buyerDid,
        to_did: event.creatorDid,
        amount: totalAmount / 100, // transfer expects dollars, not cents
        metadata: {
          service: 'events',
          eventId: body.eventId,
          cart: JSON.stringify(cart),
        },
      }),
    });

    if (!payRes.ok) {
      const errBody = await payRes.json().catch(() => ({ error: 'Balance transfer failed' }));
      log.warn({ status: payRes.status, body: errBody }, 'Balance transfer failed');
      return NextResponse.json(
        { error: errBody.error || 'Insufficient balance or transfer failed' },
        { status: payRes.status >= 400 && payRes.status < 500 ? payRes.status : 502 },
      );
    }

    const transferData = await payRes.json();
    log.info({ transactionId: transferData.transactionId, amount: totalAmount / 100 }, 'Balance transfer succeeded');

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
      paymentId: transferData.transactionId,
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
    for (const ticket of tickets) {
      publish('ticket.purchased', {
        issuer: buyerDid,
        subject: event.creatorDid,
        scope: 'events',
        payload: {
          ticketId: ticket.id,
          eventId: event.id,
          amount: ticket.pricePaid ?? 0,
          currency,
          context_id: event.id,
          context_type: 'event',
          to: buyerDid,
          interestDids: [buyerDid],
        },
      }).catch((err) => log.error({ err: String(err) }, 'ticket.purchased publish error'));
    }

    // Send confirmation email if we have an email
    if (buyerEmail) {
      try {
        const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai';
        const eventDate = new Date(event.startsAt);
        const eventImageUrl = event.imageUrl
          ? (event.imageUrl.startsWith('http') ? event.imageUrl : `${EVENTS_URL}${event.imageUrl}`)
          : undefined;

        for (const ticket of tickets) {
          const ticketType = typesById.get(ticket.ticketTypeId);
          publish('ticket.confirmed', {
            issuer: buyerDid,
            subject: buyerDid,
            scope: 'events',
            payload: {
              email: buyerEmail,
              eventTitle: event.title,
              ticketType: ticketType?.name ?? 'Ticket',
              ticketId: ticket.id,
              eventDate: eventDate.toLocaleDateString('en-US', {
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
              }),
              eventTime: eventDate.toLocaleTimeString('en-US', {
                hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
              }),
              isVirtual: event.isVirtual ?? false,
              venue: event.venue ?? undefined,
              price: `$${(totalAmount / 100).toFixed(2)} (Balance)`,
              eventImageUrl,
              eventUrl: `${EVENTS_URL}/${event.id}`,
              context_id: event.id,
              context_type: 'event',
            },
          }).catch((err) => log.error({ err: String(err) }, 'ticket.confirmed publish error'));
        }
      } catch (emailError) {
        log.error({ err: String(emailError) }, 'Confirmation publish failed (non-fatal)');
      }
    }

    // Add buyer to event chat (fire and forget)
    const CHAT_URL = process.env.CHAT_SERVICE_URL || process.env.CHAT_URL;
    if (CHAT_URL) {
      fetch(`${CHAT_URL}/api/d/${encodeURIComponent(event.did)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberDid: buyerDid, role: 'member' }),
      }).catch((err) => log.warn({ err: String(err) }, 'Event chat member sync failed (non-fatal)'));
    }

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
