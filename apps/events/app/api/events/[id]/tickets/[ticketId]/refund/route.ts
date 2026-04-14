import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { db, events, ticketTypes, ticketRegistrations } from '@/src/db';

const log = createLogger('events');
import { requireAuth, getEmailForDid } from '@imajin/auth';
import { eq, sql } from 'drizzle-orm';
import { getClient } from '@imajin/db';
import { sendEmail, renderBroadcastEmail } from '@imajin/email';

const sqlClient = getClient();

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL!;
const PAY_SERVICE_API_KEY = process.env.PAY_SERVICE_API_KEY!;

/**
 * POST /api/events/[id]/tickets/[ticketId]/refund — refund a ticket (owner only)
 *
 * - Stripe tickets: calls pay service to issue actual refund before flipping status
 * - E-transfer tickets: flips status only, returns manualRefundRequired: true
 * - Free tickets (price_paid === 0): skips pay service call
 * - Decrements ticket_types.sold counter (failure is non-fatal)
 */
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
  const { id, ticketId } = await params;

  try {
    const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Refund is owner-only (not cohosts)
    if (event.creatorDid !== did) {
      return NextResponse.json({ error: 'Only the event owner can issue refunds' }, { status: 403 });
    }

    const [ticket] = await sqlClient`
      SELECT id, status, price_paid, payment_id, payment_method, ticket_type_id, owner_did, currency
      FROM events.tickets
      WHERE id = ${ticketId} AND event_id = ${id}
      LIMIT 1
    `;

    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    if (ticket.status !== 'valid') {
      return NextResponse.json({ error: 'Only valid tickets can be refunded' }, { status: 400 });
    }

    let manualRefundRequired = false;

    const isStripe = ticket.payment_method === 'stripe';
    const hasPaymentId = !!ticket.payment_id;
    const pricePaid = ticket.price_paid ?? 0;

    if (isStripe && hasPaymentId && pricePaid > 0) {
      // Call pay service to issue actual Stripe refund
      const payResponse = await fetch(`${PAY_SERVICE_URL}/api/refund`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${PAY_SERVICE_API_KEY}`,
        },
        body: JSON.stringify({
          paymentId: ticket.payment_id,
          amount: pricePaid,
        }),
      });

      if (!payResponse.ok) {
        const text = await payResponse.text();
        log.error({ status: payResponse.status, text }, '[refund] pay /api/refund returned error');
        return NextResponse.json(
          { error: 'Payment refund failed — ticket status not changed' },
          { status: 502 }
        );
      }
    } else if (ticket.payment_method === 'etransfer') {
      // E-transfer: flip status only, flag for manual processing
      manualRefundRequired = true;
    }
    // Free tickets (pricePaid === 0 or no payment_method): skip pay service

    // Decrement sold counter — fail independently, don't block status update
    if (ticket.ticket_type_id) {
      await db
        .update(ticketTypes)
        .set({ sold: sql`GREATEST(${ticketTypes.sold} - 1, 0)` })
        .where(eq(ticketTypes.id, ticket.ticket_type_id))
        .catch((err) => {
          log.error({ err: String(err) }, '[refund] Failed to decrement ticket_types.sold (non-fatal)');
        });
    }

    // E-transfer: set refund_pending (organizer must send manually then mark sent)
    // All other cases: flip directly to refunded
    const newStatus = manualRefundRequired ? 'refund_pending' : 'refunded';
    const [updated] = await sqlClient`
      UPDATE events.tickets
      SET status = ${newStatus}
      WHERE id = ${ticketId}
      RETURNING id, status
    `;

    // Resolve attendee email for notification + response
    let customerEmail: string | null = null;
    const priceDollars = (pricePaid / 100).toFixed(2);
    const currency = ticket.currency || 'CAD';

    // Send refund notification email (fire-and-forget, non-fatal)
    try {
      const [registration] = await db
        .select()
        .from(ticketRegistrations)
        .where(eq(ticketRegistrations.ticketId, ticketId))
        .limit(1);

      if (registration?.email) {
        customerEmail = registration.email;
      } else if (ticket.owner_did) {
        const profileRows = await sqlClient`
          SELECT contact_email FROM profile.profiles WHERE did = ${ticket.owner_did} LIMIT 1
        `;
        if (profileRows.length > 0 && profileRows[0].contact_email) {
          customerEmail = profileRows[0].contact_email;
        } else {
          customerEmail = await getEmailForDid(ticket.owner_did);
        }
      }

      if (customerEmail) {
        let refundMessage: string;
        if (isStripe && pricePaid > 0) {
          refundMessage = `Your ticket for **${event.title}** has been refunded.\n\n` +
            `**Amount:** $${priceDollars} ${currency}\n\n` +
            `The refund has been processed and should appear on your card within 5–10 business days.`;
        } else if (manualRefundRequired) {
          refundMessage = `Your refund for **${event.title}** is pending.\n\n` +
            `**Amount:** $${priceDollars} ${currency}\n\n` +
            `The organizer will send your refund via e-transfer. Please allow a few business days for processing.`;
        } else {
          refundMessage = `Your ticket for **${event.title}** has been cancelled and refunded.`;
        }

        const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai';
        const imageUrl = event.imageUrl
          ? (event.imageUrl.startsWith('http') ? event.imageUrl : `${EVENTS_URL}${event.imageUrl}`)
          : null;
        const { html, text } = renderBroadcastEmail(refundMessage, {
          title: event.title,
          imageUrl,
          eventUrl: `${EVENTS_URL}/${event.id}`,
        });

        await sendEmail({
          to: customerEmail,
          subject: manualRefundRequired ? `Refund pending: ${event.title}` : `Refund: ${event.title}`,
          html,
          text,
        });
      }
    } catch (emailErr) {
      log.error({ err: String(emailErr) }, '[refund] Failed to send refund email (non-fatal)');
    }

    return NextResponse.json({
      ticket: { id: updated.id, status: updated.status },
      ...(manualRefundRequired && {
        manualRefundRequired: true,
        ...(customerEmail && { refundEmail: customerEmail }),
        refundAmount: priceDollars,
        refundCurrency: currency,
      }),
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to refund ticket');
    return NextResponse.json({ error: 'Failed to refund ticket' }, { status: 500 });
  }
}
