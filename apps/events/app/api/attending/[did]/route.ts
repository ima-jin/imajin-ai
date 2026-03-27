/**
 * GET /api/attending/[did]
 * Returns upcoming events that a DID has tickets for.
 * Used by profile page to show upcoming events.
 *
 * Privacy:
 *   - public events: shown to anyone
 *   - invite_only events: only shown if viewer_did also has a ticket
 *
 * Query params:
 *   - viewer_did: optional DID of the viewer (for invite_only privacy check)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, tickets, events } from '@/src/db';
import { eq, and, inArray, gt } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const { did } = await params;
  const ownerDid = decodeURIComponent(did);
  const viewerDid = request.nextUrl.searchParams.get('viewer_did') || null;

  try {
    const now = new Date();

    // Find upcoming events this DID has paid tickets for
    const rows = await db
      .select({
        eventId: events.id,
        title: events.title,
        startsAt: events.startsAt,
        endsAt: events.endsAt,
        venue: events.venue,
        accessMode: events.accessMode,
      })
      .from(tickets)
      .innerJoin(events, eq(tickets.eventId, events.id))
      .where(
        and(
          eq(tickets.ownerDid, ownerDid),
          inArray(tickets.status, ['sold', 'used']),
          gt(events.startsAt, now)
        )
      )
      .orderBy(events.startsAt);

    // Separate public from invite_only
    const publicEvents = rows.filter((r) => r.accessMode === 'public');
    const privateEvents = rows.filter((r) => r.accessMode !== 'public');

    let result = publicEvents;

    // For invite_only events, only include if viewer also has a ticket
    if (privateEvents.length > 0 && viewerDid) {
      const privateEventIds = privateEvents.map((r) => r.eventId);

      const viewerTickets = await db
        .select({ eventId: tickets.eventId })
        .from(tickets)
        .where(
          and(
            eq(tickets.ownerDid, viewerDid),
            inArray(tickets.status, ['sold', 'used']),
            inArray(tickets.eventId, privateEventIds)
          )
        );

      const viewerEventSet = new Set(viewerTickets.map((t) => t.eventId));
      const allowedPrivate = privateEvents.filter((r) => viewerEventSet.has(r.eventId));
      result = [...publicEvents, ...allowedPrivate].sort(
        (a, b) => a.startsAt.getTime() - b.startsAt.getTime()
      );
    }

    return NextResponse.json(
      result.map((r) => ({
        eventId: r.eventId,
        title: r.title,
        startDate: r.startsAt.toISOString(),
        endDate: r.endsAt ? r.endsAt.toISOString() : null,
        venue: r.venue ?? null,
      }))
    );
  } catch (error) {
    console.error('Failed to fetch attending events:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
