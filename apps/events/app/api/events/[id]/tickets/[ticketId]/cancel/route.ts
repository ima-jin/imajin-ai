/**
 * POST /api/events/[id]/tickets/[ticketId]/cancel
 *
 * Cancels a held (unconfirmed) e-Transfer ticket.
 * Only works for tickets with status 'held' — confirmed tickets must use refund.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db, tickets, events } from '@/src/db';
import { getSession } from '@imajin/auth';
import { withLogger } from '@imajin/logger';

export const POST = withLogger('events', async (
  _request: NextRequest,
  { log, params }: { log: any; params: Promise<{ id: string; ticketId: string }> }
) => {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { id: eventId, ticketId } = await params;
  const actingDid = session.actingAs || session.id;

  // Verify event ownership
  const [event] = await db
    .select({ creatorDid: events.creatorDid })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event || event.creatorDid !== actingDid) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  // Fetch the ticket
  const [ticket] = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.eventId, eventId)))
    .limit(1);

  if (!ticket) {
    return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
  }

  if (ticket.status !== 'held') {
    return NextResponse.json(
      { error: `Cannot cancel a ticket with status '${ticket.status}'. Only held tickets can be cancelled.` },
      { status: 400 }
    );
  }

  // Cancel the ticket
  const [updated] = await db
    .update(tickets)
    .set({
      status: 'cancelled',
      heldBy: null,
      heldUntil: null,
    })
    .where(eq(tickets.id, ticketId))
    .returning();

  log.info({ ticketId, eventId }, 'Held ticket cancelled');

  return NextResponse.json({ ticket: updated });
});
