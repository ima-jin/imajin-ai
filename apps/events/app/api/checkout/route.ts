/**
 * POST /api/checkout
 * 
 * Creates a checkout session via the pay service.
 * Events app doesn't touch Stripe directly — sovereign node model.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, events, ticketTypes } from '@/src/db';
import { eq, and, sql } from 'drizzle-orm';

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL!;
const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL!;

interface CheckoutRequest {
  eventId: string;
  ticketTypeId: string;
  quantity: number;
  email?: string;
}

export async function POST(request: NextRequest) {
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
        successUrl: `${EVENTS_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${EVENTS_URL}/${event.id}`,
        metadata: {
          eventId: event.id,
          eventDid: event.did,
          ticketTypeId: ticketType.id,
          quantity: String(quantity),
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
    
    return NextResponse.json({
      url: checkout.url,
      sessionId: checkout.id,
    });
    
  } catch (error) {
    console.error('Checkout error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Checkout failed' },
      { status: 500 }
    );
  }
}
