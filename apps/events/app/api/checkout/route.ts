/**
 * POST /api/checkout
 * 
 * Creates a checkout session via the pay service.
 * Events app doesn't touch Stripe directly — sovereign node model.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, events, ticketTypes, eventInvites } from '@/src/db';
import { eq, and, sql } from 'drizzle-orm';
import { optionalAuth } from '@imajin/auth';
import { rateLimit, getClientIP } from '@/src/lib/rate-limit';

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL!;
const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL!;

interface CheckoutRequest {
  eventId: string;
  ticketTypeId: string;
  quantity: number;
  email?: string;
  invite?: string;
}

export async function POST(request: NextRequest) {
  const ip = getClientIP(request);
  const rl = rateLimit(ip, 10, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    );
  }

  try {
    const body: CheckoutRequest = await request.json();
    
    // Validate
    if (!body.eventId || !body.ticketTypeId) {
      return NextResponse.json(
        { error: 'eventId and ticketTypeId are required' },
        { status: 400 }
      );
    }
    
    const quantity = body.quantity || 1;
    
    // Fetch event and ticket type
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, body.eventId))
      .limit(1);
    
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    if (event.status !== 'published') {
      return NextResponse.json({ error: 'Tickets are not available for this event' }, { status: 400 });
    }

    // Invite-only access check
    let inviteRecord: typeof eventInvites.$inferSelect | undefined;
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

      inviteRecord = invite;
    }

    const [ticketType] = await db
      .select()
      .from(ticketTypes)
      .where(
        and(
          eq(ticketTypes.id, body.ticketTypeId),
          eq(ticketTypes.eventId, body.eventId)
        )
      )
      .limit(1);
    
    if (!ticketType) {
      return NextResponse.json({ error: 'Ticket type not found' }, { status: 404 });
    }
    
    // Check if buyer is logged in (hard DID)
    const session = await optionalAuth(request);
    const buyerDid = (session && session.tier !== 'soft') ? session.id : undefined;

    // Check availability
    if (ticketType.quantity !== null) {
      const available = ticketType.quantity - (ticketType.sold ?? 0);
      if (available < quantity) {
        return NextResponse.json(
          { error: `Only ${available} tickets available` },
          { status: 400 }
        );
      }
    }
    
    // Read .fair attribution from event metadata
    const eventMetadata = (event.metadata || {}) as Record<string, any>;
    const fairManifest = eventMetadata.fair || null;

    // Call pay service to create checkout session
    const payResponse = await fetch(`${PAY_SERVICE_URL}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{
          name: `${event.title} — ${ticketType.name}`,
          description: ticketType.description || undefined,
          amount: ticketType.price,
          quantity,
        }],
        currency: ticketType.currency,
        customerEmail: body.email,
        successUrl: `${EVENTS_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}&event=${event.id}`,
        cancelUrl: `${EVENTS_URL}/${event.id}`,
        fairManifest,
        sellerDid: event.creatorDid,
        metadata: {
          service: 'events',
          eventId: event.id,
          eventDid: event.did,
          ticketTypeId: ticketType.id,
          quantity: String(quantity),
          ...(buyerDid && { buyerDid }),
        },
      }),
    });
    
    if (!payResponse.ok) {
      const error = await payResponse.json();
      console.error('Pay service error:', error);
      return NextResponse.json(
        { error: error.error || 'Payment service error' },
        { status: 500 }
      );
    }
    
    const checkout = await payResponse.json();

    // Increment invite used_count on successful checkout session creation
    if (inviteRecord) {
      await db
        .update(eventInvites)
        .set({ usedCount: inviteRecord.usedCount + 1 })
        .where(eq(eventInvites.id, inviteRecord.id));
    }

    return NextResponse.json({
      url: checkout.url,
      sessionId: checkout.id,
    });
    
  } catch (error) {
    console.error('Checkout error:', error);
    return NextResponse.json(
      { error: 'Checkout failed' },
      { status: 500 }
    );
  }
}
