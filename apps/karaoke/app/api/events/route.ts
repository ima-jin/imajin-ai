import { NextRequest, NextResponse } from 'next/server';
import { db, events } from '@/db';
import { desc, gte } from 'drizzle-orm';
import { generateSlug } from '@/lib/utils';

// GET /api/events - List active/upcoming events
export async function GET() {
  try {
    const now = new Date();
    // Show events that haven't ended yet (or have no end time and started within last 24h)
    const activeEvents = await db
      .select()
      .from(events)
      .where(gte(events.startTime, new Date(now.getTime() - 24 * 60 * 60 * 1000)))
      .orderBy(desc(events.startTime));
    
    return NextResponse.json(activeEvents);
  } catch (error) {
    console.error('Error fetching events:', error);
    return NextResponse.json({ error: 'Failed to fetch events' }, { status: 500 });
  }
}

// POST /api/events - Create new event
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, location, startTime, endTime } = body;

    if (!name || !startTime) {
      return NextResponse.json(
        { error: 'Name and start time are required' },
        { status: 400 }
      );
    }

    const start = new Date(startTime);
    if (start < new Date()) {
      return NextResponse.json(
        { error: 'Start time cannot be in the past' },
        { status: 400 }
      );
    }

    const slug = generateSlug(name);

    const [newEvent] = await db
      .insert(events)
      .values({
        name,
        slug,
        location: location || null,
        startTime: start,
        endTime: endTime ? new Date(endTime) : null,
      })
      .returning();

    return NextResponse.json(newEvent, { status: 201 });
  } catch (error) {
    console.error('Error creating event:', error);
    return NextResponse.json({ error: 'Failed to create event' }, { status: 500 });
  }
}
