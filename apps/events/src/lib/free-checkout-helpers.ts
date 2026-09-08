/**
 * Helpers for the free (RSVP) checkout route.
 * Extracted from app/api/checkout/free/route.ts to reduce cognitive complexity.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, ticketTypes, tickets, eventInvites } from '@/src/db';
import { eq, and, sql } from 'drizzle-orm';
import { optionalAuth } from '@imajin/auth';
import { resolveCheckoutIdentity } from '@/src/lib/checkout-common';
import { eventUrl } from '@imajin/config';
import { generateQRCode } from '@/src/lib/email';
import { publish } from '@imajin/bus';
import { getClient } from '@imajin/db';
import { randomBytes } from 'node:crypto';
import type { Logger } from '@imajin/logger';
import type { TicketType, Ticket, EventInvite } from '@/src/db/schema';

const AUTH_URL = process.env.AUTH_SERVICE_URL || process.env.AUTH_URL || 'http://localhost:3001';

// ---------------------------------------------------------------------------
// Ticket type resolution
// ---------------------------------------------------------------------------

function checkFreeTicketAvailability(ticketType: TicketType): { error: string; status: number } | null {
  if (ticketType.quantity === null) return null;
  const available = ticketType.quantity - (ticketType.sold ?? 0);
  if (available < 1) {
    return { error: 'No spots remaining', status: 400 };
  }
  return null;
}

/**
 * Fetch a ticket type for the event and confirm it's free and available.
 */
export async function resolveFreeTicketType(
  eventId: string,
  ticketTypeId: string,
): Promise<{ ticketType: TicketType } | { error: string; status: number }> {
  const [ticketType] = await db
    .select()
    .from(ticketTypes)
    .where(and(eq(ticketTypes.id, ticketTypeId), eq(ticketTypes.eventId, eventId)))
    .limit(1);

  if (!ticketType) {
    return { error: 'Ticket type not found', status: 404 };
  }
  if (ticketType.price !== 0) {
    return { error: 'This ticket is not free', status: 400 };
  }

  const availabilityError = checkFreeTicketAvailability(ticketType);
  if (availabilityError) return availabilityError;

  return { ticketType };
}

// ---------------------------------------------------------------------------
// Owner resolution
// ---------------------------------------------------------------------------

export interface FreeRsvpOwner {
  ownerDid: string;
  ownerEmail: string | null;
}

/**
 * Resolve the ticket owner for a free RSVP via the canonical checkout-identity
 * primitive. A hard session resolves to that DID; otherwise a soft DID is
 * minted from the provided email (an email is required in that case).
 */
export async function resolveFreeRsvpOwner(
  request: NextRequest,
  body: { email?: string; name?: string },
  log: Logger,
): Promise<FreeRsvpOwner | NextResponse> {
  if (!body.email) {
    const probe = await optionalAuth(request);
    if (!probe || probe.tier === 'soft') {
      return NextResponse.json(
        { error: 'Please provide an email address to RSVP' },
        { status: 400 },
      );
    }
  }

  const resolved = await resolveCheckoutIdentity(
    request,
    { email: body.email, name: body.name },
    log,
    { createSoftDid: true },
  );

  if (!resolved.did) {
    return NextResponse.json(
      { error: 'Could not resolve a ticket owner — please provide an email address to RSVP' },
      { status: 400 },
    );
  }

  return { ownerDid: resolved.did, ownerEmail: resolved.email ?? null };
}

// ---------------------------------------------------------------------------
// Idempotency check
// ---------------------------------------------------------------------------

/**
 * Check whether the owner already has a ticket of this type for the event.
 * Returns the 409 response to return immediately, or null when clear to proceed.
 */
export async function checkExistingFreeTicket(
  eventId: string,
  ownerDid: string,
  ticketTypeId: string,
): Promise<NextResponse | null> {
  const [existingTicket] = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(
      and(
        eq(tickets.eventId, eventId),
        eq(tickets.ownerDid, ownerDid),
        eq(tickets.ticketTypeId, ticketTypeId),
      ),
    )
    .limit(1);

  if (!existingTicket) return null;

  return NextResponse.json(
    { error: 'You already have a ticket for this event', ticketId: existingTicket.id },
    { status: 409 },
  );
}

// ---------------------------------------------------------------------------
// Ticket creation
// ---------------------------------------------------------------------------

export interface CreateFreeTicketParams {
  eventId: string;
  ticketType: TicketType;
  ownerDid: string;
  ownerEmail: string | null;
  inviteRecord?: EventInvite;
}

/**
 * Create a free ticket, increment the sold count, and (when invite-only)
 * increment the invite's used count.
 */
export async function createFreeTicket(params: CreateFreeTicketParams): Promise<Ticket> {
  const { eventId, ticketType, ownerDid, ownerEmail, inviteRecord } = params;
  const ticketId = `tkt_${Date.now().toString(36)}_0`;

  const [ticket] = await db.insert(tickets).values({
    id: ticketId,
    eventId,
    ticketTypeId: ticketType.id,
    ownerDid,
    originalOwnerDid: ownerDid,
    pricePaid: 0,
    currency: ticketType.currency,
    paymentId: `free_${ticketId}`,
    paymentMethod: 'free',
    status: 'valid',
    purchasedAt: new Date(),
    signature: `free:${ticketId}:${ownerDid}`,
    registrationStatus: ticketType.requiresRegistration ? 'pending' : 'not_required',
    metadata: {
      rsvp: true,
      ...(ownerEmail && { purchaseEmail: ownerEmail }),
    },
  }).returning();

  await db
    .update(ticketTypes)
    .set({ sold: sql`${ticketTypes.sold} + 1` })
    .where(eq(ticketTypes.id, ticketType.id));

  if (inviteRecord) {
    await db
      .update(eventInvites)
      .set({ usedCount: inviteRecord.usedCount + 1 })
      .where(eq(eventInvites.id, inviteRecord.id));
  }

  return ticket;
}

// ---------------------------------------------------------------------------
// Confirmation email
// ---------------------------------------------------------------------------

async function createFreeOnboardMagicLink(
  email: string,
  name: string | undefined,
  redirectUrl: string,
  context: string,
  log: Logger,
): Promise<string | undefined> {
  try {
    const authSql = getClient();
    const onboardToken = randomBytes(36).toString('hex');
    const onboardId = `obt_${randomBytes(8).toString('hex')}`;
    await authSql`
      INSERT INTO auth.onboard_tokens (id, email, name, token, redirect_url, context, expires_at)
      VALUES (
        ${onboardId},
        ${email.toLowerCase().trim()},
        ${name || null},
        ${onboardToken},
        ${redirectUrl},
        ${context},
        ${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()}
      )
    `;
    return `${AUTH_URL}/api/onboard/verify?token=${onboardToken}`;
  } catch (err) {
    log.error({ err: String(err) }, 'Onboard token creation failed (non-fatal)');
    return undefined;
  }
}

function resolveFreeEventImageUrl(imageUrl: string | null | undefined, eventsBase: string): string | undefined {
  if (!imageUrl) return undefined;
  return imageUrl.startsWith('http') ? imageUrl : `${eventsBase}${imageUrl}`;
}

export interface FreeConfirmationParams {
  event: {
    id: string;
    title: string;
    startsAt: Date | string;
    imageUrl?: string | null;
    isVirtual?: boolean | null;
    venue?: string | null;
  };
  ticketType: { name: string };
  ticketId: string;
  ownerDid: string;
  ownerEmail: string;
  name?: string;
  eventsUrl: string;
  log: Logger;
}

/**
 * Send the RSVP confirmation email (with QR code + magic link). Fire-and-forget
 * — failures are logged, not thrown.
 */
export async function sendFreeConfirmationEmail(params: FreeConfirmationParams): Promise<void> {
  const { event, ticketType, ticketId, ownerDid, ownerEmail, name, eventsUrl, log } = params;

  try {
    const eventDate = new Date(event.startsAt);
    const formattedDate = eventDate.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const formattedTime = eventDate.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });

    const magicLink = await createFreeOnboardMagicLink(
      ownerEmail,
      name,
      eventUrl(eventsUrl, event.id),
      `access your RSVP for ${event.title}`,
      log,
    );

    const qrCodeDataUri = await generateQRCode(ticketId);
    const eventImageUrl = resolveFreeEventImageUrl(event.imageUrl, eventsUrl);

    publish('ticket.confirmed', {
      issuer: ownerDid,
      subject: ownerDid,
      scope: 'events',
      payload: {
        email: ownerEmail,
        eventTitle: event.title,
        ticketType: ticketType.name,
        ticketId,
        eventDate: formattedDate,
        eventTime: formattedTime,
        isVirtual: event.isVirtual ?? false,
        venue: event.venue ?? undefined,
        price: 'Free',
        magicLink: magicLink || '',
        eventImageUrl,
        eventUrl: eventUrl(eventsUrl, event.id),
        qrCodeDataUri,
        context_id: event.id,
        context_type: 'event',
      },
    }).catch((err) => log.error({ err: String(err) }, 'Ticket confirmed publish error'));
  } catch (emailError) {
    log.error({ err: String(emailError) }, 'Confirmation publish failed (non-fatal)');
  }
}
