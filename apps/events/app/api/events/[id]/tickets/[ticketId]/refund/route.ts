import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { db, events, ticketTypes } from '@/src/db';
import { isEventOrganizer } from '@/src/lib/organizer';

const log = createLogger('events');
import { requireAuth, resolveEmailForDid , resolveActingDid } from '@imajin/auth';
import { eq, sql } from 'drizzle-orm';
import { getClient } from '@imajin/db';
import { publish } from '@imajin/bus';
import { eventUrl, buildPublicUrlAbsolute } from '@imajin/config';

const sqlClient = getClient();

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL!;
const PAY_SERVICE_API_KEY = process.env.PAY_SERVICE_API_KEY!;

interface RefundableTicket {
  id: string;
  status: string;
  price_paid: number | null;
  payment_id: string | null;
  payment_method: string | null;
  ticket_type_id: string | null;
  owner_did: string | null;
  currency: string | null;
}

/** Load the ticket to refund, scoped to `eventId`, or null when not found. */
async function loadTicketForRefund(eventId: string, ticketId: string): Promise<RefundableTicket | null> {
  const [ticket] = await sqlClient`
    SELECT id, status, price_paid, payment_id, payment_method, ticket_type_id, owner_did, currency
    FROM events.tickets
    WHERE id = ${ticketId} AND event_id = ${eventId}
    LIMIT 1
  `;
  return (ticket as RefundableTicket) ?? null;
}

/**
 * Issue the actual refund with the pay service for Stripe-paid tickets.
 * Returns an error response to short-circuit with, or null on success/no-op.
 */
async function processPaymentRefund(ticket: RefundableTicket, pricePaid: number): Promise<NextResponse | null> {
  const isStripe = ticket.payment_method === 'stripe';
  if (!isStripe || !ticket.payment_id || pricePaid <= 0) return null;

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
  return null;
}

/** Decrement the ticket type's sold counter — best-effort, failure is non-fatal. */
async function decrementSoldCounter(ticketTypeId: string | null): Promise<void> {
  if (!ticketTypeId) return;
  await db
    .update(ticketTypes)
    .set({ sold: sql`GREATEST(${ticketTypes.sold} - 1, 0)` })
    .where(eq(ticketTypes.id, ticketTypeId))
    .catch((err) => {
      log.error({ err: String(err) }, '[refund] Failed to decrement ticket_types.sold (non-fatal)');
    });
}

/** Flip the ticket status to refunded/refund_pending and return the updated row. */
async function markTicketRefunded(ticketId: string, manualRefundRequired: boolean) {
  const newStatus = manualRefundRequired ? 'refund_pending' : 'refunded';
  const [updated] = await sqlClient`
    UPDATE events.tickets
    SET status = ${newStatus}
    WHERE id = ${ticketId}
    RETURNING id, status
  `;
  return updated;
}

/** Resolve the customer's notification email: survey response takes precedence over the owner DID lookup. */
async function resolveRefundCustomerEmail(ticketId: string, ownerDid: string | null): Promise<string | null> {
  const [surveyResponse] = await sqlClient`
    SELECT answers FROM dykil.survey_responses WHERE ticket_id = ${ticketId} LIMIT 1
  `;

  if (surveyResponse?.answers?.email) {
    return surveyResponse.answers.email;
  }
  if (ownerDid) {
    // #1998: resolveEmailForDid now calls the profile service's batched
    // /api/resolve route (auth.credentials -> profile.profiles ->
    // auth.identities precedence), replacing the raw profile.profiles
    // query this file used to run for itself.
    return resolveEmailForDid(ownerDid);
  }
  return null;
}

function buildRefundMessage(eventTitle: string, isStripe: boolean, pricePaid: number, manualRefundRequired: boolean, priceDollars: string, currency: string): string {
  if (isStripe && pricePaid > 0) {
    return `Your ticket for **${eventTitle}** has been refunded.\n\n` +
      `**Amount:** $${priceDollars} ${currency}\n\n` +
      `The refund has been processed and should appear on your card within 5–10 business days.`;
  }
  if (manualRefundRequired) {
    return `Your refund for **${eventTitle}** is pending.\n\n` +
      `**Amount:** $${priceDollars} ${currency}\n\n` +
      `The organizer will send your refund via e-transfer. Please allow a few business days for processing.`;
  }
  return `Your ticket for **${eventTitle}** has been cancelled and refunded.`;
}

/** Publish the refund notification event for the customer (fire-and-forget, non-fatal). */
function publishRefundNotification(params: {
  did: string;
  event: { id: string; title: string; imageUrl: string | null };
  ticket: RefundableTicket;
  customerEmail: string;
  isStripe: boolean;
  pricePaid: number;
  manualRefundRequired: boolean;
  priceDollars: string;
  currency: string;
}): void {
  const { did, event, ticket, customerEmail, isStripe, pricePaid, manualRefundRequired, priceDollars, currency } = params;
  const refundMessage = buildRefundMessage(event.title, isStripe, pricePaid, manualRefundRequired, priceDollars, currency);

  const EVENTS_URL = buildPublicUrlAbsolute('events');
  let imageUrl: string | null = null;
  if (event.imageUrl) {
    imageUrl = event.imageUrl.startsWith('http') ? event.imageUrl : `${EVENTS_URL}${event.imageUrl}`;
  }

  publish('ticket.refunded', {
    issuer: did,
    subject: ticket.owner_did || '',
    scope: 'events',
    payload: {
      email: customerEmail,
      refundMessage,
      eventTitle: event.title,
      eventImageUrl: imageUrl,
      eventUrl: eventUrl(EVENTS_URL, event.id),
      manualRefundRequired,
      context_id: event.id,
      context_type: 'event',
    },
  }).catch((err) => log.error({ err: String(err) }, '[refund] Failed to publish ticket refunded event'));
}

/** Resolve the customer email and, if found, publish the refund notification. Non-fatal on any failure. */
async function notifyRefundCustomer(params: {
  did: string;
  event: { id: string; title: string; imageUrl: string | null };
  ticket: RefundableTicket;
  isStripe: boolean;
  pricePaid: number;
  manualRefundRequired: boolean;
  priceDollars: string;
  currency: string;
}): Promise<string | null> {
  try {
    const customerEmail = await resolveRefundCustomerEmail(params.ticket.id, params.ticket.owner_did);
    if (customerEmail) {
      publishRefundNotification({ ...params, customerEmail });
    }
    return customerEmail;
  } catch (emailErr) {
    log.error({ err: String(emailErr) }, '[refund] Failed to publish refund event (non-fatal)');
    return null;
  }
}

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
  const did = resolveActingDid(identity);
  const { id, ticketId } = await params;

  try {
    const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Refund is organizer-only (creator or cohost)
    const orgCheck = await isEventOrganizer(id, did);
    if (!orgCheck.authorized) {
      return NextResponse.json({ error: 'Only event organizers can issue refunds' }, { status: 403 });
    }

    const ticket = await loadTicketForRefund(id, ticketId);
    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    if (ticket.status !== 'valid') {
      return NextResponse.json({ error: 'Only valid tickets can be refunded' }, { status: 400 });
    }

    const isStripe = ticket.payment_method === 'stripe';
    const pricePaid = ticket.price_paid ?? 0;
    const manualRefundRequired = ticket.payment_method === 'etransfer';

    const paymentError = await processPaymentRefund(ticket, pricePaid);
    if (paymentError) return paymentError;
    // Free tickets (pricePaid === 0 or no payment_method): skip pay service

    // Decrement sold counter — fail independently, don't block status update
    await decrementSoldCounter(ticket.ticket_type_id);

    // E-transfer: set refund_pending (organizer must send manually then mark sent)
    // All other cases: flip directly to refunded
    const updated = await markTicketRefunded(ticketId, manualRefundRequired);

    const priceDollars = (pricePaid / 100).toFixed(2);
    const currency = ticket.currency || 'CAD';

    const customerEmail = await notifyRefundCustomer({
      did,
      event,
      ticket,
      isStripe,
      pricePaid,
      manualRefundRequired,
      priceDollars,
      currency,
    });

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
