/**
 * POST /api/register/[ticketId]
 * GET  /api/register/[ticketId]
 *
 * Per-ticket registration API.
 *   POST — verify the attendee's Dykil survey response exists, flip the ticket
 *          to 'complete', and emit the bus events that drive the
 *          "you're in" email + RSVP signal.
 *   GET  — return a backwards-compatible registration shape from the Dykil
 *          response.
 */

import { NextResponse } from 'next/server';
import { withLogger } from '@imajin/logger';
import { db, tickets, events, ticketTypes } from '@/src/db';
import { eq } from 'drizzle-orm';
import { getClient } from '@imajin/db';
import { publish } from '@imajin/bus';
import { generateQRCode } from '@/src/lib/email';
import { eventUrl } from '@imajin/config';

const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai';

export const POST = withLogger('events', async (request, { log }) => {
  const ticketId = request.nextUrl.pathname.split('/').pop()!;

  log.info({ ticketId }, 'registration POST attempt');

  // Load ticket
  const [ticket] = await db
    .select()
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);

  if (!ticket) {
    log.warn({ ticketId }, 'ticket not found');
    return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
  }

  log.info({ ticketId, currentStatus: ticket.registrationStatus }, 'ticket loaded');

  if (ticket.registrationStatus !== 'pending') {
    log.warn({ ticketId, regStatus: ticket.registrationStatus }, 'ticket not pending (idempotent)');
    return NextResponse.json(
      { error: `Ticket registration status is '${ticket.registrationStatus}', expected 'pending'` },
      { status: 409 }
    );
  }

  // Verify Dykil survey response exists for this ticket
  const sql = getClient();
  const [surveyResponse] = await sql<
    { id: string; answers: Record<string, unknown> }[]
  >`
    SELECT id, answers FROM dykil.survey_responses WHERE ticket_id = ${ticketId} LIMIT 1
  `;

  if (!surveyResponse) {
    log.warn({ ticketId }, 'no survey response found for ticket');
    return NextResponse.json(
      { error: 'No survey response found for this ticket' },
      { status: 404 }
    );
  }

  await db
    .update(tickets)
    .set({ registrationStatus: 'complete' })
    .where(eq(tickets.id, ticket.id));

  log.info({ ticketId }, 'registration status updated to complete');

  // Fire the post-registration notifications. The 'you're in' email for
  // reg-required tickets travels via ticket.registration.completed; the
  // event.registration / event.rsvp pair are for the broadcast + interest
  // signal pipeline. All publishes are fire-and-forget — a notification
  // failure must not roll back a successful registration.
  const answers = (surveyResponse.answers ?? {}) as Record<string, unknown>;
  const attendeeEmail =
    typeof answers.email === 'string' ? answers.email.trim().toLowerCase() : null;

  let qrCodeDataUri: string | undefined;
  try {
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, ticket.eventId))
      .limit(1);
    const [ticketType] = await db
      .select()
      .from(ticketTypes)
      .where(eq(ticketTypes.id, ticket.ticketTypeId))
      .limit(1);

    if (event && attendeeEmail) {
      const eventDate = new Date(event.startsAt);
      let eventImageUrl: string | undefined;
      if (event.imageUrl) {
        eventImageUrl = event.imageUrl.startsWith('http') ? event.imageUrl : `${EVENTS_URL}${event.imageUrl}`;
      }

      qrCodeDataUri = await generateQRCode(ticket.id);

      publish('event.registration', {
        issuer: ticket.ownerDid || '',
        subject: ticket.ownerDid || '',
        scope: 'events',
        payload: {
          eventTitle: event.title,
          email: attendeeEmail,
          context_id: event.id,
          context_type: 'event',
        },
      }).catch((err) => log.error({ err: String(err) }, 'event.registration publish failed'));

      if (ticket.ownerDid) {
        publish('event.rsvp', {
          issuer: ticket.ownerDid,
          subject: '',
          scope: 'events',
          payload: {
            context_id: event.id,
            context_type: 'event',
            interestDids: [ticket.ownerDid],
          },
        }).catch((err) => log.error({ err: String(err) }, 'event.rsvp publish failed'));
      }

      publish('ticket.registration.completed', {
        issuer: ticket.ownerDid || '',
        subject: ticket.ownerDid || '',
        scope: 'events',
        payload: {
          email: attendeeEmail,
          eventTitle: event.title,
          ticketType: ticketType?.name ?? 'Ticket',
          ticketId: ticket.id,
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
          price:
            ticket.pricePaid != null
              ? new Intl.NumberFormat('en-US', {
                  style: 'currency',
                  currency: ticket.currency || 'USD',
                }).format(ticket.pricePaid / 100)
              : 'Included',
          magicLink: eventUrl(EVENTS_URL, event.id),
          eventImageUrl,
          eventUrl: eventUrl(EVENTS_URL, event.id),
          qrCodeDataUri,
          context_id: event.id,
          context_type: 'event',
        },
      }).catch((err) =>
        log.error({ err: String(err) }, 'ticket.registration.completed publish failed'),
      );

      log.info(
        { ticketId, hasQr: !!qrCodeDataUri },
        'registration completion events published',
      );
    } else if (!attendeeEmail) {
      log.info(
        { ticketId },
        'no attendee email in survey answers; skipping registration emails',
      );
    }
  } catch (err) {
    // Non-fatal: registration is already 'complete' in the DB.
    log.error({ err: String(err) }, 'failed to publish registration completion events');
  }

  return NextResponse.json({ success: true, qrCodeDataUri });
});

export const GET = withLogger('events', async (request) => {
  const ticketId = request.nextUrl.pathname.split('/').pop()!;

  const sql = getClient();
  const [response] = await sql`
    SELECT id, survey_id, answers, created_at
    FROM dykil.survey_responses
    WHERE ticket_id = ${ticketId}
    LIMIT 1
  `;

  if (!response) {
    return NextResponse.json({ error: 'Registration not found' }, { status: 404 });
  }

  // Backwards-compatible shape
  const registration = {
    id: response.id,
    ticketId,
    formId: response.survey_id,
    responseId: response.id,
    name: response.answers?.full_name || response.answers?.name || null,
    email: response.answers?.email || null,
    registeredAt: response.created_at,
  };

  return NextResponse.json({ registration });
});
