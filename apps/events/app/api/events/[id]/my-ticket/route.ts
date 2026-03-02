import { NextRequest, NextResponse } from 'next/server';
import { db, tickets, ticketTypes } from '@/src/db';
import { requireAuth } from '@/src/lib/auth';
import { eq, and } from 'drizzle-orm';
import { getEventPod } from '@/src/lib/pods';

/**
 * GET /api/events/:id/my-ticket - Check if user has a ticket for this event
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ hasTicket: false });
  }

  const { identity } = authResult;
  const { id: eventId } = await params;

  try {
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
          eq(tickets.ownerDid, identity.id)
        )
      );

    const hasTicket = userTickets.length > 0;
    let conversationId: string | null = null;
    let lobbyConversationId: string | null = null;

    if (hasTicket) {
      const pod = await getEventPod(eventId);
      conversationId = pod?.conversationId ?? null;
      lobbyConversationId = pod?.lobbyConversationId ?? null;
    }

    return NextResponse.json({
      hasTicket,
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
      conversationId,
      lobbyConversationId,
    });
  } catch (error) {
    console.error('Failed to check ticket ownership:', error);
    return NextResponse.json({ hasTicket: false, tickets: [] });
  }
}
