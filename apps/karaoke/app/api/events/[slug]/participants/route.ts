import { NextRequest, NextResponse } from 'next/server';
import { db, events, participants } from '@/db';
import { eq, max } from 'drizzle-orm';

// POST /api/events/[slug]/participants - Sign up for event
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params;
    const body = await request.json();
    const { name, phone } = body;

    if (!name || !name.trim()) {
      return NextResponse.json(
        { error: 'Name is required' },
        { status: 400 }
      );
    }

    // Get the event
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.slug, slug));

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Get the next position
    const [result] = await db
      .select({ maxPosition: max(participants.position) })
      .from(participants)
      .where(eq(participants.eventId, event.id));
    
    const nextPosition = (result?.maxPosition ?? 0) + 1;

    // Create the participant
    const [newParticipant] = await db
      .insert(participants)
      .values({
        eventId: event.id,
        name: name.trim(),
        position: nextPosition,
        status: 'waiting',
        phone: phone || null,
      })
      .returning();

    return NextResponse.json(newParticipant, { status: 201 });
  } catch (error) {
    console.error('Error signing up:', error);
    return NextResponse.json({ error: 'Failed to sign up' }, { status: 500 });
  }
}
