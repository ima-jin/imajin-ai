/**
 * GET /api/campaign/{eventId}/status
 *
 * Public endpoint — returns campaign funding status.
 *
 * Response:
 * {
 *   targetAmount: number,
 *   currentAmount: number,
 *   pledgeCount: number,
 *   deadline: string | null,
 *   percentFunded: number,
 *   isFullyFunded: boolean
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, events, pledges } from '@/src/db';
import { eq, and, sql } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { withLogger } from '@imajin/logger';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const GET = withLogger('events', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  try {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/');
    const eventId = pathParts[pathParts.length - 2]; // /api/campaign/{eventId}/status

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

    // Sum confirmed + charged pledges
    const pledgeRows = await db
      .select({
        totalAmount: sql<number>`COALESCE(SUM(${pledges.amount}), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(pledges)
      .where(
        and(
          eq(pledges.eventId, eventId),
          sql`${pledges.status} IN ('confirmed', 'charged')`
        )
      );

    const currentAmount = pledgeRows[0]?.totalAmount ?? 0;
    const pledgeCount = pledgeRows[0]?.count ?? 0;
    const targetAmount = event.targetAmount ?? 0;

    const percentFunded = targetAmount > 0
      ? Math.min(100, Math.floor((currentAmount / targetAmount) * 100))
      : 0;

    return NextResponse.json({
      targetAmount,
      currentAmount,
      pledgeCount,
      deadline: event.deadline ? new Date(event.deadline).toISOString() : null,
      percentFunded,
      isFullyFunded: currentAmount >= targetAmount,
    }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Campaign status error');
    return NextResponse.json(
      { error: 'Failed to get campaign status' },
      { status: 500, headers: cors }
    );
  }
});
