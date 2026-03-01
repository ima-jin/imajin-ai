import { NextRequest, NextResponse } from 'next/server';
import { db, ticketQueue, ticketTypes } from '@/src/db';
import { requireAuth } from '@/src/lib/auth';
import { eq, and, max } from 'drizzle-orm';
import { randomBytes } from 'crypto';

/**
 * GET /api/events/[id]/queue - Check queue position
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { identity } = authResult;
  const { searchParams } = new URL(request.url);
  const ticketTypeId = searchParams.get('ticketTypeId');

  if (!ticketTypeId) {
    return NextResponse.json({ error: 'ticketTypeId is required' }, { status: 400 });
  }

  try {
    // Find user's position in queue
    const [entry] = await db
      .select()
      .from(ticketQueue)
      .where(and(
        eq(ticketQueue.ticketTypeId, ticketTypeId),
        eq(ticketQueue.did, identity.id),
        eq(ticketQueue.status, 'waiting')
      ))
      .limit(1);

    if (!entry) {
      return NextResponse.json({ 
        inQueue: false,
        message: 'Not in queue for this ticket type'
      });
    }

    // Count people ahead
    const ahead = await db
      .select()
      .from(ticketQueue)
      .where(and(
        eq(ticketQueue.ticketTypeId, ticketTypeId),
        eq(ticketQueue.status, 'waiting')
      ));

    const position = ahead.filter(e => e.position < entry.position).length + 1;

    return NextResponse.json({
      inQueue: true,
      position,
      totalAhead: position - 1,
      joinedAt: entry.joinedAt,
      status: entry.status,
    });

  } catch (error) {
    console.error('Failed to check queue:', error);
    return NextResponse.json({ error: 'Failed to check queue' }, { status: 500 });
  }
}

/**
 * POST /api/events/[id]/queue - Join the queue
 */
export async function POST(
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
    const body = await request.json();
    const { ticketTypeId } = body;

    if (!ticketTypeId) {
      return NextResponse.json({ error: 'ticketTypeId is required' }, { status: 400 });
    }

    // Check ticket type exists and belongs to this event
    const [ticketType] = await db
      .select()
      .from(ticketTypes)
      .where(and(
        eq(ticketTypes.id, ticketTypeId),
        eq(ticketTypes.eventId, id)
      ))
      .limit(1);

    if (!ticketType) {
      return NextResponse.json({ error: 'Ticket type not found' }, { status: 404 });
    }

    // Check if already in queue
    const [existing] = await db
      .select()
      .from(ticketQueue)
      .where(and(
        eq(ticketQueue.ticketTypeId, ticketTypeId),
        eq(ticketQueue.did, identity.id),
        eq(ticketQueue.status, 'waiting')
      ))
      .limit(1);

    if (existing) {
      return NextResponse.json({ 
        error: 'Already in queue',
        position: existing.position
      }, { status: 409 });
    }

    // Get next position
    const [maxPos] = await db
      .select({ maxPosition: max(ticketQueue.position) })
      .from(ticketQueue)
      .where(eq(ticketQueue.ticketTypeId, ticketTypeId));

    const nextPosition = (maxPos?.maxPosition || 0) + 1;

    // Join queue
    const queueId = `q_${randomBytes(8).toString('hex')}`;

    const [entry] = await db.insert(ticketQueue).values({
      id: queueId,
      ticketTypeId,
      did: identity.id,
      position: nextPosition,
      status: 'waiting',
    }).returning();

    return NextResponse.json({
      entry,
      position: nextPosition,
      message: `You are #${nextPosition} in the queue`
    }, { status: 201 });

  } catch (error) {
    console.error('Failed to join queue:', error);
    return NextResponse.json({ error: 'Failed to join queue' }, { status: 500 });
  }
}

/**
 * DELETE /api/events/[id]/queue - Leave the queue
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { identity } = authResult;
  const { searchParams } = new URL(request.url);
  const ticketTypeId = searchParams.get('ticketTypeId');

  if (!ticketTypeId) {
    return NextResponse.json({ error: 'ticketTypeId is required' }, { status: 400 });
  }

  try {
    const result = await db
      .delete(ticketQueue)
      .where(and(
        eq(ticketQueue.ticketTypeId, ticketTypeId),
        eq(ticketQueue.did, identity.id),
        eq(ticketQueue.status, 'waiting')
      ))
      .returning();

    if (result.length === 0) {
      return NextResponse.json({ error: 'Not in queue' }, { status: 404 });
    }

    return NextResponse.json({ message: 'Left the queue' });

  } catch (error) {
    console.error('Failed to leave queue:', error);
    return NextResponse.json({ error: 'Failed to leave queue' }, { status: 500 });
  }
}
