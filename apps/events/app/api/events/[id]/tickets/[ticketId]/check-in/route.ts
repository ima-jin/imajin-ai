import { NextRequest, NextResponse } from 'next/server';
import { db, events } from '@/src/db';
import { requireAuth } from '@/src/lib/auth';
import { eq } from 'drizzle-orm';
import { getClient } from '@imajin/db';

const sql = getClient();

/**
 * POST /api/events/[id]/tickets/[ticketId]/check-in — set used_at timestamp (owner or cohost)
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

    const isOwner = event.creatorDid === identity.id;
    let isCohost = false;

    if (!isOwner && event.podId) {
      const rows = await sql`
        SELECT role FROM connections.pod_members
        WHERE pod_id = ${event.podId} AND did = ${identity.id} AND role IN ('owner', 'cohost')
        LIMIT 1
      `;
      isCohost = rows.length > 0;
    }

    if (!isOwner && !isCohost) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const [ticket] = await sql`
      SELECT id, status, used_at FROM events.tickets
      WHERE id = ${ticketId} AND event_id = ${id}
      LIMIT 1
    `;

    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    if (ticket.status !== 'valid') {
      return NextResponse.json({ error: 'Ticket is not valid' }, { status: 400 });
    }

    if (ticket.used_at) {
      return NextResponse.json({ error: 'Ticket already checked in' }, { status: 400 });
    }

    const [updated] = await sql`
      UPDATE events.tickets
      SET used_at = NOW()
      WHERE id = ${ticketId}
      RETURNING id, used_at
    `;

    return NextResponse.json({ ticket: { id: updated.id, usedAt: updated.used_at } });
  } catch (error) {
    console.error('Failed to check in ticket:', error);
    return NextResponse.json({ error: 'Failed to check in ticket' }, { status: 500 });
  }
}
