/**
 * POST /api/tickets/[id]/confirm-payment
 *
 * Confirms an e-Transfer payment for a held ticket.
 * Changes status from 'held' to 'valid' and records confirmation timestamp.
 * Requires event organizer auth.
 *
 * DEPRECATED: Use POST /api/orders/[id]/confirm-payment for order-level
 * confirmation. This route is kept for orphan tickets (tickets without an
 * order) and edge cases only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { db, tickets } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { isEventOrganizer } from '@/src/lib/organizer';
import { confirmHeldTickets } from '@/src/lib/confirm-payment';
import { eq, and } from 'drizzle-orm';

const log = createLogger('events');

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  log.warn('POST /api/tickets/[id]/confirm-payment is deprecated; use POST /api/orders/[id]/confirm-payment');

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { identity } = authResult;
  const did = identity.actingAs || identity.id;
  const { id } = await params;

  try {
    // Find the ticket
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, id)).limit(1);

    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    if (ticket.status !== 'held') {
      return NextResponse.json({ error: 'Ticket is not in held status' }, { status: 400 });
    }

    if (ticket.paymentMethod !== 'etransfer') {
      return NextResponse.json({ error: 'Ticket is not an e-Transfer hold' }, { status: 400 });
    }

    // Verify caller is an event organizer
    const orgCheck = await isEventOrganizer(ticket.eventId, did);
    if (!orgCheck.authorized) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    // If the ticket belongs to an order, confirm every held sibling atomically.
    // Otherwise confirm just this orphan ticket.
    const heldTickets = ticket.orderId
      ? await db
          .select()
          .from(tickets)
          .where(
            and(
              eq(tickets.orderId, ticket.orderId),
              eq(tickets.status, 'held'),
              eq(tickets.paymentMethod, 'etransfer')
            )
          )
      : [ticket];

    const { confirmedTickets } = await confirmHeldTickets(ticket.eventId, heldTickets, ticket.orderId);

    return NextResponse.json({
      ticket: confirmedTickets[0],
      confirmedCount: confirmedTickets.length,
      orderId: ticket.orderId ?? null,
    });
  } catch (error) {
    log.error({ err: String(error) }, 'confirm-payment error');
    return NextResponse.json({ error: 'Failed to confirm payment' }, { status: 500 });
  }
}
