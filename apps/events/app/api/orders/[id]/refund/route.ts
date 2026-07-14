/**
 * POST /api/orders/[id]/refund
 *
 * Refunds an entire order atomically (organizer-only).
 *
 * - Stripe orders: calls pay service to issue a full Stripe refund, then
 *   marks all valid/used tickets as 'refunded' and updates the order status.
 * - Free/e-transfer orders: marks tickets directly (no pay service call).
 *
 * This endpoint is designed for the "refund entire order" case. Per-ticket
 * partial refunds are handled by the individual ticket refund route.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { db, tickets, orders, ticketTypes } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { isEventOrganizer } from '@/src/lib/organizer';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { publish } from '@imajin/bus';

const log = createLogger('events');

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL!;
const PAY_SERVICE_API_KEY = process.env.PAY_SERVICE_API_KEY!;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { identity } = authResult;
  const did = identity.actingAs || identity.id;
  const { id: orderId } = await params;

  try {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);

    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    if (order.status === 'refunded') {
      return NextResponse.json({ error: 'Order already refunded' }, { status: 400 });
    }

    const orgCheck = await isEventOrganizer(order.eventId, did);
    if (!orgCheck.authorized) {
      return NextResponse.json({ error: 'Only event organizers can issue refunds' }, { status: 403 });
    }

    // Fetch all active tickets in this order
    const orderTickets = await db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.orderId, orderId),
          inArray(tickets.status, ['valid', 'used'])
        )
      );

    if (orderTickets.length === 0) {
      return NextResponse.json({ error: 'No refundable tickets found in this order' }, { status: 400 });
    }

    const isStripe = order.paymentMethod === 'stripe' && !!order.paymentId;

    if (isStripe) {
      // Issue full Stripe refund via pay service — no `amount` means full refund
      const payResponse = await fetch(`${PAY_SERVICE_URL}/api/refund`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${PAY_SERVICE_API_KEY}`,
        },
        body: JSON.stringify({
          paymentId: order.paymentId,
          reason: 'order refund',
        }),
      });

      if (!payResponse.ok) {
        const text = await payResponse.text();
        log.error({ status: payResponse.status, text }, '[order-refund] pay /api/refund returned error');
        return NextResponse.json(
          { error: 'Payment refund failed — order status not changed' },
          { status: 502 }
        );
      }
    }

    // Mark all active tickets as refunded
    const ticketIds = orderTickets.map(t => t.id);
    await db
      .update(tickets)
      .set({ status: 'refunded' })
      .where(inArray(tickets.id, ticketIds));

    // Decrement sold counters — non-fatal
    const typeIds = [...new Set(orderTickets.map(t => t.ticketTypeId))];
    for (const typeId of typeIds) {
      const count = orderTickets.filter(t => t.ticketTypeId === typeId).length;
      await db
        .update(ticketTypes)
        .set({ sold: sql`GREATEST(${ticketTypes.sold} - ${count}, 0)` })
        .where(eq(ticketTypes.id, typeId))
        .catch((err) => {
          log.error({ err: String(err) }, '[order-refund] Failed to decrement ticket_types.sold (non-fatal)');
        });
    }

    // Mark order as refunded
    await db
      .update(orders)
      .set({ status: 'refunded' })
      .where(eq(orders.id, orderId));

    publish('order.refunded', {
      issuer: did,
      subject: order.buyerDid || 'unknown',
      scope: 'events',
      payload: {
        orderId,
        eventId: order.eventId,
        ticketIds,
        amountTotal: order.amountTotal,
        currency: order.currency,
        isStripe,
      },
    }).catch((err) => log.error({ err: String(err) }, '[order-refund] Failed to publish order.refunded'));

    return NextResponse.json({
      orderId,
      refundedTickets: ticketIds.length,
      status: 'refunded',
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Order refund error');
    return NextResponse.json({ error: 'Failed to refund order' }, { status: 500 });
  }
}
