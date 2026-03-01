import { NextRequest, NextResponse } from 'next/server';
import { db, events, ticketTypes, eventAdmins } from '@/src/db';
import { requireAuth } from '@/src/lib/auth';
import { eq, and } from 'drizzle-orm';

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

    // Get admins
    const admins = await db
      .select()
      .from(eventAdmins)
      .where(eq(eventAdmins.eventId, id));

    return NextResponse.json({
      event,
      ticketTypes: types.map(t => ({
        ...t,
        available: t.quantity ? t.quantity - (t.sold || 0) : null,
      })),
      admins,
    });
  } catch (error) {
    console.error('Failed to get event:', error);
    return NextResponse.json({ error: 'Failed to get event' }, { status: 500 });
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

    // Check authorization: must be creator or admin
    const isCreator = event.creatorDid === identity.id;
    
    let isAdmin = false;
    if (!isCreator) {
      const [admin] = await db
        .select()
        .from(eventAdmins)
        .where(and(
          eq(eventAdmins.eventId, id),
          eq(eventAdmins.did, identity.id)
        ))
        .limit(1);
      isAdmin = !!admin;
    }

    if (!isCreator && !isAdmin) {
      return NextResponse.json({ error: 'Not authorized to update this event' }, { status: 403 });
    }

    const body = await request.json();
    const {
      title,
      description,
      startsAt,
      endsAt,
      isVirtual,
      virtualUrl,
      venue,
      address,
      city,
      country,
      imageUrl,
      tags,
      status,
    } = body;

    // Build update object with only provided fields
    const updates: Record<string, any> = { updatedAt: new Date() };
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (startsAt !== undefined) updates.startsAt = new Date(startsAt);
    if (endsAt !== undefined) updates.endsAt = endsAt ? new Date(endsAt) : null;
    if (isVirtual !== undefined) updates.isVirtual = isVirtual;
    if (virtualUrl !== undefined) updates.virtualUrl = virtualUrl;
    if (venue !== undefined) updates.venue = venue;
    if (address !== undefined) updates.address = address;
    if (city !== undefined) updates.city = city;
    if (country !== undefined) updates.country = country;
    if (imageUrl !== undefined) updates.imageUrl = imageUrl;
    if (tags !== undefined) updates.tags = tags;
    if (status !== undefined) updates.status = status;

    const [updated] = await db
      .update(events)
      .set(updates)
      .where(eq(events.id, id))
      .returning();

    return NextResponse.json({ event: updated });
  } catch (error) {
    console.error('Failed to update event:', error);
    return NextResponse.json({ error: 'Failed to update event' }, { status: 500 });
  }
}
