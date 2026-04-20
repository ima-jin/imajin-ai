import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { db, tickets, ticketTypes, events } from '@/src/db';

const log = createLogger('events');
import { requireAuth } from '@imajin/auth';
import { eq, and } from 'drizzle-orm';
import { getClient } from '@imajin/db';

const sql = getClient();

/**
 * GET /api/events/:id/my-ticket - Check if user has access to this event
 * Returns hasAccess: true if user has a ticket OR is an organizer (host/cohost/owner)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ hasTicket: false, hasAccess: false });
  }

  const { identity } = authResult;
  const did = identity.actingAs || identity.id;
  const { id: eventId } = await params;

  try {
    // Check ticket ownership
    const userTickets = await db
      .select({
        ticket: tickets,
        ticketType: ticketTypes,
      })
      .from(tickets)
      .leftJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
      .where(
        and(
          eq(tickets.eventId, eventId),
          eq(tickets.ownerDid, did)
        )
      );

    const hasTicket = userTickets.length > 0;

    // Check if user is an organizer (creator, host, or cohost)
    let isOrganizer = false;
    const event = await db
      .select({ creatorDid: events.creatorDid, podId: events.podId })
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);

    if (event.length > 0) {
      // Direct creator check
      if (event[0].creatorDid === did) {
        isOrganizer = true;
      }

      // Pod membership check (host/cohost/owner roles)
      if (!isOrganizer && event[0].podId) {
        const podRole = await sql`
          SELECT role FROM connections.pod_members
          WHERE pod_id = ${event[0].podId}
            AND did = ${did}
            AND role IN ('owner', 'host', 'cohost')
          LIMIT 1
        `;
        isOrganizer = podRole.length > 0;
      }
    }

    const hasAccess = hasTicket || isOrganizer;

    return NextResponse.json({
      hasTicket,
      hasAccess,
      isOrganizer,
      tickets: userTickets.map(({ ticket, ticketType }) => ({
        id: ticket.id,
        status: ticket.status,
        purchasedAt: ticket.purchasedAt,
        pricePaid: ticket.pricePaid,
        currency: ticket.currency,
        ticketType: ticketType ? {
          name: ticketType.name,
          description: ticketType.description,
          perks: ticketType.perks,
        } : null,
      })),
      ticketId: userTickets[0]?.ticket.id || null,
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to check event access');
    return NextResponse.json({ hasTicket: false, hasAccess: false, tickets: [] });
  }
}
