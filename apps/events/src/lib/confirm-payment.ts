/**
 * Shared confirmation logic for e-Transfer payments.
 * Used by both the per-ticket and per-order confirm-payment routes.
 */

import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { db, tickets, ticketTypes, events, orders } from '@/src/db';
import { getClient } from '@imajin/db';
import { randomBytes } from 'crypto';
import { generateQRCode } from '@/src/lib/email';
import { eq, sql, and, inArray } from 'drizzle-orm';

const log = createLogger('events');
const AUTH_URL = process.env.NEXT_PUBLIC_AUTH_URL || process.env.AUTH_URL || 'https://auth.imajin.ai';
const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai';

export interface ConfirmPaymentResult {
  confirmedTickets: (typeof tickets.$inferSelect)[];
  orderId: string | null;
}

/**
 * Confirm all held e-Transfer tickets in an order (or a single orphan ticket)
 * and send the buyer their receipt + ticket bundle email.
 */
export async function confirmHeldTickets(
  eventId: string,
  heldTickets: (typeof tickets.$inferSelect)[],
  orderId: string | null
): Promise<ConfirmPaymentResult> {
  const now = new Date();

  if (heldTickets.length === 0) {
    throw new Error('No held tickets to confirm');
  }

  const ticketIds = heldTickets.map((t) => t.id);

  const confirmedTickets = await db
    .update(tickets)
    .set({
      status: 'valid',
      purchasedAt: now,
      paymentConfirmedAt: now,
      heldBy: null,
      heldUntil: null,
      holdExpiresAt: null,
    })
    .where(and(inArray(tickets.id, ticketIds), eq(tickets.status, 'held')))
    .returning();

  if (orderId) {
    await db
      .update(orders)
      .set({ status: 'completed', purchasedAt: now })
      .where(eq(orders.id, orderId));
  }

  // Increment sold counts per ticket type
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

  // Fetch event for attestations + emails
  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);

  // Publish ticket.purchased attestations
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

  // Send buyer emails
  if (event) {
    try {
      const authSql = getClient();
      const buyerDid = confirmedTickets[0].ownerDid;
      let customerEmail: string | null = null;
      let customerName: string | null = null;
      if (buyerDid) {
        const rows = await authSql<{ contact_email: string | null; name: string | null }[]>`
          SELECT contact_email, name FROM auth.identities WHERE id = ${buyerDid} LIMIT 1
        `;
        customerEmail = rows[0]?.contact_email ?? null;
        customerName = rows[0]?.name ?? null;

        // Fallback 1: auth.credentials (email type, newest first)
        if (!customerEmail) {
          const credRows = await authSql<{ value: string }[]>`
            SELECT value FROM auth.credentials
            WHERE did = ${buyerDid} AND type = 'email'
            ORDER BY created_at DESC LIMIT 1
          `;
          customerEmail = credRows[0]?.value ?? null;
        }
      }

      // Fallback 2: orders.buyer_email (persists the email from checkout time)
      if (!customerEmail && orderId) {
        const orderRows = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
        customerEmail = orderRows[0]?.buyerEmail ?? null;
      }

      if (customerEmail) {
        const typeIds = Array.from(new Set(confirmedTickets.map((t) => t.ticketTypeId)));
        const typeRows = await db
          .select()
          .from(ticketTypes)
          .where(inArray(ticketTypes.id, typeIds));
        const typesById = new Map(typeRows.map((t) => [t.id, t]));

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

        // Magic-link onboard token
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

        // Split tickets by their actual registration state, not by ticket-type
        // policy. A reg-required ticket that's already 'complete' is just as
        // redeemable as a 'not_required' ticket and belongs in the bundle email.
        //
        // Previous logic gated on tt.requiresRegistration, which excluded
        // already-registered tickets from the "you're in" QR email entirely.
        const bundleTickets = confirmedTickets.filter(
          (t) => t.registrationStatus !== 'pending',
        );
        const registrationPendingTickets = confirmedTickets.filter(
          (t) => t.registrationStatus === 'pending',
        );

        // CTA targets: the first pending-and-required ticket, falling back to my-tickets
        const ctaTicket = registrationPendingTickets[0] ?? null;
        const anyPendingRegistration = registrationPendingTickets.length > 0;
        const registrationUrl = ctaTicket
          ? `${EVENTS_URL}/${event.id}/register/${ctaTicket.id}`
          : `${EVENTS_URL}/${event.id}/my-tickets`;

        // 1. Purchase receipt (always)
        publish('ticket.receipt', {
          issuer: buyerDid || '',
          subject: buyerDid || '',
          scope: 'events',
          payload: {
            email: customerEmail,
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
            hasRegistrationRequired: anyPendingRegistration,
            context_id: event.id,
            context_type: 'event',
          },
        }).catch((err) => log.error({ err: String(err) }, 'Receipt publish error'));

        // 2. Ticket confirmation with QR codes for no-registration tickets
        if (bundleTickets.length > 0) {
          const ticketsWithQr = await Promise.all(
            bundleTickets.map(async (t) => ({
              id: t.id,
              qrCodeDataUri: await generateQRCode(t.id),
            }))
          );
          const primaryType = typesById.get(bundleTickets[0].ticketTypeId);
          // Recompute formatted price for the bundle subset (sum of bundleTickets pricePaid)
          const bundleCents = bundleTickets.reduce((sum, t) => sum + (t.pricePaid ?? 0), 0);
          const bundleFormatted = fmt(bundleCents);
          publish('ticket.confirmed', {
            issuer: bundleTickets[0].ownerDid || '',
            subject: bundleTickets[0].ownerDid || customerEmail,
            scope: 'events',
            payload: {
              to: customerEmail,
              email: customerEmail,
              eventTitle: event.title,
              ticketType: primaryType?.name ?? 'Ticket',
              ticketId: bundleTickets[0].id,
              eventDate: formattedEventDate,
              eventTime: formattedEventTime,
              isVirtual: event.isVirtual ?? false,
              venue: event.venue ?? undefined,
              price: bundleFormatted,
              magicLink,
              eventImageUrl,
              eventUrl: `${EVENTS_URL}/${event.id}`,
              tickets: ticketsWithQr,
              context_id: event.id,
              context_type: 'event',
            },
          }).catch((err) => log.error({ err: String(err) }, 'Failed to publish ticket confirmed event'));
        }
      } else {
        log.warn({ buyerDid, orderId }, 'No buyer email available on EMT confirm; skipping receipt + ticket emails');
      }
    } catch (emailErr) {
      log.error({ err: String(emailErr) }, 'EMT confirm email block failed');
    }
  }

  return { confirmedTickets, orderId };
}
