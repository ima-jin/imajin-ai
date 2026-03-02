/**
 * GET /api/tickets/by-token/[token]
 *
 * Look up ticket by magic token for authentication.
 * Returns ticket and event data needed for magic link verification.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, tickets, events } from '@/src/db';
import { eq } from 'drizzle-orm';

export async function GET(
  request: NextRequest,
  { params }: { params: { token: string } }
) {
  try {
    const { token } = params;

    if (!token) {
      return NextResponse.json({ error: 'Token is required' }, { status: 400 });
    }

    // Look up ticket by magic token, join with event
    const [result] = await db
      .select({
        ticket: {
          id: tickets.id,
          eventId: tickets.eventId,
          ownerDid: tickets.ownerDid,
          status: tickets.status,
        },
        event: {
          id: events.id,
          title: events.title,
          startsAt: events.startsAt,
        },
      })
      .from(tickets)
      .innerJoin(events, eq(tickets.eventId, events.id))
      .where(eq(tickets.magicToken, token))
      .limit(1);

    if (!result) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 404 });
    }

    // Only allow valid tickets
    if (result.ticket.status !== 'valid') {
      return NextResponse.json({ error: 'Ticket is not valid' }, { status: 403 });
    }

    return NextResponse.json({
      ticket: result.ticket,
      event: result.event,
    });

  } catch (error) {
    console.error('Ticket lookup error:', error);
    return NextResponse.json(
      { error: 'Failed to look up ticket' },
      { status: 500 }
    );
  }
}
