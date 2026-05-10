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
import { getClient } from '@imajin/db';
import { publish } from '@imajin/bus';
import { getContactEmail, backfillContactEmail } from '@/src/lib/contact-email';

const AUTH_URL = process.env.AUTH_SERVICE_URL || process.env.AUTH_URL || 'http://localhost:3001';
const HOLD_HOURS = 72;
const MAX_QUANTITY = 20;

interface ETransferCartItem {
  ticketTypeId: string;
  quantity: number;
}

interface ETransferCheckoutRequest {
  eventId: string;
  // Legacy single-type payload (still accepted)
  ticketTypeId?: string;
  quantity?: number;
  // Multi-type cart payload
  items?: ETransferCartItem[];
  email?: string;
  name?: string;
  invite?: string;
}

export const POST = withLogger('events', async (request, { log }) => {
  // Try session auth first (logged-in user), but don't require it
  const session = await optionalAuth(request);

  // We'll resolve identity after parsing body (may need email fallback)

  try {
    const body: ETransferCheckoutRequest = await request.json();

    if (!body.eventId) {
      return NextResponse.json({ error: 'eventId is required' }, { status: 400 });
    }

    // Normalize to a cart. Accept either legacy {ticketTypeId, quantity} or {items: [...]}.
    const rawItems: ETransferCartItem[] = body.items && body.items.length > 0
      ? body.items
      : body.ticketTypeId
      ? [{ ticketTypeId: body.ticketTypeId, quantity: body.quantity ?? 1 }]
      : [];

    if (rawItems.length === 0) {
      return NextResponse.json({ error: 'items or ticketTypeId is required' }, { status: 400 });
    }

    // Coalesce duplicates and clamp quantities
    const cartMap = new Map<string, number>();
    for (const item of rawItems) {
      if (!item.ticketTypeId) continue;
      const q = Math.max(1, Math.min(MAX_QUANTITY, Math.floor(item.quantity ?? 1)));
      cartMap.set(item.ticketTypeId, (cartMap.get(item.ticketTypeId) ?? 0) + q);
    }
    const cart: ETransferCartItem[] = Array.from(cartMap.entries()).map(([ticketTypeId, quantity]) => ({
      ticketTypeId,
      quantity: Math.min(MAX_QUANTITY, quantity),
    }));
    const totalQuantity = cart.reduce((sum, c) => sum + c.quantity, 0);

    // Resolve identity: session cookie (hard or soft DID) → email fallback → 401
    let ownerDid: string;
    let ownerEmail: string | undefined = body.email;

    if (session) {
      ownerDid = session.id;

      // Issue #4: backfill contact_email if buyer provided one and identity lacks it
      if (body.email) {
        await backfillContactEmail(ownerDid, body.email, log);
      }

      // Validate we have an email for ticket delivery
      const contactEmail = await getContactEmail(ownerDid, log);
      if (!contactEmail && !body.email) {
        return NextResponse.json(
          { error: 'Email required to send your ticket', field: 'email' },
          { status: 400 }
        );
      }
      if (!ownerEmail && contactEmail) {
        ownerEmail = contactEmail;
      }
    } else if (body.email) {
      // Anonymous buyer with an email but no session: send a magic-link
      // verification email instead of creating a soft DID + hold blindly.
      // This proves the email is real and owned before we reserve inventory
      // or send any reservation email.
      // Tab-A-canonical: redirect goes to a simple affirmation page; cart stays
      // in component state and tab A picks up verification via polling.
      const eventsBase = process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai';
      const redirectUrl = `${eventsBase}/${body.eventId}${
        body.invite ? `?invite=${encodeURIComponent(body.invite)}` : ''
      }`;
      let pollHandle: string | undefined;
      try {
        const onboardRes = await fetch(`${AUTH_URL}/api/onboard`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: body.email,
            name: body.name,
            redirectUrl,
            context: 'reserve your tickets',
            wantPolling: true,
          }),
        });
        if (!onboardRes.ok) {
          const errBody = await onboardRes.text().catch(() => '');
          log.error({ status: onboardRes.status, body: errBody }, 'Magic-link send failed');
          // Issue #13: pass through kernel status codes so the client can show
          // accurate messages (e.g. 429 rate-limit, 410 gone).
          const propagateStatus = onboardRes.status === 429 || onboardRes.status === 410
            ? onboardRes.status
            : 502;
          let message = 'Could not send verification email. Please try again.';
          try {
            const parsed = JSON.parse(errBody);
            if (parsed.error) message = parsed.error;
          } catch { /* ignore parse failure, use generic */ }
          return NextResponse.json({ error: message }, { status: propagateStatus });
        }
        const onboardData = await onboardRes.json();
        pollHandle = onboardData.pollHandle;
      } catch (err) {
        log.error({ err: String(err) }, 'Magic-link send error');
        return NextResponse.json(
          { error: 'Could not send verification email. Please try again.' },
          { status: 502 }
        );
      }
      return NextResponse.json({
        verificationSent: true,
        email: body.email,
        ...(pollHandle ? { pollHandle } : {}),
        message: `We sent a verification link to ${body.email}. Click it to confirm your email and reserve your ticket${totalQuantity > 1 ? 's' : ''}.`,
      });
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

    // Fetch all ticket types for this event in one go (filtered to the cart)
    const ticketTypeIds = cart.map((c) => c.ticketTypeId);
    const fetchedTypes = await db
      .select()
      .from(ticketTypes)
      .where(eq(ticketTypes.eventId, body.eventId));
    const typesById = new Map(fetchedTypes.map((t) => [t.id, t]));

    for (const item of cart) {
      if (!typesById.has(item.ticketTypeId)) {
        return NextResponse.json(
          { error: `Ticket type ${item.ticketTypeId} not found for this event` },
          { status: 404 }
        );
      }
    }

    // All ticket types in a cart must share a currency for one combined transfer
    const currencies = new Set(cart.map((c) => typesById.get(c.ticketTypeId)!.currency));
    if (currencies.size > 1) {
      return NextResponse.json(
        { error: 'All tickets in a cart must use the same currency' },
        { status: 400 }
      );
    }
    const cartCurrency = typesById.get(cart[0].ticketTypeId)!.currency;

    // Look for an existing pending EMT order from this buyer covering exactly
    // the same cart shape (same ticket types in same quantities). If found,
    // return its instructions instead of creating a duplicate hold.
    const existingOrders = await db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.eventId, body.eventId),
          eq(orders.buyerDid, ownerDid),
          eq(orders.status, 'pending'),
          eq(orders.paymentMethod, 'etransfer')
        )
      );

    for (const existing of existingOrders) {
      const heldTickets = await db
        .select()
        .from(tickets)
        .where(eq(tickets.orderId, existing.id));
      // Build the cart shape of the existing order
      const existingCart = new Map<string, number>();
      for (const t of heldTickets) {
        existingCart.set(t.ticketTypeId, (existingCart.get(t.ticketTypeId) ?? 0) + 1);
      }
      // Compare shapes
      const shapeMatches =
        existingCart.size === cartMap.size &&
        Array.from(cartMap.entries()).every(([k, v]) => existingCart.get(k) === v);
      if (!shapeMatches) continue;

      const earliestDeadline = heldTickets
        .map((t) => t.holdExpiresAt)
        .filter((d): d is Date => !!d)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      return NextResponse.json({
        orderId: existing.id,
        ticketIds: heldTickets.map((t) => t.id),
        instructions: {
          email: etransferEmail,
          amount: existing.amountTotal / 100,
          currency: existing.currency,
          memo: `ORD-${existing.id}`,
          deadline: earliestDeadline,
          quantity: existing.quantity,
          message: `Your ${existing.quantity} ticket${existing.quantity > 1 ? 's are' : ' is'} reserved. Send one e-Transfer for the full amount; once we confirm it, your tickets will be activated.`,
        },
      });
    }

    // Release expired holds for any ticket type in the cart (frees inventory).
    for (const item of cart) {
      await db
        .update(tickets)
        .set({ status: 'available', heldBy: null, heldUntil: null })
        .where(
          and(
            eq(tickets.ticketTypeId, item.ticketTypeId),
            eq(tickets.status, 'held'),
            lt(tickets.heldUntil, new Date())
          )
        );
    }

    // Check availability per type
    for (const item of cart) {
      const tt = typesById.get(item.ticketTypeId)!;
      if (tt.quantity !== null) {
        const available = tt.quantity - (tt.sold ?? 0);
        if (available < item.quantity) {
          return NextResponse.json(
            { error: `Only ${available} ${tt.name} ticket${available !== 1 ? 's' : ''} available` },
            { status: 409 }
          );
        }
      }
    }

    const holdUntil = new Date();
    holdUntil.setHours(holdUntil.getHours() + HOLD_HOURS);

    const orderId = `ord_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
    const totalAmount = cart.reduce(
      (sum, item) => sum + typesById.get(item.ticketTypeId)!.price * item.quantity,
      0
    );

    // Create the order (pending) and held tickets in sequence.
    // Drizzle's postgres-js client doesn't expose a transaction helper here,
    // but failures will leave a pending order with fewer tickets than expected;
    // the existingOrder branch above will pick it up on retry. Acceptable for
    // an MVP — tighten with a real tx if it becomes an issue.
    const [order] = await db
      .insert(orders)
      .values({
        id: orderId,
        eventId: body.eventId,
        // Single-type orders keep ticket_type_id set; multi-type orders leave it null.
        ticketTypeId: cart.length === 1 ? cart[0].ticketTypeId : null,
        buyerDid: ownerDid,
        quantity: totalQuantity,
        amountTotal: totalAmount,
        currency: cartCurrency,
        paymentMethod: 'etransfer',
        status: 'pending',
        metadata: cart.length > 1 ? { cart } : {},
        buyerEmail,
      })
      .returning();

    const ticketRows: { id: string; eventId: string; ticketTypeId: string; ownerDid: string; orderId: string; originalOwnerDid: string; pricePaid: number; currency: string; status: 'held'; heldBy: string; heldUntil: Date; holdExpiresAt: Date; paymentMethod: 'etransfer'; registrationStatus: string; metadata: Record<string, unknown> }[] = [];
    let idx = 0;
    for (const item of cart) {
      const tt = typesById.get(item.ticketTypeId)!;
      for (let i = 0; i < item.quantity; i++) {
        ticketRows.push({
          id: `tkt_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}_${idx++}`,
          eventId: body.eventId,
          ticketTypeId: item.ticketTypeId,
          ownerDid: ownerDid,
          orderId: order.id,
          originalOwnerDid: ownerDid,
          pricePaid: tt.price,
          currency: tt.currency,
          status: 'held',
          heldBy: ownerDid,
          heldUntil: holdUntil,
          holdExpiresAt: holdUntil,
          paymentMethod: 'etransfer',
          registrationStatus: tt.requiresRegistration ? 'pending' : 'not_required',
          metadata: {},
        });
      }
    }
    const insertedTickets = await db.insert(tickets).values(ticketRows).returning();

    const memo = `ORD-${order.id}`;
    const amount = totalAmount / 100;

    // Send the buyer a 'reserved — not yet confirmed' email so they have a
    // record of the hold, the memo, and the address to send to. We resolve the
    // buyer's email from auth.identities (contact_email) when not provided in
    // the body, so logged-in buyers get one too.
    let buyerEmail = ownerEmail;
    if (!buyerEmail) {
      try {
        const sql = getClient();
        const rows = await sql<{ contact_email: string | null }[]>`
          SELECT contact_email FROM auth.identities WHERE id = ${ownerDid} LIMIT 1
        `;
        buyerEmail = rows[0]?.contact_email ?? undefined;
      } catch (err) {
        log.warn({ err: String(err) }, 'Failed to resolve buyer email for reservation');
      }
    }

    if (buyerEmail) {
      const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai';
      const eventDate = new Date(event.startsAt);
      const eventImageUrl = event.imageUrl
        ? (event.imageUrl.startsWith('http') ? event.imageUrl : `${EVENTS_URL}${event.imageUrl}`)
        : undefined;
      const summary = cart.map((item) => ({
        typeName: typesById.get(item.ticketTypeId)?.name ?? 'Ticket',
        quantity: item.quantity,
      }));
      const formattedAmount = new Intl.NumberFormat('en-CA', {
        style: 'currency',
        currency: cartCurrency,
      }).format(amount);
      const formattedDeadline = holdUntil.toLocaleString('en-CA', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      });
      publish('ticket.reserved', {
        issuer: ownerDid,
        subject: ownerDid,
        scope: 'events',
        payload: {
          email: buyerEmail,
          eventTitle: event.title,
          eventDate: eventDate.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          }),
          eventTime: eventDate.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            timeZoneName: 'short',
          }),
          ticketSummary: summary,
          totalQuantity,
          amount: formattedAmount,
          payToEmail: etransferEmail,
          memo,
          deadline: formattedDeadline,
          buyerEmail,
          myTicketsUrl: `${EVENTS_URL}/${event.id}`,
          eventImageUrl,
          context_id: event.id,
          context_type: 'event',
        },
      }).catch((err) => log.error({ err: String(err) }, 'Failed to publish ticket reserved event'));
    } else {
      log.warn({ ownerDid, eventId: body.eventId }, 'No buyer email available for reservation; skipping confirmation send');
    }

    return NextResponse.json(
      {
        orderId: order.id,
        ticketIds: insertedTickets.map((t) => t.id),
        instructions: {
          email: etransferEmail,
          amount,
          currency: cartCurrency,
          memo,
          deadline: holdUntil,
          quantity: totalQuantity,
          message: totalQuantity > 1
            ? `Your ${totalQuantity} tickets are reserved. Send one e-Transfer for the full amount; once we confirm it, all ${totalQuantity} tickets will be activated.`
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
