/**
 * POST /api/checkout/free
 * 
 * RSVP for a free event. Creates a ticket directly without Stripe.
 * Handles both authenticated users (hard DID) and anonymous users (soft DID via email).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, events, ticketTypes, tickets, eventInvites } from '@/src/db';
import { eq, and, sql } from 'drizzle-orm';
import { optionalAuth } from '@imajin/auth';
import { rateLimit, getClientIP } from '@/src/lib/rate-limit';
import { sendEmail, ticketConfirmationEmail, generateQRCode } from '@/src/lib/email';
import { emitAttestation } from '@imajin/auth';
import { notify } from '@imajin/notify';
import { getClient } from '@imajin/db';
import { randomBytes } from 'crypto';

const AUTH_URL = process.env.AUTH_SERVICE_URL || process.env.AUTH_URL || 'http://localhost:3001';
const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL!;
const PROFILE_URL = process.env.PROFILE_URL!;

interface FreeCheckoutRequest {
  eventId: string;
  ticketTypeId: string;
  email?: string;
  name?: string;
  invite?: string;
}

/**
 * Create or retrieve a soft DID from email.
 */
async function getOrCreateSoftDid(email: string, name?: string): Promise<string> {
  const response = await fetch(`${AUTH_URL}/api/session/soft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: email.toLowerCase().trim(),
      name: name?.trim(),
    }),
  });

  if (!response.ok) {
    throw new Error(`Soft DID creation failed: ${response.status}`);
  }

  const data = await response.json();
  return data.did;
}

/**
 * Attach email to an existing hard DID profile (if not already set).
 */
async function attachEmailToProfile(did: string, email: string): Promise<void> {
  try {
    const normalizedEmail = email.toLowerCase().trim();
    await db.execute(
      sql`UPDATE profile.profiles SET contact_email = ${normalizedEmail} WHERE did = ${did} AND (contact_email IS NULL OR contact_email = '')`
    );
  } catch (error) {
    console.error('attachEmailToProfile error:', error);
  }
}

export async function POST(request: NextRequest) {
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
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, body.eventId))
      .limit(1);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    if (event.status !== 'published') {
      return NextResponse.json({ error: 'Event is not published' }, { status: 400 });
    }

    // Invite-only access check
    let inviteRecord: typeof eventInvites.$inferSelect | undefined;
    if (event.accessMode === 'invite_only') {
      const token = body.invite;
      if (!token) {
        return NextResponse.json({ error: 'This event requires an invite link' }, { status: 403 });
      }

      const [invite] = await db
        .select()
        .from(eventInvites)
        .where(and(eq(eventInvites.eventId, body.eventId), eq(eventInvites.token, token)))
        .limit(1);

      if (!invite) {
        return NextResponse.json({ error: 'Invalid invite token' }, { status: 403 });
      }

      if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
        return NextResponse.json({ error: 'This invite link has expired' }, { status: 403 });
      }

      if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) {
        return NextResponse.json({ error: 'This invite link has reached its maximum uses' }, { status: 403 });
      }

      inviteRecord = invite;
    }

    // Fetch ticket type and verify it's free
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

    if (ticketType.price !== 0) {
      return NextResponse.json({ error: 'This ticket is not free' }, { status: 400 });
    }

    // Check availability
    if (ticketType.quantity !== null) {
      const available = ticketType.quantity - (ticketType.sold ?? 0);
      if (available < 1) {
        return NextResponse.json({ error: 'No spots remaining' }, { status: 400 });
      }
    }

    // Resolve owner DID
    const session = await optionalAuth(request);
    let ownerDid: string;
    let ownerEmail: string | null = null;

    if (session && session.tier !== 'soft') {
      // Logged in with hard DID
      ownerDid = session.id;

      // Try to get their email from profile
      try {
        const [profile] = await db.execute(
          sql`SELECT contact_email FROM profile.profiles WHERE did = ${ownerDid} LIMIT 1`
        ) as any[];
        ownerEmail = profile?.contact_email || body.email || null;
      } catch {
        ownerEmail = body.email || null;
      }

      if (body.email) {
        await attachEmailToProfile(ownerDid, body.email);
      }
    } else if (body.email) {
      // Anonymous — create soft DID
      ownerDid = await getOrCreateSoftDid(body.email, body.name);
      ownerEmail = body.email;
    } else {
      return NextResponse.json(
        { error: 'Please provide an email address to RSVP' },
        { status: 400 }
      );
    }

    // Idempotency: check if this DID already has a ticket for this event
    const [existingTicket] = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(
          eq(tickets.eventId, event.id),
          eq(tickets.ownerDid, ownerDid),
          eq(tickets.ticketTypeId, ticketType.id)
        )
      )
      .limit(1);

    if (existingTicket) {
      return NextResponse.json(
        { error: 'You already have a ticket for this event', ticketId: existingTicket.id },
        { status: 409 }
      );
    }

    // Create ticket
    const ticketId = `tkt_${Date.now().toString(36)}_0`;

    const [ticket] = await db.insert(tickets).values({
      id: ticketId,
      eventId: event.id,
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

    // Update sold count
    await db
      .update(ticketTypes)
      .set({ sold: sql`${ticketTypes.sold} + 1` })
      .where(eq(ticketTypes.id, ticketType.id));

    // Increment invite used count
    if (inviteRecord) {
      await db
        .update(eventInvites)
        .set({ usedCount: inviteRecord.usedCount + 1 })
        .where(eq(eventInvites.id, inviteRecord.id));
    }

    // Emit attestation (fire and forget)
    emitAttestation({
      issuer_did: ownerDid,
      subject_did: event.creatorDid,
      type: 'ticket.purchased',
      context_id: event.id,
      context_type: 'event',
      payload: { ticketId: ticket.id, amount: 0, currency: ticketType.currency },
    }).catch((err) => console.error('Attestation emit error:', err));

    // Notify (fire and forget)
    notify.send({
      to: ownerDid,
      scope: 'event:ticket',
      data: {
        email: ownerEmail,
        eventTitle: event.title,
        ticketType: ticketType.name,
        amount: 0,
        currency: ticketType.currency,
      },
    }).catch((err) => console.error('Notify error:', err));

    // Interest signal
    notify.interest({ did: ownerDid, attestationType: 'ticket.purchased' })
      .catch((err) => console.error('Interest signal error:', err));

    // Add to event chat (fire and forget)
    const CHAT_URL = process.env.CHAT_SERVICE_URL || process.env.CHAT_URL;
    if (CHAT_URL) {
      fetch(`${CHAT_URL}/api/d/${encodeURIComponent(event.did)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberDid: ownerDid, role: 'member' }),
      }).catch((err) => console.warn('Event chat member sync failed (non-fatal):', err));
    }

    // Send confirmation email if we have an email
    if (ownerEmail) {
      try {
        const eventDate = new Date(event.startsAt);
        const formattedDate = eventDate.toLocaleDateString('en-US', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        });
        const formattedTime = eventDate.toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
        });

        // Create onboard token for magic link
        let magicLink: string | undefined;
        try {
          const authSql = getClient();
          const onboardToken = randomBytes(36).toString('hex');
          const onboardId = `obt_${randomBytes(8).toString('hex')}`;
          await authSql`
            INSERT INTO auth.onboard_tokens (id, email, name, token, redirect_url, context, expires_at)
            VALUES (
              ${onboardId},
              ${ownerEmail.toLowerCase().trim()},
              ${body.name || null},
              ${onboardToken},
              ${`${EVENTS_URL}/${event.id}`},
              ${'access your RSVP for ' + event.title},
              ${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()}
            )
          `;
          magicLink = `${AUTH_URL}/api/onboard/verify?token=${onboardToken}`;
        } catch (err) {
          console.error('Onboard token creation failed (non-fatal):', err);
        }

        const qrCodeDataUri = await generateQRCode(ticketId);
        const eventImageUrl = event.imageUrl
          ? (event.imageUrl.startsWith('http') ? event.imageUrl : `${EVENTS_URL}${event.imageUrl}`)
          : undefined;

        await sendEmail({
          to: ownerEmail,
          subject: `You're in — ${event.title}`,
          html: ticketConfirmationEmail({
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
            eventUrl: `${EVENTS_URL}/${event.id}`,
            qrCodeDataUri,
          }),
        });
      } catch (emailError) {
        console.error('Confirmation email failed (non-fatal):', emailError);
      }
    }

    return NextResponse.json({
      success: true,
      ticketId: ticket.id,
      message: 'RSVP confirmed',
    });

  } catch (error) {
    console.error('Free checkout error:', error);
    return NextResponse.json(
      { error: 'RSVP failed' },
      { status: 500 }
    );
  }
}
