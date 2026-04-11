import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { createEmitter } from '@imajin/events';
import { revalidatePath } from 'next/cache';

const log = createLogger('events');
const eventBus = createEmitter('events');
import { db, events, ticketTypes } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { isEventOrganizer } from '@/src/lib/organizer';
import { eq } from 'drizzle-orm';

/**
 * GET /api/events/[id] - Get event details with ticket types
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { identity } = authResult;
  const did = identity.actingAs || identity.id;
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

    eventBus.emit({ action: 'event.update', did, payload: { eventId: id, status: newStatus } });

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
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { identity } = authResult;
  const did = identity.actingAs || identity.id;
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
    const {
      title,
      description,
      startsAt,
      endsAt,
      locationType,
      isVirtual,
      virtualUrl,
      venue,
      address,
      city,
      country,
      imageUrl,
      imageAssetId,
      tags,
      status,
      metadata,
      nameDisplayPolicy,
    } = body;

    const VALID_NAME_POLICIES = ['real_name', 'handle', 'anonymous', 'attendee_choice'];

    // Build update object with only provided fields
    const updates: Record<string, any> = { updatedAt: new Date() };
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (startsAt !== undefined) updates.startsAt = new Date(startsAt);
    if (endsAt !== undefined) updates.endsAt = endsAt ? new Date(endsAt) : null;
    if (body.timezone !== undefined) updates.timezone = body.timezone;
    if (locationType !== undefined) {
      updates.locationType = locationType;
      updates.isVirtual = locationType !== 'physical';
    } else if (isVirtual !== undefined) {
      updates.isVirtual = isVirtual;
    }
    if (virtualUrl !== undefined) updates.virtualUrl = virtualUrl;
    if (venue !== undefined) updates.venue = venue;
    if (address !== undefined) updates.address = address;
    if (city !== undefined) updates.city = city;
    if (country !== undefined) updates.country = country;
    if (imageUrl !== undefined) updates.imageUrl = imageUrl;
    if (imageAssetId !== undefined) updates.imageAssetId = imageAssetId;
    if (tags !== undefined) updates.tags = tags;
    if (status !== undefined) updates.status = status;
    if (metadata !== undefined) updates.metadata = metadata;
    if (nameDisplayPolicy !== undefined) {
      if (!VALID_NAME_POLICIES.includes(nameDisplayPolicy)) {
        return NextResponse.json({ error: 'Invalid nameDisplayPolicy' }, { status: 400 });
      }
      updates.nameDisplayPolicy = nameDisplayPolicy;
    }
    if (body.accessMode !== undefined) updates.accessMode = body.accessMode;
    if (body.courseSlug !== undefined) updates.courseSlug = body.courseSlug || null;
    if (body.emtEmail !== undefined) updates.emtEmail = body.emtEmail || null;

    const [updated] = await db
      .update(events)
      .set(updates)
      .where(eq(events.id, id))
      .returning();

    // Bust the cache for this event page
    revalidatePath(`/${id}`);

    eventBus.emit({ action: 'event.update', did, payload: { eventId: id } });

    return NextResponse.json({ event: updated });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to update event');
    return NextResponse.json({ error: 'Failed to update event' }, { status: 500 });
  }
}
