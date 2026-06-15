/**
 * POST /api/campaign/{eventId}/cancel
 *
 * Cancel a campaign and all pending/confirmed pledges.
 * Requires campaign creator auth.
 *
 * Response:
 * {
 *   cancelled: number
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { db, events, pledges } from '@/src/db';
import { eq, and, sql } from 'drizzle-orm';
import { corsHeaders, rateLimit, getClientIP } from '@imajin/config';
import { withLogger } from '@imajin/logger';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const POST = withLogger('events', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 10, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } }
    );
  }

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status, headers: cors }
    );
  }

  const did = authResult.identity.actingAs || authResult.identity.id;

  try {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/');
    const eventId = pathParts.at(-2); // /api/campaign/{eventId}/cancel

    if (!eventId) {
      return NextResponse.json({ error: 'eventId is required' }, { status: 400, headers: cors });
    }

    // Fetch event
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404, headers: cors });
    }

    if (event.eventType !== 'campaign') {
      return NextResponse.json({ error: 'Not a campaign event' }, { status: 400, headers: cors });
    }

    if (event.creatorDid !== did) {
      return NextResponse.json(
        { error: 'Only the campaign creator can cancel' },
        { status: 403, headers: cors }
      );
    }

    // Cancel all pending and confirmed pledges
    const cancelledPledges = await db
      .select({ id: pledges.id })
      .from(pledges)
      .where(
        and(
          eq(pledges.eventId, eventId),
          sql`${pledges.status} IN ('pending', 'confirmed')`
        )
      );

    for (const p of cancelledPledges) {
      await db
        .update(pledges)
        .set({ status: 'cancelled' })
        .where(eq(pledges.id, p.id));
    }

    // Also mark the event as cancelled
    await db
      .update(events)
      .set({ status: 'cancelled' })
      .where(eq(events.id, eventId));

    const cancelledCount = cancelledPledges.length;

    return NextResponse.json({ cancelled: cancelledCount }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Campaign cancel error');
    return NextResponse.json(
      { error: 'Failed to cancel campaign' },
      { status: 500, headers: cors }
    );
  }
});
