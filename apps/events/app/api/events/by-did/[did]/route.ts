/**
 * GET /api/events/by-did/[did]
 * Look up an event by its DID. Used by chat service to resolve event names.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { db, events } from '@/src/db';

const log = createLogger('events');
import { eq } from 'drizzle-orm';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const { did } = await params;
  const decoded = decodeURIComponent(did);

  try {
    const [event] = await db
      .select({ id: events.id, title: events.title, did: events.did })
      .from(events)
      .where(eq(events.did, decoded))
      .limit(1);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    return NextResponse.json({ event });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to look up event by DID');
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
