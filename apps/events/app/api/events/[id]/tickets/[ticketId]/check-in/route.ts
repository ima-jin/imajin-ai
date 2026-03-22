import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/src/lib/auth';
import { isEventOrganizer } from '@/src/lib/organizer';
import { getClient } from '@imajin/db';
import { emitAttestation } from '@imajin/auth';

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
    const orgCheck = await isEventOrganizer(id, identity.id);
    if (!orgCheck.authorized) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const [ticket] = await sql`
      SELECT id, status, used_at, owner_did FROM events.tickets
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

    // Fire-and-forget attestations — do not block check-in on failure
    if (ticket.owner_did) {
      const attendeeDid = ticket.owner_did as string;
      Promise.all([
        emitAttestation({
          issuer_did: identity.id,
          subject_did: attendeeDid,
          type: 'institution.verified',
          context_id: id,
          context_type: 'event',
          payload: { ticketId, checkedInBy: identity.id },
        }),
        emitAttestation({
          issuer_did: identity.id,
          subject_did: attendeeDid,
          type: 'event.attendance',
          context_id: id,
          context_type: 'event',
          payload: { ticketId, usedAt: updated.used_at },
        }),
      ]).catch((err) => console.error('Attestation emit error:', err));
    }

    return NextResponse.json({ ticket: { id: updated.id, usedAt: updated.used_at } });
  } catch (error) {
    console.error('Failed to check in ticket:', error);
    return NextResponse.json({ error: 'Failed to check in ticket' }, { status: 500 });
  }
}
