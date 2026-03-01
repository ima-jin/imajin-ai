import { NextRequest, NextResponse } from 'next/server';
import { db, tickets } from '@/src/db';
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
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.eventId, eventId),
          eq(tickets.ownerDid, identity.id)
        )
      )
      .limit(1);

    const hasTicket = userTickets.length > 0;
    let conversationId: string | null = null;

    if (hasTicket) {
      const pod = await getEventPod(eventId);
      conversationId = pod?.conversationId ?? null;
    }

    return NextResponse.json({
      hasTicket,
      ticketId: userTickets[0]?.id || null,
      conversationId,
    });
  } catch (error) {
    console.error('Failed to check ticket ownership:', error);
    return NextResponse.json({ hasTicket: false });
  }
}
