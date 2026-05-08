/**
 * POST /api/tickets/[id]/confirm-payment
 *
 * Confirms an e-Transfer payment for a held ticket.
 * Changes status from 'held' to 'valid' and records confirmation timestamp.
 * Requires event organizer auth.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { db, tickets, ticketTypes, events, orders } from '@/src/db';
import { requireAuth } from '@imajin/auth';

const log = createLogger('events');
import { isEventOrganizer } from '@/src/lib/organizer';
import { eq, sql, and } from 'drizzle-orm';

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

    const now = new Date();

    // If the ticket belongs to an order (multi-ticket EMT), confirm every
    // held sibling in the order atomically. Single e-Transfer pays for the
    // whole order; partial confirmation would leave it in a half-state.
    let confirmedTickets: (typeof tickets.$inferSelect)[];
    if (ticket.orderId) {
      confirmedTickets = await db
        .update(tickets)
        .set({
          status: 'valid',
          purchasedAt: now,
          paymentConfirmedAt: now,
          heldBy: null,
          heldUntil: null,
          holdExpiresAt: null,
        })
        .where(and(eq(tickets.orderId, ticket.orderId), eq(tickets.status, 'held')))
        .returning();

      // Mark the order completed
      await db
        .update(orders)
        .set({ status: 'completed', purchasedAt: now })
        .where(eq(orders.id, ticket.orderId));
    } else {
      const [single] = await db
        .update(tickets)
        .set({
          status: 'valid',
          purchasedAt: now,
          paymentConfirmedAt: now,
          heldBy: null,
          heldUntil: null,
          holdExpiresAt: null,
        })
        .where(eq(tickets.id, id))
        .returning();
      confirmedTickets = [single];
    }

    // Increment sold count on the ticket type by the number of tickets confirmed
    if (confirmedTickets.length > 0) {
      await db
        .update(ticketTypes)
        .set({ sold: sql`${ticketTypes.sold} + ${confirmedTickets.length}` })
        .where(eq(ticketTypes.id, ticket.ticketTypeId));
    }

    // Fetch event to get creator DID for attestation
    const [event] = await db.select().from(events).where(eq(events.id, ticket.eventId)).limit(1);

    // Fire one ticket.purchased event per confirmed ticket so attribution
    // and downstream side-effects fire for each.
    for (const t of confirmedTickets) {
      publish('ticket.purchased', {
        issuer: t.ownerDid || '',
        subject: event?.creatorDid ?? t.eventId,
        scope: 'events',
        payload: {
          ticketId: t.id,
          eventId: t.eventId,
          amount: t.pricePaid ?? 0,
          currency: t.currency || 'USD',
          context_id: t.eventId,
          context_type: 'event',
        },
      }).catch((err) => log.error({ err: String(err) }, 'Publish error'));
    }

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
