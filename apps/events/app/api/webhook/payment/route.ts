/**
 * POST /api/webhook/payment
 * 
 * Called by pay service when a checkout completes.
 * Creates the ticket record and sends confirmation email.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, events, ticketTypes, tickets } from '@/src/db';
import { eq, and, sql } from 'drizzle-orm';
import { sendEmail, ticketConfirmationEmail, generateQRCode } from '@/src/lib/email';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { getEventPod, addEventParticipant } from '@/src/lib/pods';
import { randomBytes } from 'crypto';

// Configure ed25519 with sha512
ed.hashes.sha512 = sha512;

// Shared secret between pay service and events service
// In production, use proper service-to-service auth
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET!;
const PROFILE_URL = process.env.PROFILE_URL!;
const AUTH_URL = process.env.AUTH_SERVICE_URL || process.env.AUTH_URL || 'http://localhost:3003';

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

/**
 * Create soft DID session via auth service.
 * This creates/updates the identity profile with tier='soft' and returns session token.
 */
async function createSoftDidSession(email: string, name?: string): Promise<{ did: string; sessionToken?: string } | null> {
  try {
    const response = await fetch(`${AUTH_URL}/api/session/soft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email.toLowerCase().trim(),
        name: name?.trim(),
      }),
    });

    if (!response.ok) {
      console.error('Soft session creation failed:', response.status, await response.text());
      return null;
    }

    const data = await response.json();

    // Extract session token from Set-Cookie header if present
    const setCookie = response.headers.get('set-cookie');
    let sessionToken: string | undefined;
    if (setCookie) {
      const tokenMatch = setCookie.match(/session=([^;]+)/);
      if (tokenMatch) {
        sessionToken = tokenMatch[1];
      }
    }

    console.log(`Soft DID session created for ${email}: ${data.did}${sessionToken ? ' (with session token)' : ''}`);
    return { did: data.did, sessionToken };
  } catch (error) {
    console.error('Soft session creation error:', error);
    return null;
  }
}

/**
 * Attach email to an existing hard DID profile (if not already set).
 * Direct DB update — events and profile share the same Postgres database.
 */
async function attachEmailToProfile(did: string, email: string): Promise<void> {
  try {
    const normalizedEmail = email.toLowerCase().trim();
    const result = await db.execute(
      sql`UPDATE profile.profiles SET email = ${normalizedEmail} WHERE did = ${did} AND (email IS NULL OR email = '')`
    );
    const rowCount = (result as any)?.rowCount ?? (result as any)?.count ?? 0;
    if (rowCount > 0) {
      console.log(`Attached email ${normalizedEmail} to hard DID ${did}`);
    } else {
      console.log(`Hard DID ${did} already has an email — skipped`);
    }
  } catch (error) {
    console.error('attachEmailToProfile error:', error);
  }
}

/**
 * Migrate tickets and chat participation from soft DIDs to a hard DID.
 * Looks up tickets by purchaseEmail in metadata (since soft DIDs are did:imajin:* not did:email:*).
 * Only migrates tickets not already owned by the hard DID.
 */
async function migrateSoftDidToHard(email: string, hardDid: string, eventId: string): Promise<void> {
  try {
    // Find tickets for this event purchased with this email but owned by a different DID
    const softTickets = await db
      .select({ id: tickets.id, ownerDid: tickets.ownerDid })
      .from(tickets)
      .where(
        and(
          eq(tickets.eventId, eventId),
          sql`${tickets.metadata}->>'purchaseEmail' = ${email.toLowerCase().trim()}`,
          sql`${tickets.ownerDid} != ${hardDid}`
        )
      );

    if (softTickets.length === 0) return;

    const softDids = Array.from(new Set(softTickets.map(t => t.ownerDid)));

    // Migrate tickets to hard DID
    await db
      .update(tickets)
      .set({ ownerDid: hardDid })
      .where(
        and(
          eq(tickets.eventId, eventId),
          sql`${tickets.metadata}->>'purchaseEmail' = ${email.toLowerCase().trim()}`,
          sql`${tickets.ownerDid} != ${hardDid}`
        )
      );

    console.log(`Migrated ${softTickets.length} ticket(s) from [${softDids.join(', ')}] to ${hardDid}`);

    // Migrate chat participation for each soft DID
    const CHAT_URL = process.env.CHAT_SERVICE_URL || process.env.CHAT_URL;
    if (CHAT_URL) {
      for (const softDid of softDids) {
        try {
          await fetch(`${CHAT_URL}/api/participants/migrate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fromDid: softDid, toDid: hardDid }),
          });
          console.log(`Migrated chat participation from ${softDid} to ${hardDid}`);
        } catch (chatError) {
          console.warn(`Chat migration failed for ${softDid} (non-fatal):`, chatError);
        }
      }
    }
  } catch (error) {
    console.error('migrateSoftDidToHard error:', error);
  }
}

interface PaymentWebhookPayload {
  type: 'checkout.completed' | 'payment.failed';
  sessionId: string;
  paymentId?: string;
  customerEmail: string;
  customerName?: string | null;
  amountTotal: number;
  currency: string;
  metadata: {
    eventId: string;
    eventDid: string;
    ticketTypeId: string;
    quantity: string;
    buyerDid?: string;
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
  const { metadata, customerName, amountTotal, currency, sessionId, paymentId } = payload;
  const customerEmail = payload.customerEmail || null;
  const quantity = parseInt(metadata.quantity) || 1;

  if (!customerEmail) {
    throw new Error('Customer email is required for ticket creation');
  }

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

  // Resolve owner DID: use hard DID if buyer was logged in, otherwise create soft DID
  let ownerDid: string;

  if (metadata.buyerDid) {
    // Buyer was logged in with a hard DID
    ownerDid = metadata.buyerDid;
    console.log(`Buyer authenticated with hard DID: ${ownerDid}`);

    // Attach email to their profile if not already set
    await attachEmailToProfile(ownerDid, customerEmail);

    // Migrate any existing soft DID tickets/chat for this email
    await migrateSoftDidToHard(customerEmail, ownerDid, event.id);
  } else {
    // Guest buyer — create soft DID session
    const softSession = await createSoftDidSession(customerEmail, customerName || undefined);
    ownerDid = softSession?.did || `did:email:${customerEmail.replace('@', '_at_')}`;
  }

  // Create ticket(s)
  const createdTickets = [];

  for (let i = 0; i < quantity; i++) {
    const ticketId = `tkt_${Date.now().toString(36)}_${i}`;

    // Generate magic token for authentication
    const magicToken = randomBytes(32).toString('hex');

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
      purchasedAt: new Date(),
      signature,
      magicToken,
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
      // Also add to lobby conversation if it exists
      if (eventPod.lobbyConversationId) {
        await addEventParticipant({
          podId: eventPod.podId,
          conversationId: eventPod.lobbyConversationId,
          participantDid: ownerDid,
          addedBy: event.did,
          role: 'member',
        });
      }
      console.log(`Added ${ownerDid} to event pod ${eventPod.podId}, chat ${eventPod.conversationId}, lobby ${eventPod.lobbyConversationId}`);
    }
  }
  
  // Send confirmation email with magic link
  const eventDate = new Date(event.startsAt);
  const AUTH_URL = process.env.AUTH_URL || process.env.AUTH_SERVICE_URL || 'https://auth.imajin.ai';
  const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai';
  const magicLink = `${AUTH_URL}/api/magic?token=${createdTickets[0].magicToken}`;

  // Generate QR code from magic link (scannable for event entry)
  const qrCodeDataUri = await generateQRCode(magicLink);

  // Build absolute event image URL
  const eventImageUrl = event.imageUrl
    ? (event.imageUrl.startsWith('http') ? event.imageUrl : `${EVENTS_URL}${event.imageUrl}`)
    : undefined;

  await sendEmail({
    to: customerEmail,
    subject: `You're in — ${event.title}`,
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
      magicLink,
      eventImageUrl,
      eventUrl: `${EVENTS_URL}/${event.id}`,
      qrCodeDataUri,
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
