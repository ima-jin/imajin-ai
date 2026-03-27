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
import { db, tickets, events, eventAdmins } from '@/src/db';
import { getClient } from '@imajin/db';
import { eq, and, inArray, gt } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

interface EventRow {
  eventId: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  venue: string | null;
  accessMode: string;
  imageUrl: string | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const { did } = await params;
  const ownerDid = decodeURIComponent(did);
  const viewerDid = request.nextUrl.searchParams.get('viewer_did') || null;

  try {
    const now = new Date();

    // 1. Events this DID has tickets for
    const ticketRows: EventRow[] = await db
      .select({
        eventId: events.id,
        title: events.title,
        startsAt: events.startsAt,
        endsAt: events.endsAt,
        venue: events.venue,
        accessMode: events.accessMode,
        imageUrl: events.imageUrl,
      })
      .from(tickets)
      .innerJoin(events, eq(tickets.eventId, events.id))
      .where(
        and(
          eq(tickets.ownerDid, ownerDid),
          inArray(tickets.status, ['sold', 'used']),
          gt(events.startsAt, now)
        )
      );

    // 2. Events this DID created
    const createdRows: EventRow[] = await db
      .select({
        eventId: events.id,
        title: events.title,
        startsAt: events.startsAt,
        endsAt: events.endsAt,
        venue: events.venue,
        accessMode: events.accessMode,
        imageUrl: events.imageUrl,
      })
      .from(events)
      .where(
        and(
          eq(events.creatorDid, ownerDid),
          inArray(events.status, ['draft', 'published']),
          gt(events.startsAt, now)
        )
      );

    // 3. Events this DID is an admin of
    const adminRows: EventRow[] = await db
      .select({
        eventId: events.id,
        title: events.title,
        startsAt: events.startsAt,
        endsAt: events.endsAt,
        venue: events.venue,
        accessMode: events.accessMode,
        imageUrl: events.imageUrl,
      })
      .from(eventAdmins)
      .innerJoin(events, eq(eventAdmins.eventId, events.id))
      .where(
        and(
          eq(eventAdmins.did, ownerDid),
          inArray(events.status, ['draft', 'published']),
          gt(events.startsAt, now)
        )
      );

    // 4. Events this DID is a cohost of (via pod_members)
    let cohostRows: EventRow[] = [];
    try {
      const sql = getClient();
      const podEvents = await sql`
        SELECT e.id as event_id, e.title, e.starts_at, e.ends_at, e.venue, e.access_mode, e.image_url
        FROM connections.pod_members pm
        JOIN events.events e ON e.pod_id = pm.pod_id
        WHERE pm.did = ${ownerDid}
          AND pm.role IN ('cohost', 'owner', 'host')
          AND pm.removed_at IS NULL
          AND e.status IN ('draft', 'published')
          AND e.starts_at > ${now.toISOString()}
      `;
      cohostRows = podEvents.map((r: any) => ({
        eventId: r.event_id,
        title: r.title,
        startsAt: new Date(r.starts_at),
        endsAt: r.ends_at ? new Date(r.ends_at) : null,
        venue: r.venue,
        accessMode: r.access_mode,
        imageUrl: r.image_url ?? null,
      }));
    } catch (err) {
      console.warn('Failed to fetch cohost events (non-fatal):', err);
    }

    // Deduplicate by eventId
    const seen = new Set<string>();
    const allRows: EventRow[] = [];
    for (const row of [...ticketRows, ...createdRows, ...adminRows, ...cohostRows]) {
      if (!seen.has(row.eventId)) {
        seen.add(row.eventId);
        allRows.push(row);
      }
    }

    // Separate public from invite_only
    const publicEvents = allRows.filter((r) => r.accessMode === 'public');
    const privateEvents = allRows.filter((r) => r.accessMode !== 'public');

    let result = publicEvents;

    // For invite_only events, only include if viewer also has a ticket (or is the owner/admin)
    if (privateEvents.length > 0) {
      // Creator/admin can always see their own private events
      const viewerAllowed = new Set<string>();

      if (viewerDid) {
        const viewerTickets = await db
          .select({ eventId: tickets.eventId })
          .from(tickets)
          .where(
            and(
              eq(tickets.ownerDid, viewerDid),
              inArray(tickets.status, ['sold', 'used']),
              inArray(tickets.eventId, privateEvents.map((r) => r.eventId))
            )
          );
        for (const t of viewerTickets) viewerAllowed.add(t.eventId);
      }

      const allowedPrivate = privateEvents.filter((r) => {
        // The profile owner (creator/admin) always sees their own private events on their own profile
        // Viewers see them if they also hold a ticket
        const isOwnerEvent = createdRows.some((c) => c.eventId === r.eventId)
          || adminRows.some((a) => a.eventId === r.eventId)
          || cohostRows.some((c) => c.eventId === r.eventId);
        return isOwnerEvent || viewerAllowed.has(r.eventId);
      });

      result = [...publicEvents, ...allowedPrivate];
    }

    result.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

    return NextResponse.json(
      result.map((r) => ({
        eventId: r.eventId,
        title: r.title,
        startDate: r.startsAt.toISOString(),
        endDate: r.endsAt ? r.endsAt.toISOString() : null,
        venue: r.venue ?? null,
        imageUrl: r.imageUrl ?? null,
      }))
    );
  } catch (error) {
    console.error('Failed to fetch attending events:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
