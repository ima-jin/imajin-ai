import { NextRequest, NextResponse } from 'next/server';
import { db, events } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { eq } from 'drizzle-orm';
import { getClient } from '@imajin/db';

const sql = getClient();

/**
 * POST /api/events/[id]/tickets/[ticketId]/refund — mark ticket as refunded (owner only)
 *
 * TODO: Integrate with Stripe to issue actual payment refunds when payment service is ready.
 * Currently only updates the ticket status in the DB.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; ticketId: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { identity } = authResult;
  const { id, ticketId } = await params;

  try {
    const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Refund is owner-only (not cohosts)
    if (event.creatorDid !== identity.id) {
      return NextResponse.json({ error: 'Only the event owner can issue refunds' }, { status: 403 });
    }

    const [ticket] = await sql`
      SELECT id, status, price_paid FROM events.tickets
      WHERE id = ${ticketId} AND event_id = ${id}
      LIMIT 1
    `;

    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    if (ticket.status !== 'valid') {
      return NextResponse.json({ error: 'Only valid tickets can be refunded' }, { status: 400 });
    }

    const [updated] = await sql`
      UPDATE events.tickets
      SET status = 'refunded'
      WHERE id = ${ticketId}
      RETURNING id, status
    `;

    return NextResponse.json({ ticket: { id: updated.id, status: updated.status } });
  } catch (error) {
    console.error('Failed to refund ticket:', error);
    return NextResponse.json({ error: 'Failed to refund ticket' }, { status: 500 });
  }
}
