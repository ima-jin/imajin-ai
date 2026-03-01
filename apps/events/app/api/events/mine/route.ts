import { NextRequest, NextResponse } from 'next/server';
import { db, events, ticketTypes } from '@/src/db';
import { requireAuth } from '@/src/lib/auth';
import { eq, desc, sql } from 'drizzle-orm';

/**
 * GET /api/events/mine - Get all events created by authenticated user
 */
export async function GET(request: NextRequest) {
  // Require authentication
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { identity } = authResult;

  try {
    // Get all events created by this user
    const userEvents = await db
      .select()
      .from(events)
      .where(eq(events.creatorDid, identity.id))
      .orderBy(desc(events.createdAt));

    // For each event, get ticket types and calculate sold/revenue
    const eventsWithStats = await Promise.all(
      userEvents.map(async (event) => {
        const types = await db
          .select()
          .from(ticketTypes)
          .where(eq(ticketTypes.eventId, event.id));

        const totalTicketsSold = types.reduce((sum, t) => sum + (t.sold || 0), 0);
        const totalRevenue = types.reduce((sum, t) => sum + (t.sold || 0) * t.price, 0);

        // Determine status badge
        let statusBadge = event.status;
        const now = new Date();
        const eventDate = new Date(event.startsAt);

        if (event.status === 'published') {
          if (eventDate < now) {
            statusBadge = 'past';
          } else {
            statusBadge = 'live';
          }
        }

        return {
          ...event,
          ticketsSold: totalTicketsSold,
          revenue: totalRevenue,
          statusBadge,
          ticketTypes: types,
        };
      })
    );

    return NextResponse.json({ events: eventsWithStats });
  } catch (error) {
    console.error('Failed to fetch user events:', error);
    return NextResponse.json({ error: 'Failed to fetch events' }, { status: 500 });
  }
}
