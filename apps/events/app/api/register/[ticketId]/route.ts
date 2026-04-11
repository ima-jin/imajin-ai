/**
 * POST /api/register/[ticketId]
 * GET  /api/register/[ticketId]
 *
 * Per-ticket registration API.
 * POST creates a registration for a pending ticket.
 * GET returns the existing registration for a ticket.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { db, tickets, events, ticketTypes, ticketRegistrations } from '@/src/db';

const log = createLogger('events');
import { eq, and } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { sendEmail, ticketConfirmationEmail, generateQRCode } from '@/src/lib/email';
import { notify } from '@imajin/notify';

export async function POST(
  request: NextRequest,
  { params }: { params: { ticketId: string } }
) {
  try {
    const { ticketId } = params;

    const body = await request.json();
    const { name, email, formId, responseId, registeredByDid } = body;

    if (!formId) {
      return NextResponse.json(
        { error: 'formId is required' },
        { status: 400 }
      );
    }

    // Name/email required only for simple forms (no Dykil survey)
    const isDykilForm = formId.startsWith('survey_');
    if (!isDykilForm && (!name || !email)) {
      return NextResponse.json(
        { error: 'name and email are required' },
        { status: 400 }
      );
    }

    // Load ticket
    const [ticket] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1);

    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    if (ticket.registrationStatus !== 'pending') {
      return NextResponse.json(
        { error: `Ticket registration status is '${ticket.registrationStatus}', expected 'pending'` },
        { status: 409 }
      );
    }

    // Load event for config checks
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, ticket.eventId))
      .limit(1);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    const regConfig = (event.registrationConfig || {}) as {
      enforce_unique_emails?: boolean;
      registration_deadline?: string;
    };

    // Check registration deadline
    if (regConfig.registration_deadline) {
      const deadline = new Date(regConfig.registration_deadline);
      if (new Date() > deadline) {
        return NextResponse.json(
          { error: 'Registration deadline has passed' },
          { status: 422 }
        );
      }
    }

    // Check email uniqueness across event
    if (regConfig.enforce_unique_emails && email) {
      const [existing] = await db
        .select({ id: ticketRegistrations.id })
        .from(ticketRegistrations)
        .where(
          and(
            eq(ticketRegistrations.eventId, event.id),
            eq(ticketRegistrations.email, email.toLowerCase().trim())
          )
        )
        .limit(1);

      if (existing) {
        return NextResponse.json(
          { error: 'An registration with this email already exists for this event' },
          { status: 409 }
        );
      }
    }

    const registrationId = `reg_${randomBytes(8).toString('hex')}`;

    const [registration] = await db
      .insert(ticketRegistrations)
      .values({
        id: registrationId,
        ticketId: ticket.id,
        eventId: event.id,
        name: name?.trim() || null,
        email: email?.toLowerCase().trim() || null,
        formId,
        responseId: responseId || null,
        registeredByDid: registeredByDid || null,
      })
      .returning();

    await db
      .update(tickets)
      .set({ registrationStatus: 'complete' })
      .where(eq(tickets.id, ticket.id));

    // Notify attendee — fire and forget
    if (ticket.ownerDid && registration.email) {
      notify.send({
        to: ticket.ownerDid,
        scope: "event:registration",
        data: {
          email: registration.email,
          eventTitle: event.title,
        },
      }).catch((err) => log.error({ err: String(err) }, 'Notify error'));

      // Record interest signal — event.rsvp → events scope
      notify.interest({ did: ticket.ownerDid, attestationType: 'event.rsvp' })
        .catch((err) => log.error({ err: String(err) }, 'Interest signal error'));
    }

    // Send ticket confirmation email to the registered attendee (skip if no email, e.g. Dykil form)
    if (registration.email) try {
      const [ticketType] = await db
        .select()
        .from(ticketTypes)
        .where(eq(ticketTypes.id, ticket.ticketTypeId))
        .limit(1);

      const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai';
      const eventDate = new Date(event.startsAt);
      const eventImageUrl = event.imageUrl
        ? (event.imageUrl.startsWith('http') ? event.imageUrl : `${EVENTS_URL}${event.imageUrl}`)
        : undefined;

      const qrCodeDataUri = await generateQRCode(ticket.id);

      await sendEmail({
        to: registration.email,
        subject: `You're in — ${event.title}`,
        html: ticketConfirmationEmail({
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
          price: ticket.pricePaid != null
            ? new Intl.NumberFormat('en-US', {
                style: 'currency',
                currency: ticket.currency || 'USD',
              }).format(ticket.pricePaid / 100)
            : 'Included',
          magicLink: `${EVENTS_URL}/${event.id}`,
          eventImageUrl,
          eventUrl: `${EVENTS_URL}/${event.id}`,
          qrCodeDataUri,
        }),
      });
    } catch (emailError) {
      // Non-fatal: log but don't fail the registration
      log.error({ err: String(emailError) }, 'Failed to send ticket confirmation email after registration');
    }

    return NextResponse.json({ success: true, registration });

  } catch (error) {
    log.error({ err: String(error) }, 'Registration error');
    return NextResponse.json(
      { error: 'Failed to create registration' },
      { status: 500 }
    );
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: { ticketId: string } }
) {
  try {
    const { ticketId } = params;

    const [registration] = await db
      .select()
      .from(ticketRegistrations)
      .where(eq(ticketRegistrations.ticketId, ticketId))
      .limit(1);

    if (!registration) {
      return NextResponse.json({ error: 'Registration not found' }, { status: 404 });
    }

    return NextResponse.json({ registration });

  } catch (error) {
    log.error({ err: String(error) }, 'Registration lookup error');
    return NextResponse.json(
      { error: 'Failed to look up registration' },
      { status: 500 }
    );
  }
}
