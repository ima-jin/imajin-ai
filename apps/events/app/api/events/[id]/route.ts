import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { revalidatePath } from 'next/cache';
import { buildEventUpdates, syncNamePolicyToChat } from '@/src/lib/event-update-helpers';

const log = createLogger('events');

import { db, events, ticketTypes } from '@/src/db';
import { requireAuth, requireAppAuth , resolveActingDid } from '@imajin/auth';
import { corsHeaders } from '@imajin/config';
import { isEventOrganizer } from '@/src/lib/organizer';
import { eq } from 'drizzle-orm';

/** Fields safe to return for events:read app scope */
function filterEventForApp(event: Record<string, any>): Record<string, any> {
  const { id, did, creatorDid, title, description, startsAt, endsAt, timezone, locationType, isVirtual, virtualUrl, venue, address, city, country, status, accessMode, imageUrl, imageAssetId, tags, courseSlug, nameDisplayPolicy, chatEnabled, createdAt, updatedAt } = event;
  return { id, did, creatorDid, title, description, startsAt, endsAt, timezone, locationType, isVirtual, virtualUrl, venue, address, city, country, status, accessMode, imageUrl, imageAssetId, tags, courseSlug, nameDisplayPolicy, chatEnabled, createdAt, updatedAt };
}

/**
 * GET /api/events/[id] - Get event details with ticket types
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const cors = corsHeaders(request);

  // App auth path
  if (request.headers.get('x-app-did')) {
    const appResult = await requireAppAuth(request, { scope: 'events:read' });
    if ('error' in appResult) {
      return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
    }
    try {
      const { id } = await params;
      const [event] = await db
        .select()
        .from(events)
        .where(eq(events.id, id))
        .limit(1);

      if (!event) {
        return NextResponse.json({ error: 'Event not found' }, { status: 404, headers: cors });
      }

      // Get ticket types with availability
      const types = await db
        .select()
        .from(ticketTypes)
        .where(eq(ticketTypes.eventId, id));

      return NextResponse.json({
        event: filterEventForApp(event as Record<string, any>),
        ticketTypes: types.map(t => ({
          ...t,
          available: t.quantity ? t.quantity - (t.sold || 0) : null,
        })),
      }, { headers: cors });
    } catch (error) {
      log.error({ err: String(error) }, 'Failed to get event (app auth)');
      return NextResponse.json({ error: 'Failed to get event' }, { status: 500, headers: cors });
    }
  }

  try {
    const { id } = await params;
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, id))
      .limit(1);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Get ticket types with availability
    const types = await db
      .select()
      .from(ticketTypes)
      .where(eq(ticketTypes.eventId, id));

    return NextResponse.json({
      event,
      ticketTypes: types.map(t => ({
        ...t,
        available: t.quantity ? t.quantity - (t.sold || 0) : null,
      })),
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to get event');
    return NextResponse.json({ error: 'Failed to get event' }, { status: 500 });
  }
}

const VALID_STATUSES = ['draft', 'published', 'paused', 'cancelled', 'completed'] as const;
type EventStatus = typeof VALID_STATUSES[number];

const STATUS_TRANSITIONS: Record<EventStatus, EventStatus[]> = {
  draft: ['published'],
  published: ['paused', 'cancelled', 'completed'],
  paused: ['published', 'cancelled'],
  cancelled: [],
  completed: [],
};

/**
 * PATCH /api/events/[id] - Update event status (requires auth as creator only)
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const cors = corsHeaders(request);
  let did: string;

  // App auth path
  if (request.headers.get('x-app-did')) {
    const appResult = await requireAppAuth(request, { scope: 'events:write' });
    if ('error' in appResult) {
      return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
    }
    did = appResult.appAuth.userDid;
  } else {
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const { identity } = authResult;
    did = resolveActingDid(identity);
  }

  const { id } = await params;

  try {
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, id))
      .limit(1);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    if (event.creatorDid !== did) {
      return NextResponse.json({ error: 'Only the event creator can change status' }, { status: 403 });
    }

    const body = await request.json();
    const { status: newStatus } = body;

    if (!newStatus || !VALID_STATUSES.includes(newStatus)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }

    const currentStatus = (event.status || 'draft') as EventStatus;
    const allowed = STATUS_TRANSITIONS[currentStatus] || [];

    if (!allowed.includes(newStatus as EventStatus)) {
      return NextResponse.json(
        { error: `Cannot transition from "${currentStatus}" to "${newStatus}"` },
        { status: 400 }
      );
    }

    const [updated] = await db
      .update(events)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(eq(events.id, id))
      .returning();

    revalidatePath(`/${id}`);
    revalidatePath('/');

    publish('event.update', {
      issuer: did,
      subject: did,
      scope: 'events',
      payload: { eventId: id, status: newStatus },
    }).catch((err) => log.error({ err: String(err) }, 'Publish error'));

    return NextResponse.json({ event: updated });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to update event status');
    return NextResponse.json({ error: 'Failed to update event status' }, { status: 500 });
  }
}

/**
 * PUT /api/events/[id] - Update event (requires auth as creator or admin)
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const cors = corsHeaders(request);
  let did: string;

  // App auth path
  if (request.headers.get('x-app-did')) {
    const appResult = await requireAppAuth(request, { scope: 'events:write' });
    if ('error' in appResult) {
      return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
    }
    did = appResult.appAuth.userDid;
  } else {
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const { identity } = authResult;
    did = resolveActingDid(identity);
  }

  const { id } = await params;

  try {
    // Check event exists
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, id))
      .limit(1);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Check authorization: must be creator, admin, or cohost
    const orgCheck = await isEventOrganizer(id, did);
    if (!orgCheck.authorized) {
      return NextResponse.json({ error: 'Not authorized to update this event' }, { status: 403 });
    }

    const body = await request.json();

    // Build update object — validates nameDisplayPolicy when present
    const updatesResult = buildEventUpdates(body);
    if ('error' in updatesResult) {
      const { error, status } = updatesResult as { error: string; status: number };
      return NextResponse.json({ error }, { status });
    }

    const [updated] = await db
      .update(events)
      .set(updatesResult)
      .where(eq(events.id, id))
      .returning();

    // Sync name display policy to chat conversation context if it changed
    const CHAT_URL = process.env.CHAT_SERVICE_URL || process.env.CHAT_URL;
    if (body.nameDisplayPolicy !== undefined && updated && CHAT_URL) {
      await syncNamePolicyToChat(CHAT_URL, updated.did, body.nameDisplayPolicy);
    }

    // Bust the cache for this event page
    revalidatePath(`/${id}`);

    publish('event.update', {
      issuer: did,
      subject: did,
      scope: 'events',
      payload: { eventId: id },
    }).catch((err) => log.error({ err: String(err) }, 'Publish error'));

    return NextResponse.json({ event: updated });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to update event');
    return NextResponse.json({ error: 'Failed to update event' }, { status: 500 });
  }
}
