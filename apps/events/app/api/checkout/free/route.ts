/**
 * POST /api/checkout/free
 * 
 * RSVP for a free event. Creates a ticket directly without Stripe.
 * Handles both authenticated users (hard DID) and anonymous users (soft DID via email).
 */

import { NextResponse } from 'next/server';
import { withLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import {
  resolveInviteAccessForEvent,
  loadPublishedEvent,
  syncBuyerToEventChatFireAndForget,
  CheckoutValidationError,
} from '@/src/lib/checkout-common';
import { rateLimit, getClientIP } from '@imajin/config';
import {
  resolveFreeTicketType,
  resolveFreeRsvpOwner,
  checkExistingFreeTicket,
  createFreeTicket,
  sendFreeConfirmationEmail,
} from '@/src/lib/free-checkout-helpers';

const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL!;

interface FreeCheckoutRequest {
  eventId: string;
  ticketTypeId: string;
  email?: string;
  name?: string;
  invite?: string;
}

export const POST = withLogger('events', async (request, { log }) => {
  const ip = getClientIP(request);
  const rl = rateLimit(ip, 10, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    );
  }

  try {
    const body: FreeCheckoutRequest = await request.json();

    if (!body.eventId || !body.ticketTypeId) {
      return NextResponse.json(
        { error: 'eventId and ticketTypeId are required' },
        { status: 400 }
      );
    }

    // Fetch event
    const eventResult = await loadPublishedEvent(body.eventId, 'Event is not published');
    if ('error' in eventResult) {
      return NextResponse.json({ error: eventResult.error }, { status: eventResult.status });
    }
    const { event } = eventResult;

    // Invite-only access check
    const inviteRecord = await resolveInviteAccessForEvent(event, body.invite);

    // Fetch ticket type and verify it's free + available
    const ticketTypeResult = await resolveFreeTicketType(body.eventId, body.ticketTypeId);
    if ('error' in ticketTypeResult) {
      return NextResponse.json({ error: ticketTypeResult.error }, { status: ticketTypeResult.status });
    }
    const { ticketType } = ticketTypeResult;

    // Resolve owner DID via the canonical checkout-identity primitive.
    // Free RSVP needs a ticket owner immediately, so createSoftDid is set:
    // hard session → that DID; otherwise mint/resolve a soft DID from email.
    const ownerResult = await resolveFreeRsvpOwner(request, body, log);
    if (ownerResult instanceof NextResponse) {
      return ownerResult;
    }
    const { ownerDid, ownerEmail } = ownerResult;

    // Idempotency: check if this DID already has a ticket for this event
    const existingTicketResponse = await checkExistingFreeTicket(event.id, ownerDid, ticketType.id);
    if (existingTicketResponse) {
      return existingTicketResponse;
    }

    const ticket = await createFreeTicket({
      eventId: event.id,
      ticketType,
      ownerDid,
      ownerEmail,
      inviteRecord,
    });

    publish('ticket.purchased', {
      issuer: ownerDid,
      subject: event.creatorDid,
      scope: 'events',
      payload: {
        ticketId: ticket.id,
        eventId: event.id,
        amount: 0,
        currency: ticketType.currency,
        context_id: event.id,
        context_type: 'event',
        interestDids: [ownerDid],
      },
    }).catch((err) => log.error({ err: String(err) }, 'Publish error'));

    // Add to event chat (fire and forget)
    syncBuyerToEventChatFireAndForget(event.did, ownerDid, log);

    // Send confirmation email if we have an email
    if (ownerEmail) {
      await sendFreeConfirmationEmail({
        event,
        ticketType,
        ticketId: ticket.id,
        ownerDid,
        ownerEmail,
        name: body.name,
        eventsUrl: EVENTS_URL,
        log,
      });
    }

    return NextResponse.json({
      success: true,
      ticketId: ticket.id,
      message: 'RSVP confirmed',
    });

  } catch (error) {
    if (error instanceof CheckoutValidationError) {
      return NextResponse.json(
        { error: error.message, ...(error.field ? { field: error.field } : {}) },
        { status: error.statusCode },
      );
    }
    log.error({ err: String(error) }, 'Free checkout error');
    return NextResponse.json(
      { error: 'RSVP failed' },
      { status: 500 }
    );
  }
});
