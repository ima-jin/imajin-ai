import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { requireAppAuth } from '@imajin/auth';
import { corsHeaders } from '@imajin/config';
import { db, tickets, events } from '@/src/db';
import { and, eq, inArray } from 'drizzle-orm';

const log = createLogger('events');

export const dynamic = 'force-dynamic';

/** Ticket statuses that count as "holds a ticket" (matches /api/attending/[did]). */
const HOLDING_STATUSES = ['sold', 'used'];

/**
 * GET /api/events/:id/access?did=<did> — composable ticket-holder gate (#2395).
 *
 * Answers one question for third-party apps: "does DID X hold a ticket for
 * event Y?" The response is ALWAYS exactly `{ "hasAccess": boolean }` — never
 * a ticket id, type, price, organizer, or any other row data. Callers never
 * read ticket data; the events app only answers the boolean.
 *
 * Auth: a scoped app token (`Authorization: Bearer`) carrying `events:read`.
 * Session cookies are NOT accepted.
 *   - 401 no / invalid / expired bearer token
 *   - 403 valid token without the `events:read` scope
 *   - 400 missing `did` query parameter
 *   - 404 unknown event
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const cors = corsHeaders(request);

  if (!request.headers.get('authorization')?.startsWith('Bearer ')) {
    return NextResponse.json(
      { error: 'Authorization: Bearer <app-token> required' },
      { status: 401, headers: cors }
    );
  }

  const appResult = await requireAppAuth(request, { scope: 'events:read' });
  if ('error' in appResult) {
    return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
  }

  const did = request.nextUrl.searchParams.get('did')?.trim();
  if (!did) {
    return NextResponse.json({ error: 'did query parameter required' }, { status: 400, headers: cors });
  }

  const { id: eventId } = await params;

  try {
    const [event] = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404, headers: cors });
    }

    const [holding] = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(
          eq(tickets.eventId, eventId),
          eq(tickets.ownerDid, did),
          inArray(tickets.status, HOLDING_STATUSES)
        )
      )
      .limit(1);

    return NextResponse.json({ hasAccess: Boolean(holding) }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to evaluate ticket-holder gate');
    return NextResponse.json({ error: 'Access check failed' }, { status: 500, headers: cors });
  }
}
