/**
 * POST /api/webhook/payment
 *
 * Called by pay service when a checkout completes.
 * Creates order + ticket records via the shared createOrderWithTickets
 * helper. Webhook-only logic (soft-DID creation, chat member sync, email
 * migration, .fair settlement signals, per-ticket bus publishes, onboard
 * token magic links) stays here.
 */

import { NextResponse } from 'next/server';
import { withLogger, createLogger } from '@imajin/logger';
import { db, events, ticketTypes, tickets, orders } from '@/src/db';

const log = createLogger('events');
import { eq, and, sql } from 'drizzle-orm';
import { generateQRCode } from '@/src/lib/email';
import { backfillContactEmail } from '@/src/lib/contact-email';
import { createOrderWithTickets } from '@/src/lib/checkout-common';
import { randomBytes } from 'node:crypto';
import { eventUrl, eventRegisterUrl, eventMyTicketsUrl, buildPublicUrlAbsolute } from '@imajin/config';
import { getClient } from '@imajin/db';
import { publish } from '@imajin/bus';
import * as bus from '@imajin/bus';

// Shared secret between pay service and events service.
// In production, use proper service-to-service auth.
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
 * Resolve or create a soft DID via the auth service.
 * POST /api/session/soft is a server-side DID resolver only — it does not
 * issue session cookies or tokens.
 */
async function createSoftDidSession(email: string, name?: string): Promise<{ did: string } | null> {
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
    log.info({ email, did: data.did }, 'Soft DID resolved');
    return { did: data.did };
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
    // Legacy single-type fields
    ticketTypeId?: string;
    quantity?: string;
    // Multi-type cart (JSON string)
    cart?: string;
    totalQuantity?: string;
    buyerDid?: string;
  };
}

export const POST = withLogger('events', async (request, { log }) => {
  try {
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

  // Parse cart: multi-type (cart JSON) or legacy single-type
  interface CartEntry { ticketTypeId: string; quantity: number }
  let cart: CartEntry[];
  if (metadata.cart) {
    try {
      cart = JSON.parse(metadata.cart);
    } catch {
      throw new Error(`Invalid cart metadata: ${metadata.cart}`);
    }
  } else if (metadata.ticketTypeId) {
    cart = [{ ticketTypeId: metadata.ticketTypeId, quantity: Number.parseInt(metadata.quantity || '1') }];
  } else {
    throw new Error('No cart or ticketTypeId in metadata');
  }
  const totalQuantity = cart.reduce((sum, c) => sum + c.quantity, 0);

  // Idempotency: check if an order for this Stripe session already exists
  const existingOrder = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.stripeSessionId, sessionId))
    .limit(1);

  if (existingOrder.length > 0) {
    log.info({ sessionId }, 'Duplicate webhook — order already exists for session');
    return;
  }

  if (!customerEmail) {
    throw new Error('Customer email is required for ticket creation');
  }

  const [event] = await db
    .select()
    .from(events)
    .where(eq(events.id, metadata.eventId))
    .limit(1);

  if (!event) {
    throw new Error(`Event not found: ${metadata.eventId}`);
  }

  // Fetch all ticket types referenced in cart
  const allTypes = await db.select().from(ticketTypes).where(eq(ticketTypes.eventId, metadata.eventId));
  const typesById = new Map(allTypes.map(t => [t.id, t]));
  for (const item of cart) {
    if (!typesById.has(item.ticketTypeId)) {
      throw new Error(`Ticket type not found: ${item.ticketTypeId}`);
    }
  }
  // Use first type for backward-compat fields that need a single value
  const firstType = typesById.get(cart[0].ticketTypeId)!;

  // Resolve owner DID: use hard DID if buyer was logged in, otherwise create soft DID
  let ownerDid: string;

  if (metadata.buyerDid) {
    ownerDid = metadata.buyerDid;
    log.info({ ownerDid }, 'Buyer authenticated with hard DID');

    await attachEmailToProfile(ownerDid, customerEmail);
    await backfillContactEmail(ownerDid, customerEmail, log);
    await migrateSoftDidToHard(customerEmail, ownerDid, event.id);
  } else {
    const softSession = await createSoftDidSession(customerEmail, customerName || undefined);
    if (!softSession?.did) {
      throw new Error(`Failed to create soft DID session for ${customerEmail}`);
    }
    ownerDid = softSession.did;
    await backfillContactEmail(ownerDid, customerEmail, log);
  }

  const { tickets: createdTickets, order } = await createOrderWithTickets({
    eventId: event.id,
    buyerDid: ownerDid,
    cart,
    typesById,
    totalQuantity,
    totalAmount: amountTotal,
    currency: currency.toUpperCase(),
    paymentMethod: paymentId ? 'stripe' : 'etransfer',
    ticketStatus: 'valid',
    stripeSessionId: sessionId,
    paymentId: paymentId || undefined,
    orderMetadata: {
      purchaseEmail: customerEmail,
      customerName: customerName || null,
      cart: cart.map(c => ({ ticketTypeId: c.ticketTypeId, quantity: c.quantity })),
    },
    ticketMetadata: {
      stripeSessionId: sessionId,
      purchaseEmail: customerEmail,
    },
    eventDid: event.did,
    eventPrivateKey: event.privateKey,
    customerEmail,
    log,
    incrementSold: true,
  });

  const orderId = order.id;

  // Per-ticket attestation: fire-and-forget so we never block the response.
  for (const ticket of createdTickets) {
    bus.publish('ticket.purchased', {
      issuer: ownerDid, subject: event.creatorDid, scope: 'events',
      payload: {
        ticketId: ticket.id, eventId: event.id,
        amount: ticket.pricePaid ?? 0, currency,
        context_id: event.id, context_type: 'event',
        to: ownerDid,
        interestDids: [ownerDid],
      }
    });
  }

  log.info({ count: createdTickets.length, orderId, customerEmail }, 'Order + tickets created');

  // Add buyer to event chat conversation_members (non-fatal). Event DID = conversation DID.
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

  // Trigger settlement and notification signals via bus
  const eventMetadata = (event.metadata || {}) as Record<string, any>;
  try {
    await bus.publish('order.completed', {
      issuer: ownerDid, subject: event.creatorDid, scope: 'events',
      payload: {
        orderId,
        eventId: event.id,
        eventDid: event.did,
        buyerDid: ownerDid,
        amount: amountTotal,
        currency,
        fairManifest: eventMetadata.fair || null,
        metadata: {
          ticketIds: createdTickets.map(t => t.id),
          ticketTypeId: firstType.id,
          stripeSessionId: sessionId,
          eventId: event.id,
        },
        funded: true,
        funded_provider: 'stripe',
      }
    });
  } catch (settleError) {
    log.error({ err: String(settleError) }, '[settle] Unexpected settlement error (non-fatal)');
  }

  // Send confirmation email with onboard verification link
  const eventDate = new Date(event.startsAt);
  const AUTH_URL = process.env.NEXT_PUBLIC_AUTH_URL || process.env.AUTH_URL || buildPublicUrlAbsolute('auth');
  const EVENTS_URL = buildPublicUrlAbsolute('events');

  // Determine registration-pending tickets early so the onboard token can
  // redirect to the register page when applicable.
  const bundleTickets = createdTickets.filter(
    (t) => t.registrationStatus !== 'pending',
  );
  const registrationPendingTickets = createdTickets.filter(
    (t) => t.registrationStatus === 'pending',
  );
  const ctaTicket = registrationPendingTickets[0] ?? null;
  const anyPendingRegistration = registrationPendingTickets.length > 0;

  // Magic-link onboard token — redirect to register page when there are
  // pending registrations so users land authenticated.
  let onboardToken: string | null = null;
  const onboardRedirectUrl = ctaTicket
    ? eventRegisterUrl(EVENTS_URL, event.id, ctaTicket.id)
    : eventUrl(EVENTS_URL, event.id);
  try {
    const authSql = getClient();
    onboardToken = randomBytes(36).toString('hex');
    const onboardId = `obt_${randomBytes(8).toString('hex')}`;

    await authSql`
      INSERT INTO auth.onboard_tokens (id, email, name, token, redirect_url, context, expires_at)
      VALUES (
        ${onboardId},
        ${customerEmail.toLowerCase().trim()},
        ${customerName || null},
        ${onboardToken},
        ${onboardRedirectUrl},
        ${'access your ticket for ' + event.title},
        ${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()}
      )
    `;
  } catch (onboardError) {
    log.error({ customerEmail, err: String(onboardError) }, '[webhook] Onboard token creation failed (non-fatal)');
    onboardToken = null;
  }

  const magicLink = onboardToken ? `${AUTH_URL}/api/onboard/verify?token=${onboardToken}` : undefined;

  // Registration CTA goes through magic link for auth; falls back to naked URL.
  let registrationUrl: string;
  if (anyPendingRegistration) {
    registrationUrl = onboardToken ? `${AUTH_URL}/api/onboard/verify?token=${onboardToken}` : eventRegisterUrl(EVENTS_URL, event.id, ctaTicket!.id);
  } else {
    registrationUrl = eventMyTicketsUrl(EVENTS_URL, event.id);
  }

  let eventImageUrl: string | undefined;
  if (event.imageUrl) {
    eventImageUrl = event.imageUrl.startsWith('http') ? event.imageUrl : `${EVENTS_URL}${event.imageUrl}`;
  }

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
  const quantity = createdTickets.length;
  const unitPrice = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amountTotal / 100 / quantity);

  // bundleTickets, registrationPendingTickets, ctaTicket, anyPendingRegistration,
  // and registrationUrl are computed above (before onboard token creation).

  // Always publish a purchase receipt to the buyer
  try {
    publish('ticket.receipt', {
      issuer: ownerDid,
      subject: ownerDid,
      scope: 'events',
      payload: {
        email: customerEmail,
        buyerName: customerName || undefined,
        eventTitle: event.title,
        eventDate: formattedEventDate,
        eventTime: formattedEventTime,
        ticketSummary: [{ typeName: firstType.name, quantity, unitPrice }],
        totalPaid: formattedTotal,
        paymentMethod: paymentId ? 'Credit Card' : 'E-Transfer',
        registrationUrl,
        eventImageUrl,
        hasRegistrationRequired: anyPendingRegistration,
        context_id: event.id,
        context_type: 'event',
      },
    }).catch((err) => log.error({ customerEmail, err: String(err) }, '[webhook] Purchase receipt publish error'));
  } catch (emailError) {
    log.error({ customerEmail, err: String(emailError) }, '[webhook] Purchase receipt publish failed');
  }

  // Only publish the ticket confirmation (with QR) immediately for no-registration tickets
  if (bundleTickets.length > 0) {
    try {
      const ticketsWithQr = await Promise.all(
        bundleTickets.map(async (t) => ({
          id: t.id,
          qrCodeDataUri: await generateQRCode(t.id),
        }))
      );
      const bundleCents = bundleTickets.reduce((sum, t) => sum + (t.pricePaid ?? 0), 0);
      const bundleFormatted = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency.toUpperCase(),
      }).format(bundleCents / 100);

      publish('ticket.confirmed', {
        issuer: ownerDid,
        subject: ownerDid,
        scope: 'events',
        payload: {
          to: customerEmail,
          email: customerEmail,
          eventTitle: event.title,
          ticketType: firstType.name,
          ticketId: bundleTickets[0].id,
          eventDate: formattedEventDate,
          eventTime: formattedEventTime,
          isVirtual: event.isVirtual ?? false,
          venue: event.venue ?? undefined,
          price: bundleFormatted,
          magicLink,
          eventImageUrl,
          eventUrl: eventUrl(EVENTS_URL, event.id),
          tickets: ticketsWithQr,
          context_id: event.id,
          context_type: 'event',
        },
      }).catch((err) => log.error({ customerEmail, err: String(err) }, '[webhook] Ticket confirmed publish error'));
    } catch (emailError) {
      log.error({ customerEmail, err: String(emailError) }, '[webhook] Ticket confirmation publish failed');
    }
  }
}

async function handlePaymentFailed(payload: PaymentWebhookPayload) {
  const { metadata, customerEmail } = payload;

  const [event] = await db
    .select()
    .from(events)
    .where(eq(events.id, metadata.eventId))
    .limit(1);

  if (!event) {
    log.error({ eventId: metadata.eventId }, 'Event not found for failed payment');
    return;
  }

  await db
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.id, metadata.ticketTypeId ?? ''))
    .limit(1);

  log.info({ customerEmail, eventTitle: event.title }, 'Payment failed');

  // Optionally send a "payment failed" email
  // For now, just log it - Stripe also sends their own failure emails
}
