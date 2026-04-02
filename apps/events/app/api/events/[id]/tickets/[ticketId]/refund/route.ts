import { NextRequest, NextResponse } from 'next/server';
import { db, events, ticketTypes } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { eq, sql } from 'drizzle-orm';
import { getClient } from '@imajin/db';

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
  const { id, ticketId } = await params;

  try {
    const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Refund is owner-only (not cohosts)
    if (event.creatorDid !== identity.id) {
      return NextResponse.json({ error: 'Only the event owner can issue refunds' }, { status: 403 });
    }

    const [ticket] = await sqlClient`
      SELECT id, status, price_paid, payment_id, payment_method, ticket_type_id
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
        console.error(`[refund] pay /api/refund returned ${payResponse.status}: ${text}`);
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
          console.error('[refund] Failed to decrement ticket_types.sold (non-fatal):', err);
        });
    }

    // Flip ticket status to refunded
    const [updated] = await sqlClient`
      UPDATE events.tickets
      SET status = 'refunded'
      WHERE id = ${ticketId}
      RETURNING id, status
    `;

    return NextResponse.json({
      ticket: { id: updated.id, status: updated.status },
      ...(manualRefundRequired && { manualRefundRequired: true }),
    });
  } catch (error) {
    console.error('Failed to refund ticket:', error);
    return NextResponse.json({ error: 'Failed to refund ticket' }, { status: 500 });
  }
}
