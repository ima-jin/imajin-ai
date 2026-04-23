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
import { db, tickets, ticketTypes, events } from '@/src/db';
import { requireAuth } from '@imajin/auth';

const log = createLogger('events');
import { isEventOrganizer } from '@/src/lib/organizer';
import { eq, sql } from 'drizzle-orm';

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

    // Confirm the ticket
    const [confirmed] = await db
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

    // Increment sold count on the ticket type
    await db
      .update(ticketTypes)
      .set({ sold: sql`${ticketTypes.sold} + 1` })
      .where(eq(ticketTypes.id, ticket.ticketTypeId));

    // Fetch event to get creator DID for attestation
    const [event] = await db.select().from(events).where(eq(events.id, ticket.eventId)).limit(1);

    // Fire and forget — never block the response
    publish('ticket.purchased', {
      issuer: ticket.ownerDid || '',
      subject: event?.creatorDid ?? ticket.eventId,
      scope: 'events',
      payload: {
        ticketId: confirmed.id,
        eventId: ticket.eventId,
        amount: ticket.pricePaid ?? 0,
        currency: ticket.currency || 'USD',
        context_id: ticket.eventId,
        context_type: 'event',
      },
    }).catch((err) => log.error({ err: String(err) }, 'Publish error'));

    return NextResponse.json({ ticket: confirmed });
  } catch (error) {
    log.error({ err: String(error) }, 'confirm-payment error');
    return NextResponse.json({ error: 'Failed to confirm payment' }, { status: 500 });
  }
}
