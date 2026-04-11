/**
 * POST /api/webhook/payment
 * 
 * Called by pay service when a checkout completes.
 * Creates the ticket record and sends confirmation email.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withLogger, createLogger } from '@imajin/logger';
import { db, events, ticketTypes, tickets } from '@/src/db';

const log = createLogger('events');
import { eq, and, sql } from 'drizzle-orm';
import { sendEmail, ticketConfirmationEmail, purchaseReceiptEmail, generateQRCode } from '@/src/lib/email';
import { settleTicketPurchase } from '@/src/lib/settle';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { randomBytes } from 'crypto';
import { getClient } from '@imajin/db';
import { emitAttestation } from '@imajin/auth';
import { notify } from '@imajin/notify';

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
    throw new Error(`Soft register failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  log.info({ email, did: data.did, isNew: data.isNew }, 'Guest DID resolved');
  return data.did;
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
      log.error({ status: response.status }, 'Soft session creation failed');
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

    log.info({ email, did: data.did, hasSessionToken: !!sessionToken }, 'Soft DID session created');
    return { did: data.did, sessionToken };
  } catch (error) {
    log.error({ err: String(error) }, 'Soft session creation error');
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
      sql`UPDATE profile.profiles SET contact_email = ${normalizedEmail} WHERE did = ${did} AND (contact_email IS NULL OR contact_email = '')`
    );
    const rowCount = (result as any)?.rowCount ?? (result as any)?.count ?? 0;
    if (rowCount > 0) {
      log.info({ did, email: normalizedEmail }, 'Attached email to hard DID');
    } else {
      log.info({ did }, 'Hard DID already has an email — skipped');
    }
  } catch (error) {
    log.error({ err: String(error) }, 'attachEmailToProfile error');
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

    log.info({ count: softTickets.length, softDids, hardDid }, 'Migrated tickets from soft DIDs to hard DID');

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
          log.info({ softDid, hardDid }, 'Migrated chat participation');
        } catch (chatError) {
          log.warn({ softDid, err: String(chatError) }, 'Chat migration failed (non-fatal)');
        }
      }
    }
  } catch (error) {
    log.error({ err: String(error) }, 'migrateSoftDidToHard error');
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

export const POST = withLogger('events', async (request, { log }) => {
  try {
    // Verify webhook secret
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${WEBHOOK_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload: PaymentWebhookPayload = await request.json();

    log.info({ type: payload.type, sessionId: payload.sessionId }, 'Payment webhook received');

    if (payload.type === 'checkout.completed') {
      await handleCheckoutCompleted(payload);
    } else if (payload.type === 'payment.failed') {
      await handlePaymentFailed(payload);
    }

    return NextResponse.json({ received: true });

  } catch (error) {
    log.error({ err: String(error) }, 'Payment webhook error');
    return NextResponse.json(
      { error: 'Webhook processing failed' },
      { status: 500 }
    );
  }
});

async function handleCheckoutCompleted(payload: PaymentWebhookPayload) {
  const { metadata, customerName, amountTotal, currency, sessionId, paymentId } = payload;
  const customerEmail = payload.customerEmail || null;
  const quantity = parseInt(metadata.quantity) || 1;

  // Idempotency: check if tickets for this Stripe session already exist
  const existingTickets = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(sql`${tickets.metadata}->>'stripeSessionId' = ${sessionId}`)
    .limit(1);

  if (existingTickets.length > 0) {
    log.info({ sessionId }, 'Duplicate webhook — tickets already exist for session');
    return;
  }

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
    log.info({ ownerDid }, 'Buyer authenticated with hard DID');

    // Attach email to their profile if not already set
    await attachEmailToProfile(ownerDid, customerEmail);

    // Migrate any existing soft DID tickets/chat for this email
    await migrateSoftDidToHard(customerEmail, ownerDid, event.id);
  } else {
    // Guest buyer — create soft DID session
    const softSession = await createSoftDidSession(customerEmail, customerName || undefined);
    if (!softSession?.did) {
      throw new Error(`Failed to create soft DID session for ${customerEmail}`);
    }
    ownerDid = softSession.did;
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
      log.warn({ eventId: event.id }, 'Event has no privateKey — using base64 fallback signature');
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
      paymentMethod: paymentId ? 'stripe' : 'etransfer',
      status: 'valid',
      purchasedAt: new Date(),
      signature,

      registrationStatus: ticketType.requiresRegistration ? 'pending' : 'not_required',
      metadata: {
        stripeSessionId: sessionId,
        purchaseEmail: customerEmail,
      },
    }).returning();

    createdTickets.push(ticket);

    // Fire and forget — never block the response
    emitAttestation({
      issuer_did: ownerDid,
      subject_did: event.creatorDid,
      type: 'ticket.purchased',
      context_id: event.id,
      context_type: 'event',
      payload: { ticketId: ticket.id, amount: amountTotal / quantity, currency },
    }).catch((err) => log.error({ err: String(err) }, 'Attestation emit error'));
  }

  // Update sold count
  await db
    .update(ticketTypes)
    .set({ sold: sql`${ticketTypes.sold} + ${quantity}` })
    .where(eq(ticketTypes.id, ticketType.id));

  log.info({ count: createdTickets.length, customerEmail }, 'Tickets created for customer');

  // Notify buyer — fire and forget
  notify.send({
    to: ownerDid,
    scope: "event:ticket",
    data: {
      email: customerEmail,
      eventTitle: event.title,
      ticketType: ticketType.name,
      amount: amountTotal,
      currency: currency.toUpperCase(),
    },
  }).catch((err) => log.error({ err: String(err) }, 'Notify error'));

  // Record interest signal — ticket.purchased → events scope
  notify.interest({ did: ownerDid, attestationType: 'ticket.purchased' })
    .catch((err) => log.error({ err: String(err) }, 'Interest signal error'));

  // Add buyer to event chat conversation_members (non-fatal)
  // The event DID is the conversation DID
  const CHAT_URL = process.env.CHAT_SERVICE_URL || process.env.CHAT_URL;
  if (CHAT_URL) {
    try {
      const memberRes = await fetch(`${CHAT_URL}/api/d/${encodeURIComponent(event.did)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberDid: ownerDid, role: 'member' }),
      });
      if (memberRes.ok) {
        log.info({ ownerDid, eventDid: event.did }, 'Added buyer to event chat');
      } else {
        log.warn({ status: memberRes.status }, 'Failed to add to event chat — non-fatal');
      }
    } catch (chatError) {
      log.warn({ err: String(chatError) }, 'Event chat member sync failed (non-fatal)');
    }
  }

  // After ticket creation, trigger .fair settlement (non-fatal)
  const eventMetadata = (event.metadata || {}) as Record<string, any>;
  try {
    await settleTicketPurchase({
      eventId: event.id,
      eventDid: event.did,
      buyerDid: ownerDid,
      amount: amountTotal, // cents from Stripe
      currency,
      fairManifest: eventMetadata.fair || null,
      metadata: {
        ticketId: createdTickets[0].id,
        ticketTypeId: ticketType.id,
        stripeSessionId: sessionId,
      },
    });
  } catch (settleError) {
    log.error({ err: String(settleError) }, '[settle] Unexpected settlement error (non-fatal)');
  }

  // Send confirmation email with onboard verification link
  const eventDate = new Date(event.startsAt);
  const AUTH_URL = process.env.AUTH_URL || process.env.AUTH_SERVICE_URL || 'https://auth.imajin.ai';
  const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai';

  let onboardToken: string | null = null;
  try {
    const authSql = getClient();
    onboardToken = randomBytes(36).toString('hex');
    const onboardId = `obt_${randomBytes(8).toString('hex')}`;
    const redirectUrl = `${EVENTS_URL}/${event.id}`;

    await authSql`
      INSERT INTO auth.onboard_tokens (id, email, name, token, redirect_url, context, expires_at)
      VALUES (
        ${onboardId},
        ${customerEmail.toLowerCase().trim()},
        ${customerName || null},
        ${onboardToken},
        ${redirectUrl},
        ${'access your ticket for ' + event.title},
        ${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()}
      )
    `;
  } catch (onboardError) {
    log.error({ customerEmail, err: String(onboardError) }, '[webhook] Onboard token creation failed (non-fatal)');
    onboardToken = null;
  }

  const magicLink = onboardToken ? `${AUTH_URL}/api/onboard/verify?token=${onboardToken}` : undefined;

  // Build absolute event image URL
  const eventImageUrl = event.imageUrl
    ? (event.imageUrl.startsWith('http') ? event.imageUrl : `${EVENTS_URL}${event.imageUrl}`)
    : undefined;

  const formattedEventDate = eventDate.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const formattedEventTime = eventDate.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const formattedTotal = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amountTotal / 100);
  const unitPrice = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amountTotal / 100 / quantity);

  // Deep link: if registration required, go to the registration form; otherwise my-tickets
  const registrationUrl = ticketType.requiresRegistration
    ? `${EVENTS_URL}/${event.id}/register/${createdTickets[0].id}`
    : `${EVENTS_URL}/${event.id}/my-tickets`;

  // Always send a purchase receipt to the buyer
  try {
    await sendEmail({
      to: customerEmail,
      subject: `Purchase receipt — ${event.title}`,
      html: purchaseReceiptEmail({
        buyerName: customerName || undefined,
        eventTitle: event.title,
        eventDate: formattedEventDate,
        eventTime: formattedEventTime,
        ticketSummary: [{ typeName: ticketType.name, quantity, unitPrice }],
        totalPaid: formattedTotal,
        paymentMethod: paymentId ? 'Credit Card' : 'E-Transfer',
        registrationUrl,
        eventImageUrl,
        hasRegistrationRequired: ticketType.requiresRegistration,
      }),
    });
  } catch (emailError) {
    log.error({ customerEmail, err: String(emailError) }, '[webhook] Purchase receipt email failed');
  }

  // Only send the ticket confirmation (with QR) immediately for non-registration tickets
  if (!ticketType.requiresRegistration) {
    try {
      // Generate QR code from ticket ID (for check-in scanning)
      const qrCodeDataUri = await generateQRCode(createdTickets[0].id);

      await sendEmail({
        to: customerEmail,
        subject: `You're in — ${event.title}`,
        html: ticketConfirmationEmail({
          eventTitle: event.title,
          ticketType: ticketType.name,
          ticketId: createdTickets[0].id + (quantity > 1 ? ` (+${quantity - 1} more)` : ''),
          eventDate: formattedEventDate,
          eventTime: formattedEventTime,
          isVirtual: event.isVirtual ?? false,
          venue: event.venue ?? undefined,
          price: formattedTotal,
          magicLink,
          eventImageUrl,
          eventUrl: `${EVENTS_URL}/${event.id}`,
          qrCodeDataUri,
        }),
      });
    } catch (emailError) {
      log.error({ customerEmail, err: String(emailError) }, '[webhook] Ticket confirmation email failed');
    }
  }
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
    log.error({ eventId: metadata.eventId }, 'Event not found for failed payment');
    return;
  }

  const [ticketType] = await db
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.id, metadata.ticketTypeId))
    .limit(1);

  log.info({ customerEmail, eventTitle: event.title }, 'Payment failed');
  
  // Optionally send a "payment failed" email
  // For now, just log it - Stripe also sends their own failure emails
}
