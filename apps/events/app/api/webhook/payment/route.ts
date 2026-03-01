/**
 * POST /api/webhook/payment
 * 
 * Called by pay service when a checkout completes.
 * Creates the ticket record and sends confirmation email.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, events, ticketTypes, tickets } from '@/src/db';
import { eq, and, sql } from 'drizzle-orm';
import { sendEmail, ticketConfirmationEmail } from '@/src/lib/email';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { getEventPod, addEventParticipant } from '@/src/lib/pods';

// Configure ed25519 with sha512
ed.hashes.sha512 = sha512;

// Shared secret between pay service and events service
// In production, use proper service-to-service auth
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET!;
const PROFILE_URL = process.env.PROFILE_URL!;

/**
 * Create or get a guest DID from the profile service.
 * This creates a soft registration that can be claimed later.
 */
async function getOrCreateGuestDid(email: string, eventId: string, eventDid: string): Promise<string> {
  try {
    const response = await fetch(`${PROFILE_URL}/api/soft-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        source: 'event',
        sourceId: eventDid,
      }),
    });

    if (!response.ok) {
      console.error('Soft register failed:', await response.text());
      // Fallback to email-based DID
      return `did:email:${email.replace('@', '_at_')}`;
    }

    const data = await response.json();
    console.log(`Guest DID for ${email}: ${data.did} (isNew: ${data.isNew})`);
    return data.did;
  } catch (error) {
    console.error('Soft register error:', error);
    // Fallback to email-based DID
    return `did:email:${email.replace('@', '_at_')}`;
  }
}

interface PaymentWebhookPayload {
  type: 'checkout.completed' | 'payment.failed';
  sessionId: string;
  paymentId?: string;
  customerEmail: string;
  amountTotal: number;
  currency: string;
  metadata: {
    eventId: string;
    eventDid: string;
    ticketTypeId: string;
    quantity: string;
  };
}

export async function POST(request: NextRequest) {
  try {
    // Verify webhook secret
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${WEBHOOK_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    const payload: PaymentWebhookPayload = await request.json();
    
    console.log('Payment webhook received:', payload.type, payload.sessionId);
    
    if (payload.type === 'checkout.completed') {
      await handleCheckoutCompleted(payload);
    } else if (payload.type === 'payment.failed') {
      await handlePaymentFailed(payload);
    }
    
    return NextResponse.json({ received: true });
    
  } catch (error) {
    console.error('Payment webhook error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Webhook failed' },
      { status: 500 }
    );
  }
}

async function handleCheckoutCompleted(payload: PaymentWebhookPayload) {
  const { metadata, customerEmail, amountTotal, currency, sessionId, paymentId } = payload;
  const quantity = parseInt(metadata.quantity) || 1;
  
  // Get event and ticket type
  const [event] = await db
    .select()
    .from(events)
    .where(eq(events.id, metadata.eventId))
    .limit(1);
  
  if (!event) {
    throw new Error(`Event not found: ${metadata.eventId}`);
  }
  
  const [ticketType] = await db
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.id, metadata.ticketTypeId))
    .limit(1);
  
  if (!ticketType) {
    throw new Error(`Ticket type not found: ${metadata.ticketTypeId}`);
  }
  
  // Create ticket(s)
  const createdTickets = [];
  
  for (let i = 0; i < quantity; i++) {
    const ticketId = `tkt_${Date.now().toString(36)}_${i}`;
    
    // Sign ticket with event's Ed25519 private key
    const signatureData = `${ticketId}:${event.did}:${customerEmail}:${Date.now()}`;
    const msgBytes = new TextEncoder().encode(signatureData);
    let signature: string;
    if (event.privateKey) {
      const sigBytes = await ed.signAsync(msgBytes, hexToBytes(event.privateKey));
      signature = bytesToHex(sigBytes);
    } else {
      // Fallback for events created before privateKey was stored
      console.warn(`Event ${event.id} has no privateKey — using base64 fallback signature`);
      signature = Buffer.from(signatureData).toString('base64');
    }
    
    // Soft-register with profile service to create/get guest DID
    const ownerDid = await getOrCreateGuestDid(customerEmail, event.id, event.did);
    
    const [ticket] = await db.insert(tickets).values({
      id: ticketId,
      eventId: event.id,
      ticketTypeId: ticketType.id,
      ownerDid,
      originalOwnerDid: ownerDid,
      pricePaid: amountTotal / quantity,
      currency: currency.toUpperCase(),
      paymentId: paymentId || sessionId,
      status: 'valid',
      signature,
      metadata: {
        stripeSessionId: sessionId,
        purchaseEmail: customerEmail,
      },
    }).returning();
    
    createdTickets.push(ticket);
  }
  
  // Update sold count
  await db
    .update(ticketTypes)
    .set({ sold: sql`${ticketTypes.sold} + ${quantity}` })
    .where(eq(ticketTypes.id, ticketType.id));

  console.log(`Created ${createdTickets.length} ticket(s) for ${customerEmail}`);

  // Add buyer to event pod and group chat
  const ownerDid = createdTickets[0].ownerDid;
  if (ownerDid) {
    const eventPod = await getEventPod(event.id);
    if (eventPod) {
      await addEventParticipant({
        podId: eventPod.podId,
        conversationId: eventPod.conversationId,
        participantDid: ownerDid,
        addedBy: event.did,
        role: 'member',
      });
      console.log(`Added ${ownerDid} to event pod ${eventPod.podId} and chat ${eventPod.conversationId}`);
    }
  }
  
  // Send confirmation email
  const eventDate = new Date(event.startsAt);
  
  await sendEmail({
    to: customerEmail,
    subject: `🎉 You're in! Ticket for ${event.title}`,
    html: ticketConfirmationEmail({
      eventTitle: event.title,
      ticketType: ticketType.name,
      ticketId: createdTickets[0].id + (quantity > 1 ? ` (+${quantity - 1} more)` : ''),
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
      isVirtual: event.isVirtual ?? false,
      venue: event.venue ?? undefined,
      price: new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency.toUpperCase(),
      }).format(amountTotal / 100),
    }),
  });
}

async function handlePaymentFailed(payload: PaymentWebhookPayload) {
  const { metadata, customerEmail } = payload;
  
  // Get event for the retry URL
  const [event] = await db
    .select()
    .from(events)
    .where(eq(events.id, metadata.eventId))
    .limit(1);
  
  if (!event) {
    console.error('Event not found for failed payment:', metadata.eventId);
    return;
  }
  
  const [ticketType] = await db
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.id, metadata.ticketTypeId))
    .limit(1);
  
  console.log(`Payment failed for ${customerEmail}, event: ${event.title}`);
  
  // Optionally send a "payment failed" email
  // For now, just log it - Stripe also sends their own failure emails
}
