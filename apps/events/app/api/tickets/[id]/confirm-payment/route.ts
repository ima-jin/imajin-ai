/**
 * POST /api/tickets/[id]/confirm-payment
 *
 * Confirms an e-Transfer payment for a held ticket.
 * Changes status from 'held' to 'valid' and records confirmation timestamp.
 * Requires event organizer auth.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { db, tickets, ticketTypes, events, orders } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { getClient } from '@imajin/db';
import { randomBytes } from 'crypto';
import { sendEmail, ticketConfirmationEmail, purchaseReceiptEmail, generateQRCode } from '@/src/lib/email';

const log = createLogger('events');
import { isEventOrganizer } from '@/src/lib/organizer';
import { eq, sql, and, inArray } from 'drizzle-orm';

const AUTH_URL = process.env.NEXT_PUBLIC_AUTH_URL || process.env.AUTH_URL || 'https://auth.imajin.ai';
const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { identity } = authResult;
  const did = identity.actingAs || identity.id;
  const { id } = await params;

  try {
    // Find the ticket
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, id)).limit(1);

    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    if (ticket.status !== 'held') {
      return NextResponse.json({ error: 'Ticket is not in held status' }, { status: 400 });
    }

    if (ticket.paymentMethod !== 'etransfer') {
      return NextResponse.json({ error: 'Ticket is not an e-Transfer hold' }, { status: 400 });
    }

    // Verify caller is an event organizer
    const orgCheck = await isEventOrganizer(ticket.eventId, did);
    if (!orgCheck.authorized) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const now = new Date();

    // If the ticket belongs to an order (multi-ticket EMT), confirm every
    // held sibling in the order atomically. Single e-Transfer pays for the
    // whole order; partial confirmation would leave it in a half-state.
    let confirmedTickets: (typeof tickets.$inferSelect)[];
    if (ticket.orderId) {
      confirmedTickets = await db
        .update(tickets)
        .set({
          status: 'valid',
          purchasedAt: now,
          paymentConfirmedAt: now,
          heldBy: null,
          heldUntil: null,
          holdExpiresAt: null,
        })
        .where(and(eq(tickets.orderId, ticket.orderId), eq(tickets.status, 'held')))
        .returning();

      // Mark the order completed
      await db
        .update(orders)
        .set({ status: 'completed', purchasedAt: now })
        .where(eq(orders.id, ticket.orderId));
    } else {
      const [single] = await db
        .update(tickets)
        .set({
          status: 'valid',
          purchasedAt: now,
          paymentConfirmedAt: now,
          heldBy: null,
          heldUntil: null,
          holdExpiresAt: null,
        })
        .where(eq(tickets.id, id))
        .returning();
      confirmedTickets = [single];
    }

    // Group confirmed tickets by ticket type and increment sold counts per type.
    // (Multi-type orders may confirm tickets across more than one type at once.)
    if (confirmedTickets.length > 0) {
      const byType = new Map<string, number>();
      for (const t of confirmedTickets) {
        byType.set(t.ticketTypeId, (byType.get(t.ticketTypeId) ?? 0) + 1);
      }
      for (const [ttId, count] of byType.entries()) {
        await db
          .update(ticketTypes)
          .set({ sold: sql`${ticketTypes.sold} + ${count}` })
          .where(eq(ticketTypes.id, ttId));
      }
    }

    // Fetch event to get creator DID for attestation
    const [event] = await db.select().from(events).where(eq(events.id, ticket.eventId)).limit(1);

    // Fire one ticket.purchased event per confirmed ticket so attribution
    // and downstream side-effects fire for each.
    for (const t of confirmedTickets) {
      publish('ticket.purchased', {
        issuer: t.ownerDid || '',
        subject: event?.creatorDid ?? t.eventId,
        scope: 'events',
        payload: {
          ticketId: t.id,
          eventId: t.eventId,
          amount: t.pricePaid ?? 0,
          currency: t.currency || 'USD',
          context_id: t.eventId,
          context_type: 'event',
        },
      }).catch((err) => log.error({ err: String(err) }, 'Publish error'));
    }

    // Send the buyer their purchase receipt + ticket confirmation (with QRs).
    // Mirrors what the Stripe webhook does on a successful charge.
    if (event) {
      try {
        const authSql = getClient();

        // Resolve buyer email — try contact_email on the owner DID first.
        const buyerDid = confirmedTickets[0].ownerDid;
        let customerEmail: string | null = null;
        let customerName: string | null = null;
        if (buyerDid) {
          const rows = await authSql<{ contact_email: string | null; name: string | null }[]>`
            SELECT contact_email, name FROM auth.identities WHERE id = ${buyerDid} LIMIT 1
          `;
          customerEmail = rows[0]?.contact_email ?? null;
          customerName = rows[0]?.name ?? null;
        }

        if (customerEmail) {
          // Resolve ticket type rows for the confirmed tickets so we can show
          // names/prices in the receipt and confirmation emails.
          const typeIds = Array.from(new Set(confirmedTickets.map((t) => t.ticketTypeId)));
          const typeRows = await db
            .select()
            .from(ticketTypes)
            .where(inArray(ticketTypes.id, typeIds));
          const typesById = new Map(typeRows.map((t) => [t.id, t]));

          // Build per-type summary for the receipt
          const summary = new Map<string, { typeName: string; quantity: number; unitPrice: number; currency: string }>();
          let totalCents = 0;
          for (const t of confirmedTickets) {
            const tt = typesById.get(t.ticketTypeId);
            const key = t.ticketTypeId;
            const existing = summary.get(key);
            if (existing) {
              existing.quantity += 1;
            } else {
              summary.set(key, {
                typeName: tt?.name ?? 'Ticket',
                quantity: 1,
                unitPrice: t.pricePaid ?? tt?.price ?? 0,
                currency: t.currency || tt?.currency || 'CAD',
              });
            }
            totalCents += t.pricePaid ?? tt?.price ?? 0;
          }
          const currency = confirmedTickets[0].currency || 'CAD';
          const fmt = (cents: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(cents / 100);
          const totalFormatted = fmt(totalCents);

          const eventDate = new Date(event.startsAt);
          const formattedEventDate = eventDate.toLocaleDateString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
          });
          const formattedEventTime = eventDate.toLocaleTimeString('en-US', {
            hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
          });
          const eventImageUrl = event.imageUrl
            ? (event.imageUrl.startsWith('http') ? event.imageUrl : `${EVENTS_URL}${event.imageUrl}`)
            : undefined;

          // Mint a magic-link onboard token so the buyer can log in straight
          // from the email and view their tickets.
          let onboardToken: string | null = null;
          try {
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
          } catch (err) {
            log.error({ err: String(err) }, 'Onboard token creation failed (non-fatal)');
            onboardToken = null;
          }
          const magicLink = onboardToken
            ? `${AUTH_URL}/api/onboard/verify?token=${onboardToken}`
            : `${EVENTS_URL}/${event.id}/my-tickets`;

          // Determine if any confirmed type still requires registration
          const anyRegistrationRequired = Array.from(typesById.values()).some(
            (tt) => tt.requiresRegistration
          );
          const registrationUrl = anyRegistrationRequired
            ? `${EVENTS_URL}/${event.id}/register/${confirmedTickets[0].id}`
            : `${EVENTS_URL}/${event.id}/my-tickets`;

          // 1. Purchase receipt (always)
          await sendEmail({
            to: customerEmail,
            subject: `Purchase receipt — ${event.title}`,
            html: purchaseReceiptEmail({
              buyerName: customerName || undefined,
              eventTitle: event.title,
              eventDate: formattedEventDate,
              eventTime: formattedEventTime,
              ticketSummary: Array.from(summary.values()).map((s) => ({
                typeName: s.typeName,
                quantity: s.quantity,
                unitPrice: fmt(s.unitPrice),
              })),
              totalPaid: totalFormatted,
              paymentMethod: 'E-Transfer',
              registrationUrl,
              eventImageUrl,
              hasRegistrationRequired: anyRegistrationRequired,
            }),
          }).catch((err) => log.error({ err: String(err) }, 'Receipt email failed'));

          // 2. Ticket confirmation with QR codes (only if no registration
          //    is required — otherwise the user gets the QR after they finish
          //    registering, same pattern as Stripe webhook).
          if (!anyRegistrationRequired) {
            const ticketsWithQr = await Promise.all(
              confirmedTickets.map(async (t) => ({
                id: t.id,
                qrCodeDataUri: await generateQRCode(t.id),
              }))
            );
            const primaryType = typesById.get(confirmedTickets[0].ticketTypeId);
            await sendEmail({
              to: customerEmail,
              subject: `You're in — ${event.title}`,
              html: ticketConfirmationEmail({
                eventTitle: event.title,
                ticketType: primaryType?.name ?? 'Ticket',
                ticketId: confirmedTickets[0].id,
                eventDate: formattedEventDate,
                eventTime: formattedEventTime,
                isVirtual: event.isVirtual ?? false,
                venue: event.venue ?? undefined,
                price: totalFormatted,
                magicLink,
                eventImageUrl,
                eventUrl: `${EVENTS_URL}/${event.id}`,
                tickets: ticketsWithQr,
              }),
            }).catch((err) => log.error({ err: String(err) }, 'Ticket confirmation email failed'));
          }
        } else {
          log.warn({ buyerDid }, 'No buyer email available on EMT confirm; skipping receipt + ticket emails');
        }
      } catch (emailErr) {
        log.error({ err: String(emailErr) }, 'EMT confirm email block failed');
      }
    }

    return NextResponse.json({
      ticket: confirmedTickets[0],
      confirmedCount: confirmedTickets.length,
      orderId: ticket.orderId ?? null,
    });
  } catch (error) {
    log.error({ err: String(error) }, 'confirm-payment error');
    return NextResponse.json({ error: 'Failed to confirm payment' }, { status: 500 });
  }
}
