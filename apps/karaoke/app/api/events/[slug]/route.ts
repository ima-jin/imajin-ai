import { NextRequest, NextResponse } from 'next/server';
import { db, events, participants } from '@/db';
import { eq, asc } from 'drizzle-orm';

// GET /api/events/[slug] - Get event with participants
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params;
    
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.slug, slug));

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    const eventParticipants = await db
      .select()
      .from(participants)
      .where(eq(participants.eventId, event.id))
      .orderBy(asc(participants.position));

    return NextResponse.json({ ...event, participants: eventParticipants });
  } catch (error) {
    console.error('Error fetching event:', error);
    return NextResponse.json({ error: 'Failed to fetch event' }, { status: 500 });
  }
}

// PATCH /api/events/[slug] - Update event
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params;
    const body = await request.json();
    const { name, location, startTime, endTime } = body;

    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.slug, slug));

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    const updateData: Record<string, unknown> = {};
    if (name) updateData.name = name;
    if (location !== undefined) updateData.location = location;
    if (startTime) updateData.startTime = new Date(startTime);
    if (endTime !== undefined) updateData.endTime = endTime ? new Date(endTime) : null;

    const [updatedEvent] = await db
      .update(events)
      .set(updateData)
      .where(eq(events.slug, slug))
      .returning();

    return NextResponse.json(updatedEvent);
  } catch (error) {
    console.error('Error updating event:', error);
    return NextResponse.json({ error: 'Failed to update event' }, { status: 500 });
  }
}
