/**
 * POST /api/orders/[id]/confirm-payment
 *
 * Confirms an e-Transfer payment for an order atomically.
 * Changes all held tickets in the order from 'held' to 'valid'.
 * Requires event organizer auth.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { db, tickets, orders } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { isEventOrganizer } from '@/src/lib/organizer';
import { confirmHeldTickets } from '@/src/lib/confirm-payment';
import { eq, and } from 'drizzle-orm';

const log = createLogger('events');

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
    // Find the order
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);

    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    if (order.status !== 'pending') {
      return NextResponse.json({ error: 'Order is not in pending status' }, { status: 400 });
    }

    // Verify caller is an event organizer
    const orgCheck = await isEventOrganizer(order.eventId, did);
    if (!orgCheck.authorized) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    // Find all held e-Transfer tickets in this order
    const heldTickets = await db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.orderId, orderId),
          eq(tickets.status, 'held'),
          eq(tickets.paymentMethod, 'etransfer')
        )
      );

    if (heldTickets.length === 0) {
      return NextResponse.json(
        { error: 'No held e-Transfer tickets found in this order' },
        { status: 400 }
      );
    }

    const { confirmedTickets } = await confirmHeldTickets(order.eventId, heldTickets, orderId);

    return NextResponse.json({
      confirmedCount: confirmedTickets.length,
      orderId,
      tickets: confirmedTickets.map((t) => t.id),
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Order confirm-payment error');
    return NextResponse.json(
      { error: 'Failed to confirm payment' },
      { status: 500 }
    );
  }
}
