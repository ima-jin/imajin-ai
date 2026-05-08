/**
 * POST /api/checkout/etransfer
 *
 * Creates an e-Transfer hold on N tickets (default 1) of one ticket type.
 * All N tickets are grouped under a single order with one memo (ORD-{orderId}).
 * Returns payment instructions for one combined e-Transfer.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withLogger } from '@imajin/logger';
import { db, events, ticketTypes, tickets, orders, eventInvites } from '@/src/db';
import { eq, and, lt } from 'drizzle-orm';
import { optionalAuth } from '@imajin/auth';
import { randomBytes } from 'crypto';

const AUTH_URL = process.env.AUTH_SERVICE_URL || process.env.AUTH_URL || 'http://localhost:3001';
const HOLD_HOURS = 72;
const MAX_QUANTITY = 20;

interface ETransferCheckoutRequest {
  eventId: string;
  ticketTypeId: string;
  quantity?: number;
  email?: string;
  name?: string;
  invite?: string;
}

/**
 * Create or retrieve a soft DID session from email (same pattern as webhook ticket creation).
 */
async function getOrCreateSoftDid(email: string, name?: string): Promise<string> {
  const response = await fetch(`${AUTH_URL}/api/session/soft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email.toLowerCase().trim(), name }),
  });
  if (!response.ok) {
    throw new Error(`Soft DID creation failed: ${response.status}`);
  }
  const data = await response.json();
  return data.did;
}

export const POST = withLogger('events', async (request, { log }) => {
  // Try session auth first (logged-in user), but don't require it
  const session = await optionalAuth(request);

  // We'll resolve identity after parsing body (may need email fallback)

  try {
    const body: ETransferCheckoutRequest = await request.json();

    if (!body.eventId || !body.ticketTypeId) {
      return NextResponse.json({ error: 'eventId and ticketTypeId are required' }, { status: 400 });
    }

    const quantity = Math.max(1, Math.min(MAX_QUANTITY, Math.floor(body.quantity ?? 1)));

    // Resolve identity: session cookie (hard or soft DID) → email fallback → 401
    let ownerDid: string;
    let ownerEmail: string | undefined = body.email;

    if (session) {
      ownerDid = session.id;
    } else if (body.email) {
      ownerDid = await getOrCreateSoftDid(body.email, body.name);
      ownerEmail = body.email;
    } else {
      return NextResponse.json(
        { error: 'Not authenticated. Please log in or provide an email address.' },
        { status: 401 }
      );
    }

    // Fetch event
    const [event] = await db.select().from(events).where(eq(events.id, body.eventId)).limit(1);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    if (event.status !== 'published') {
      return NextResponse.json({ error: 'Tickets are not available for this event' }, { status: 400 });
    }

    const etransferEmail = (event as any).emtEmail;
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

    // Check if user already has an active e-transfer hold order for this ticket type
    const [existingOrder] = await db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.ticketTypeId, body.ticketTypeId),
          eq(orders.buyerDid, ownerDid),
          eq(orders.status, 'pending'),
          eq(orders.paymentMethod, 'etransfer')
        )
      )
      .limit(1);

    if (existingOrder) {
      // Return existing hold instructions — don't create another order while one is open.
      // Pull the earliest hold deadline from the linked tickets.
      const heldTickets = await db
        .select()
        .from(tickets)
        .where(eq(tickets.orderId, existingOrder.id));
      const earliestDeadline = heldTickets
        .map((t) => t.holdExpiresAt)
        .filter((d): d is Date => !!d)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      const memo = `ORD-${existingOrder.id}`;
      const amount = existingOrder.amountTotal / 100;
      return NextResponse.json({
        orderId: existingOrder.id,
        ticketIds: heldTickets.map((t) => t.id),
        instructions: {
          email: etransferEmail,
          amount,
          currency: existingOrder.currency,
          memo,
          deadline: earliestDeadline,
          quantity: existingOrder.quantity,
          message: `Your ${existingOrder.quantity} ticket${existingOrder.quantity > 1 ? 's are' : ' is'} reserved. Send one e-Transfer for the full amount; once we confirm it, your tickets will be activated.`,
        },
      });
    }

    // Release expired holds for this ticket type (frees inventory)
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

    // Check availability for the requested quantity
    if (ticketType.quantity !== null) {
      const available = ticketType.quantity - (ticketType.sold ?? 0);
      if (available < quantity) {
        return NextResponse.json(
          { error: `Only ${available} ticket${available !== 1 ? 's' : ''} available` },
          { status: 409 }
        );
      }
    }

    const holdUntil = new Date();
    holdUntil.setHours(holdUntil.getHours() + HOLD_HOURS);

    const orderId = `ord_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
    const totalAmount = ticketType.price * quantity;

    // Create the order (pending) and N held tickets in sequence.
    // Drizzle's postgres-js client doesn't expose a transaction helper here,
    // but failures will leave a pending order with fewer tickets than expected;
    // the existingOrder branch above will pick it up on retry. Acceptable for
    // an MVP — tighten with a real tx if it becomes an issue.
    const [order] = await db
      .insert(orders)
      .values({
        id: orderId,
        eventId: body.eventId,
        ticketTypeId: body.ticketTypeId,
        buyerDid: ownerDid,
        quantity,
        amountTotal: totalAmount,
        currency: ticketType.currency,
        paymentMethod: 'etransfer',
        status: 'pending',
        metadata: {},
      })
      .returning();

    const ticketRows: { id: string; eventId: string; ticketTypeId: string; ownerDid: string; orderId: string; originalOwnerDid: string; pricePaid: number; currency: string; status: 'held'; heldBy: string; heldUntil: Date; holdExpiresAt: Date; paymentMethod: 'etransfer'; registrationStatus: string; metadata: Record<string, unknown> }[] = [];
    for (let i = 0; i < quantity; i++) {
      ticketRows.push({
        id: `tkt_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}_${i}`,
        eventId: body.eventId,
        ticketTypeId: body.ticketTypeId,
        ownerDid: ownerDid,
        orderId: order.id,
        originalOwnerDid: ownerDid,
        pricePaid: ticketType.price,
        currency: ticketType.currency,
        status: 'held',
        heldBy: ownerDid,
        heldUntil: holdUntil,
        holdExpiresAt: holdUntil,
        paymentMethod: 'etransfer',
        registrationStatus: ticketType.requiresRegistration ? 'pending' : 'not_required',
        metadata: {},
      });
    }
    const insertedTickets = await db.insert(tickets).values(ticketRows).returning();

    const memo = `ORD-${order.id}`;
    const amount = totalAmount / 100;

    return NextResponse.json(
      {
        orderId: order.id,
        ticketIds: insertedTickets.map((t) => t.id),
        instructions: {
          email: etransferEmail,
          amount,
          currency: ticketType.currency,
          memo,
          deadline: holdUntil,
          quantity,
          message: quantity > 1
            ? `Your ${quantity} tickets are reserved. Send one e-Transfer for the full amount; once we confirm it, all ${quantity} tickets will be activated.`
            : `Your ticket is reserved. Once we confirm your e-Transfer, your ticket will be activated.`,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    log.error({ err: String(error) }, 'e-Transfer checkout error');
    return NextResponse.json(
      { error: 'Failed to process e-Transfer' },
      { status: 500 }
    );
  }
});
