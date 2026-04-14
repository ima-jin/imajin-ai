import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { db, events } from '@/src/db';

const log = createLogger('events');
import { requireAuth } from '@imajin/auth';
import { eq } from 'drizzle-orm';
import { getClient } from '@imajin/db';

const sqlClient = getClient();

/**
 * POST /api/events/[id]/tickets/[ticketId]/mark-refund-sent — complete a pending e-transfer refund (owner only)
 *
 * Flips status from 'refund_pending' to 'refunded'.
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
  const did = identity.actingAs || identity.id;
  const { id, ticketId } = await params;

  try {
    const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    if (event.creatorDid !== did) {
      return NextResponse.json({ error: 'Only the event owner can mark refunds as sent' }, { status: 403 });
    }

    const [ticket] = await sqlClient`
      SELECT id, status
      FROM events.tickets
      WHERE id = ${ticketId} AND event_id = ${id}
      LIMIT 1
    `;

    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    if (ticket.status !== 'refund_pending') {
      return NextResponse.json(
        { error: 'Ticket is not in refund_pending status' },
        { status: 400 }
      );
    }

    const [updated] = await sqlClient`
      UPDATE events.tickets
      SET status = 'refunded'
      WHERE id = ${ticketId}
      RETURNING id, status
    `;

    return NextResponse.json({ ticket: { id: updated.id, status: updated.status } });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to mark refund as sent');
    return NextResponse.json({ error: 'Failed to mark refund as sent' }, { status: 500 });
  }
}
