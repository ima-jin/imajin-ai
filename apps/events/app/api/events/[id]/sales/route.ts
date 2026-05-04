/**
 * GET /api/events/[id]/sales
 *
 * Returns all sales (orders) for an event, joined with buyer identity info
 * and ticket details. Supports JSON, CSV, and XLSX export formats.
 *
 * Query params:
 *   ?format=csv  — return CSV download
 *   ?format=xlsx — return CSV download (xlsx library not available, Excel opens CSV)
 *
 * Auth: event creator, cohost, or admin.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { requireAuth } from '@imajin/auth';
import { isEventOrganizer } from '@/src/lib/organizer';
import { getClient } from '@imajin/db';

const log = createLogger('events');
const sql = getClient();

/* ─── CSV helpers (same pattern as guest list export) ─── */

function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(values: unknown[]): string {
  return values.map(csvEscape).join(',') + '\r\n';
}

function computeOrderStatus(tickets: { status: string }[]): string {
  if (tickets.length === 0) return 'unknown';
  const statuses = tickets.map((t) => t.status);
  if (statuses.every((s) => s === 'valid' || s === 'used')) return 'completed';
  if (statuses.every((s) => s === 'refunded')) return 'refunded';
  if (statuses.every((s) => s === 'cancelled')) return 'cancelled';
  if (statuses.some((s) => s === 'held')) return 'pending';
  if (statuses.some((s) => s === 'valid' || s === 'used')) return 'partial';
  return 'unknown';
}

/* ─── Route handlers ─── */

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { identity } = authResult;
  const did = identity.actingAs || identity.id;
  const { id: eventId } = await params;

  try {
    const orgCheck = await isEventOrganizer(eventId, did);
    if (!orgCheck.authorized) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Fetch event for filename / currency fallback
    const [eventRow] = await sql`
      SELECT id, title, currency FROM events.events WHERE id = ${eventId} LIMIT 1
    `;
    if (!eventRow) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    /*
     * Fetch all orders for this event, joined with:
     *   - auth.identities (buyer name / handle)
     *   - pay.transactions (stripe session id when available)
     *   - events.tickets + ticket_types + ticket_registrations
     */
    const orderRows = await sql`
      SELECT
        o.id AS order_id,
        o.buyer_did,
        o.amount_total,
        o.currency,
        o.status AS order_status,
        o.payment_method,
        o.stripe_session_id,
        o.purchased_at,
        o.created_at,
        i.name AS buyer_name,
        i.handle AS buyer_handle,
        t.id AS ticket_id,
        t.status AS ticket_status,
        tt.name AS ticket_type_name,
        tr.name AS attendee_name,
        tr.email AS attendee_email,
        tx.id AS transaction_id,
        tx.amount AS tx_amount,
        tx.status AS tx_status,
        tx.stripe_id AS tx_stripe_id,
        tx.metadata AS tx_metadata
      FROM events.orders o
      LEFT JOIN auth.identities i ON i.id = o.buyer_did
      LEFT JOIN pay.transactions tx ON tx.stripe_id = o.stripe_session_id
      LEFT JOIN events.tickets t ON t.order_id = o.id
      LEFT JOIN events.ticket_types tt ON tt.id = t.ticket_type_id
      LEFT JOIN events.ticket_registrations tr ON tr.ticket_id = t.id
      WHERE o.event_id = ${eventId}
      ORDER BY o.created_at DESC, t.created_at ASC
    `;

    // Group rows by order
    type SaleTicket = {
      id: string;
      type: string;
      attendeeName: string | null;
      status: string;
    };

    type Sale = {
      transactionId: string | null;
      orderId: string;
      buyer: {
        did: string | null;
        name: string | null;
        handle: string | null;
      };
      tickets: SaleTicket[];
      amount: number;
      currency: string;
      status: string;
      paymentMethod: string | null;
      stripeSessionId: string | null;
      createdAt: string;
    };

    const saleMap = new Map<string, Sale>();

    for (const row of orderRows) {
      const orderId = row.order_id;
      if (!saleMap.has(orderId)) {
        saleMap.set(orderId, {
          transactionId: row.transaction_id ?? null,
          orderId,
          buyer: {
            did: row.buyer_did ?? null,
            name: row.buyer_name ?? null,
            handle: row.buyer_handle ?? null,
          },
          tickets: [],
          amount: row.amount_total ? row.amount_total / 100 : 0,
          currency: row.currency ?? eventRow.currency ?? 'USD',
          status: row.order_status ?? 'completed',
          paymentMethod: row.payment_method ?? null,
          stripeSessionId: row.stripe_session_id ?? row.tx_stripe_id ?? null,
          createdAt: row.purchased_at
            ? new Date(row.purchased_at).toISOString()
            : new Date(row.created_at).toISOString(),
        });
      }

      const sale = saleMap.get(orderId)!;
      if (row.ticket_id && !sale.tickets.find((t) => t.id === row.ticket_id)) {
        sale.tickets.push({
          id: row.ticket_id,
          type: row.ticket_type_name ?? 'Unknown',
          attendeeName: row.attendee_name ?? null,
          status: row.ticket_status ?? 'unknown',
        });
      }
    }

    // Compute meaningful status from tickets (orders table status defaults to 'pending')
    const sales = Array.from(saleMap.values()).map((sale) => ({
      ...sale,
      status: computeOrderStatus(sale.tickets),
    }));

    // Fetch orphan tickets (no order_id) — these predate the orders system
    const orphanRows = await sql`
      SELECT
        t.id AS ticket_id,
        t.status,
        t.owner_did,
        t.price_paid,
        t.currency,
        t.purchased_at,
        t.payment_method,
        t.payment_id,
        tt.name AS ticket_type_name,
        tr.name AS attendee_name,
        tr.email AS attendee_email
      FROM events.tickets t
      LEFT JOIN events.ticket_types tt ON tt.id = t.ticket_type_id
      LEFT JOIN events.ticket_registrations tr ON tr.ticket_id = t.id
      WHERE t.event_id = ${eventId}
        AND t.order_id IS NULL
      ORDER BY t.purchased_at DESC NULLS LAST, t.created_at DESC
    `;

    const orphans = orphanRows.map((r: any) => ({
      ticketId: r.ticket_id,
      status: r.status ?? 'unknown',
      ownerDid: r.owner_did ?? null,
      pricePaid: r.price_paid ?? null,
      currency: r.currency ?? eventRow.currency ?? 'CAD',
      purchasedAt: r.purchased_at ? new Date(r.purchased_at).toISOString() : null,
      ticketType: r.ticket_type_name ?? 'Unknown',
      paymentMethod: r.payment_method ?? null,
      paymentId: r.payment_id ?? null,
      attendeeName: r.attendee_name ?? null,
      attendeeEmail: r.attendee_email ?? null,
    }));

    // Summary — include orphan revenue
    const orphanRevenue = orphans.reduce((sum: number, o: any) => sum + (o.pricePaid ?? 0), 0) / 100;
    const totalRevenue = sales.reduce((sum, s) => sum + s.amount, 0) + orphanRevenue;
    const summary = {
      totalSales: sales.length,
      totalRevenue: parseFloat(totalRevenue.toFixed(2)),
      currency: sales[0]?.currency ?? eventRow.currency ?? 'USD',
    };

    // Export format?
    const url = new URL(request.url);
    const format = url.searchParams.get('format');

    if (format === 'csv' || format === 'xlsx') {
      const dateStr = new Date().toISOString().split('T')[0];
      const safeTitle = eventRow.title
        ? eventRow.title.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
        : eventId;
      const ext = format === 'xlsx' ? 'xlsx' : 'csv';
      const filename = `${safeTitle || eventId}-sales-${dateStr}.${ext}`;
      const mimeType =
        format === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv; charset=utf-8';

      const headers = [
        'Order ID',
        'Transaction ID',
        'Buyer Name',
        'Buyer Handle',
        'Buyer DID',
        'Ticket Type',
        'Quantity',
        'Amount',
        'Currency',
        'Status',
        'Payment Method',
        'Date',
        'Stripe Session ID',
      ];

      let csvBody = csvRow(headers);
      for (const sale of sales) {
        const ticketTypesGrouped = sale.tickets.reduce<Record<string, number>>((acc, t) => {
          acc[t.type] = (acc[t.type] || 0) + 1;
          return acc;
        }, {});
        const ticketTypeStr = Object.entries(ticketTypesGrouped)
          .map(([type, qty]) => `${type} (${qty})`)
          .join('; ');

        csvBody += csvRow([
          sale.orderId,
          sale.transactionId ?? '',
          sale.buyer.name ?? '',
          sale.buyer.handle ?? '',
          sale.buyer.did ?? '',
          ticketTypeStr,
          sale.tickets.length,
          sale.amount.toFixed(2),
          sale.currency,
          sale.status,
          sale.paymentMethod ?? '',
          sale.createdAt,
          sale.stripeSessionId ?? '',
        ]);
      }

      const bom = '\uFEFF';
      return new NextResponse(bom + csvBody, {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    // JSON response — shape must match SalesTab component interface
    // Merge order-based sales and orphan tickets into one unified list
    const orderSales = sales.map((s) => {
      const ticketTypeCounts = s.tickets.reduce<Record<string, number>>((acc, t) => {
        acc[t.type] = (acc[t.type] || 0) + 1;
        return acc;
      }, {});
      const ticketTypeStr = Object.entries(ticketTypeCounts)
        .map(([type, qty]) => qty > 1 ? `${type} (${qty})` : type)
        .join(', ') || 'Unknown';

      return {
        orderId: s.orderId,
        buyerDid: s.buyer.did,
        buyerName: s.buyer.name,
        buyerHandle: s.buyer.handle,
        buyerAvatar: null,
        ticketType: ticketTypeStr,
        quantity: s.tickets.length,
        amountTotal: Math.round(s.amount * 100),
        currency: s.currency,
        paymentMethod: s.paymentMethod,
        stripeSessionId: s.stripeSessionId,
        paymentId: s.transactionId,
        purchasedAt: s.createdAt,
        tickets: s.tickets.map((t) => ({ ticketId: t.id, status: t.status })),
        status: s.status,
      };
    });

    // Convert orphan tickets into the same Sale shape
    const orphanSales = orphans.map((o: any) => ({
      orderId: o.ticketId,
      buyerDid: o.ownerDid,
      buyerName: o.attendeeName,
      buyerHandle: null,
      buyerAvatar: null,
      ticketType: o.ticketType,
      quantity: 1,
      amountTotal: o.pricePaid ?? 0,
      currency: o.currency,
      paymentMethod: o.paymentMethod,
      stripeSessionId: o.paymentId?.startsWith('cs_') ? o.paymentId : null,
      paymentId: o.paymentId,
      purchasedAt: o.purchasedAt,
      tickets: [{ ticketId: o.ticketId, status: o.status }],
      status: o.status === 'valid' || o.status === 'used' ? 'completed' : o.status,
    }));

    const allSales = [...orderSales, ...orphanSales]
      .sort((a, b) => {
        const da = a.purchasedAt ? new Date(a.purchasedAt).getTime() : 0;
        const db = b.purchasedAt ? new Date(b.purchasedAt).getTime() : 0;
        return db - da;
      });

    const totalCount = allSales.length;
    const avgOrderValue = totalCount > 0 ? Math.round(totalRevenue * 100 / totalCount) : 0;

    return NextResponse.json({
      sales: allSales,
      orphans: [],
      orphanOrders: [],
      summary: {
        totalSales: totalCount,
        totalRevenue: Math.round(totalRevenue * 100),
        avgOrderValue,
        totalOrders: totalCount,
      },
    });
  } catch (error) {
    log.error({ err: String(error), eventId }, 'Failed to fetch sales');
    return NextResponse.json({ error: 'Failed to fetch sales' }, { status: 500 });
  }
}
