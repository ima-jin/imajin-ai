import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { randomBytes } from 'crypto';

const log = createLogger('events');
import { eq, and } from 'drizzle-orm';
import { requireAuth, getEmailForDid } from '@imajin/auth';
import { isEventOrganizer } from '@/src/lib/organizer';
import { db, tickets, events, ticketTypes, ticketRegistrations } from '@/src/db';
import { getClient } from '@imajin/db';
import { sendEmail, generateQRCode, ticketConfirmationEmail, registrationReminderEmail } from '@/src/lib/email';

const AUTH_URL = process.env.AUTH_URL || process.env.AUTH_SERVICE_URL || 'https://auth.imajin.ai';
const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai';

function redactEmail(email: string): string {
  const atIdx = email.indexOf('@');
  if (atIdx < 0) return '***';
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);
  const redacted = local.length > 2
    ? `${local[0]}***${local[local.length - 1]}`
    : '***';
  return `${redacted}@${domain}`;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; ticketId: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { identity } = authResult;
  const did = identity.actingAs || identity.id;
  const { id: eventId, ticketId } = await params;

  try {
    const orgCheck = await isEventOrganizer(eventId, did);
    if (!orgCheck.authorized) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const [ticket] = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.eventId, eventId)))
      .limit(1);
    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    // Rate limit: 3-day cooldown between resends
    const COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
    if (ticket.lastEmailSentAt) {
      const elapsed = Date.now() - new Date(ticket.lastEmailSentAt).getTime();
      if (elapsed < COOLDOWN_MS) {
        const hoursLeft = Math.ceil((COOLDOWN_MS - elapsed) / (60 * 60 * 1000));
        return NextResponse.json(
          { error: `Email was recently sent. Try again in ~${hoursLeft}h.`, lastEmailSentAt: ticket.lastEmailSentAt },
          { status: 429 }
        );
      }
    }

    const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    const [ticketType] = await db
      .select()
      .from(ticketTypes)
      .where(eq(ticketTypes.id, ticket.ticketTypeId))
      .limit(1);
    if (!ticketType) {
      return NextResponse.json({ error: 'Ticket type not found' }, { status: 404 });
    }

    const [registration] = await db
      .select()
      .from(ticketRegistrations)
      .where(eq(ticketRegistrations.ticketId, ticketId))
      .limit(1);

    // Determine email: registration.email > profile.contact_email > auth credential
    let customerEmail: string | null = null;
    if (registration?.email) {
      customerEmail = registration.email;
    } else if (ticket.ownerDid) {
      // Try profile contact email (user's preferred transactional email)
      const profileSql = getClient();
      const profileRows = await profileSql`
        SELECT contact_email FROM profile.profiles WHERE did = ${ticket.ownerDid} LIMIT 1
      `;
      if (profileRows.length > 0 && profileRows[0].contact_email) {
        customerEmail = profileRows[0].contact_email;
      } else {
        // Fall back to auth credential (login email)
        customerEmail = await getEmailForDid(ticket.ownerDid);
      }
    }

    if (!customerEmail) {
      return NextResponse.json(
        { error: 'Could not determine email address for this ticket' },
        { status: 422 }
      );
    }

    // Mint a fresh onboard token in auth schema
    const authSql = getClient();
    const onboardToken = randomBytes(36).toString('hex');
    const onboardId = `obt_${randomBytes(8).toString('hex')}`;
    // Deep link to the specific ticket's registration page
    const redirectUrl = ticket.registrationStatus === 'pending'
      ? `${EVENTS_URL}/${event.id}/register/${ticket.id}`
      : `${EVENTS_URL}/${event.id}/my-tickets`;

    await authSql`
      INSERT INTO auth.onboard_tokens (id, email, name, token, redirect_url, context, expires_at)
      VALUES (
        ${onboardId},
        ${customerEmail.toLowerCase().trim()},
        ${registration?.name || null},
        ${onboardToken},
        ${redirectUrl},
        ${'access your ticket for ' + event.title},
        ${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()}
      )
    `;

    const magicLink = `${AUTH_URL}/api/onboard/verify?token=${onboardToken}`;

    const eventDate = new Date(event.startsAt);
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

    let emailResult;

    if (ticket.registrationStatus === 'pending') {
      emailResult = await sendEmail({
        to: customerEmail,
        subject: `Don't forget to register — ${event.title}`,
        html: registrationReminderEmail({
          eventTitle: event.title,
          eventDate: formattedEventDate,
          pendingCount: 1,
          registrationUrl: magicLink,
          eventImageUrl,
        }),
      });
    } else {
      const qrCodeDataUri = await generateQRCode(ticket.id);
      const formattedPrice =
        ticket.pricePaid !== null
          ? new Intl.NumberFormat('en-US', {
              style: 'currency',
              currency: (ticket.currency || 'USD').toUpperCase(),
            }).format(ticket.pricePaid / 100)
          : 'Free';

      emailResult = await sendEmail({
        to: customerEmail,
        subject: `You're in — ${event.title}`,
        html: ticketConfirmationEmail({
          eventTitle: event.title,
          ticketType: ticketType.name,
          ticketId: ticket.id,
          eventDate: formattedEventDate,
          eventTime: formattedEventTime,
          isVirtual: event.isVirtual ?? false,
          venue: event.venue ?? undefined,
          price: formattedPrice,
          magicLink,
          eventImageUrl,
          eventUrl: `${EVENTS_URL}/${event.id}`,
          qrCodeDataUri,
        }),
      });
    }

    if (!emailResult?.success) {
      log.error({ err: String(emailResult?.error) }, 'SendGrid delivery failed');
      return NextResponse.json(
        { error: 'Failed to deliver email. Check SendGrid configuration.' },
        { status: 502 }
      );
    }

    // Record the send timestamp
    const sentAt = new Date().toISOString();
    await db
      .update(tickets)
      .set({ lastEmailSentAt: new Date(sentAt) })
      .where(eq(tickets.id, ticketId));

    return NextResponse.json({ success: true, email: redactEmail(customerEmail), lastEmailSentAt: sentAt });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to resend ticket email');
    return NextResponse.json({ error: 'Failed to resend email' }, { status: 500 });
  }
}
