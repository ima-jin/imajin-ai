import { NextRequest, NextResponse } from 'next/server';
import { db, tickets, ticketTypes } from '@/src/db';
import { requireAuth } from '@/src/lib/auth';
import { eq, and, lt } from 'drizzle-orm';
import { randomBytes } from 'crypto';

const DEFAULT_HOLD_HOURS = 72;

/**
 * POST /api/events/[id]/hold - Hold a ticket
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
    const { ticketTypeId, holdHours = DEFAULT_HOLD_HOURS } = body;

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

    // Check if user already has a hold for this ticket type
    const [existingHold] = await db
      .select()
      .from(tickets)
      .where(and(
        eq(tickets.ticketTypeId, ticketTypeId),
        eq(tickets.heldBy, identity.id),
        eq(tickets.status, 'held')
      ))
      .limit(1);

    if (existingHold) {
      return NextResponse.json({ 
        error: 'You already have a hold for this ticket type',
        ticket: existingHold 
      }, { status: 409 });
    }

    // Release any expired holds first
    await db
      .update(tickets)
      .set({ 
        status: 'available', 
        heldBy: null, 
        heldUntil: null 
      })
      .where(and(
        eq(tickets.ticketTypeId, ticketTypeId),
        eq(tickets.status, 'held'),
        lt(tickets.heldUntil, new Date())
      ));

    // Check availability
    const available = ticketType.quantity 
      ? ticketType.quantity - (ticketType.sold || 0)
      : Infinity;

    // Count current holds
    const holds = await db
      .select()
      .from(tickets)
      .where(and(
        eq(tickets.ticketTypeId, ticketTypeId),
        eq(tickets.status, 'held')
      ));

    if (ticketType.quantity && holds.length >= available) {
      return NextResponse.json({ 
        error: 'No tickets available',
        queuePosition: holds.length + 1
      }, { status: 409 });
    }

    // Create the hold
    const holdUntil = new Date();
    holdUntil.setHours(holdUntil.getHours() + holdHours);

    const ticketId = `tkt_${randomBytes(12).toString('hex')}`;

    const [ticket] = await db.insert(tickets).values({
      id: ticketId,
      eventId: id,
      ticketTypeId,
      status: 'held',
      heldBy: identity.id,
      heldUntil: holdUntil,
    }).returning();

    return NextResponse.json({ 
      ticket,
      expiresAt: holdUntil,
      message: `Ticket held for ${holdHours} hours`
    }, { status: 201 });

  } catch (error) {
    console.error('Failed to hold ticket:', error);
    return NextResponse.json({ error: 'Failed to hold ticket' }, { status: 500 });
  }
}

/**
 * DELETE /api/events/[id]/hold - Release a hold
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

  try {
    const { searchParams } = new URL(request.url);
    const ticketId = searchParams.get('ticketId');

    if (!ticketId) {
      return NextResponse.json({ error: 'ticketId is required' }, { status: 400 });
    }

    // Find the held ticket
    const [ticket] = await db
      .select()
      .from(tickets)
      .where(and(
        eq(tickets.id, ticketId),
        eq(tickets.heldBy, identity.id),
        eq(tickets.status, 'held')
      ))
      .limit(1);

    if (!ticket) {
      return NextResponse.json({ error: 'Hold not found or not yours' }, { status: 404 });
    }

    // Release the hold by deleting the ticket record
    await db
      .delete(tickets)
      .where(eq(tickets.id, ticketId));

    return NextResponse.json({ message: 'Hold released' });

  } catch (error) {
    console.error('Failed to release hold:', error);
    return NextResponse.json({ error: 'Failed to release hold' }, { status: 500 });
  }
}
