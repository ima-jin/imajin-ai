/**
 * POST /api/checkout/etransfer
 *
 * Creates an e-Transfer hold on a ticket.
 * Returns payment instructions instead of a Stripe URL.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, events, ticketTypes, tickets, eventInvites } from '@/src/db';
import { eq, and, lt } from 'drizzle-orm';
import { requireAuth } from '@/src/lib/auth';
import { getClient } from '@imajin/db';
import { randomBytes } from 'crypto';

const sql = getClient();
const HOLD_HOURS = 72;

interface ETransferCheckoutRequest {
  eventId: string;
  ticketTypeId: string;
  invite?: string;
}

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { identity } = authResult;

  try {
    const body: ETransferCheckoutRequest = await request.json();

    if (!body.eventId || !body.ticketTypeId) {
      return NextResponse.json({ error: 'eventId and ticketTypeId are required' }, { status: 400 });
    }

    // Fetch event
    const [event] = await db.select().from(events).where(eq(events.id, body.eventId)).limit(1);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    if (event.status !== 'published') {
      return NextResponse.json({ error: 'Tickets are not available for this event' }, { status: 400 });
    }

    // Look up organizer's e-transfer email from their profile
    const [creatorProfile] = await sql`
      SELECT email FROM profile.profiles WHERE did = ${event.creatorDid}
    `;
    const etransferEmail = creatorProfile?.email;
    if (!etransferEmail) {
      return NextResponse.json({ error: 'e-Transfer is not available for this event' }, { status: 400 });
    }

    // Invite-only access check
    if (event.accessMode === 'invite_only') {
      const token = body.invite || request.nextUrl.searchParams.get('invite');
      if (!token) {
        return NextResponse.json({ error: 'This event requires an invite link' }, { status: 403 });
      }

      const [invite] = await db
        .select()
        .from(eventInvites)
        .where(and(eq(eventInvites.eventId, body.eventId), eq(eventInvites.token, token)))
        .limit(1);

      if (!invite) {
        return NextResponse.json({ error: 'Invalid invite token' }, { status: 403 });
      }

      if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
        return NextResponse.json({ error: 'This invite link has expired' }, { status: 403 });
      }

      if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) {
        return NextResponse.json({ error: 'This invite link has reached its maximum uses' }, { status: 403 });
      }
    }

    // Fetch ticket type
    const [ticketType] = await db
      .select()
      .from(ticketTypes)
      .where(and(eq(ticketTypes.id, body.ticketTypeId), eq(ticketTypes.eventId, body.eventId)))
      .limit(1);

    if (!ticketType) {
      return NextResponse.json({ error: 'Ticket type not found' }, { status: 404 });
    }

    // Check if user already has an active e-transfer hold for this ticket type
    const [existingHold] = await db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.ticketTypeId, body.ticketTypeId),
          eq(tickets.ownerDid, identity.id),
          eq(tickets.status, 'held')
        )
      )
      .limit(1);

    if (existingHold) {
      // Return existing hold instructions
      const memo = `TKT-${existingHold.id}`;
      const amount = ticketType.price / 100;
      return NextResponse.json({
        ticketId: existingHold.id,
        instructions: {
          email: etransferEmail,
          amount,
          currency: ticketType.currency,
          memo,
          deadline: existingHold.holdExpiresAt,
          message: `Your ticket is reserved. Once we confirm your e-Transfer, your ticket will be activated.`,
        },
      });
    }

    // Release expired holds for this ticket type
    await db
      .update(tickets)
      .set({ status: 'available', heldBy: null, heldUntil: null })
      .where(
        and(
          eq(tickets.ticketTypeId, body.ticketTypeId),
          eq(tickets.status, 'held'),
          lt(tickets.heldUntil, new Date())
        )
      );

    // Check availability
    if (ticketType.quantity !== null) {
      const available = ticketType.quantity - (ticketType.sold ?? 0);
      if (available < 1) {
        return NextResponse.json({ error: 'No tickets available' }, { status: 409 });
      }
    }

    // Create held ticket
    const holdUntil = new Date();
    holdUntil.setHours(holdUntil.getHours() + HOLD_HOURS);

    const ticketId = `tkt_${randomBytes(12).toString('hex')}`;
    const magicToken = randomBytes(32).toString('hex');

    const [ticket] = await db
      .insert(tickets)
      .values({
        id: ticketId,
        eventId: body.eventId,
        ticketTypeId: body.ticketTypeId,
        ownerDid: identity.id,
        originalOwnerDid: identity.id,
        pricePaid: ticketType.price,
        currency: ticketType.currency,
        status: 'held',
        heldBy: identity.id,
        heldUntil: holdUntil,
        holdExpiresAt: holdUntil,
        paymentMethod: 'etransfer',
        magicToken,
        metadata: {},
      })
      .returning();

    const memo = `TKT-${ticket.id}`;
    const amount = ticketType.price / 100;

    return NextResponse.json(
      {
        ticketId: ticket.id,
        instructions: {
          email: etransferEmail,
          amount,
          currency: ticketType.currency,
          memo,
          deadline: holdUntil,
          message: `Your ticket is reserved. Once we confirm your e-Transfer, your ticket will be activated.`,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('e-Transfer checkout error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create e-Transfer hold' },
      { status: 500 }
    );
  }
}
