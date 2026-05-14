/**
 * GET /api/campaign/{eventId}/pledges
 *
 * Returns all pledges for a campaign event.
 * Requires campaign creator auth.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { db, events, pledges } from '@/src/db';
import { eq } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { withLogger } from '@imajin/logger';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const GET = withLogger('events', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

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
    const eventId = pathParts[pathParts.length - 2]; // /api/campaign/{eventId}/pledges

    if (!eventId) {
      return NextResponse.json({ error: 'eventId is required' }, { status: 400, headers: cors });
    }

    // Fetch event and verify creator
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404, headers: cors });
    }

    if (event.creatorDid !== did) {
      return NextResponse.json(
        { error: 'Only the campaign creator can view pledges' },
        { status: 403, headers: cors }
      );
    }

    const pledgeList = await db
      .select()
      .from(pledges)
      .where(eq(pledges.eventId, eventId))
      .orderBy(pledges.createdAt);

    return NextResponse.json({ pledges: pledgeList }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Campaign pledges error');
    return NextResponse.json(
      { error: 'Failed to get pledges' },
      { status: 500, headers: cors }
    );
  }
});
