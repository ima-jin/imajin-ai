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
import { requireAuth , resolveActingDid, resolveIdentitiesForDids } from '@imajin/auth';
import { isEventOrganizer } from '@/src/lib/organizer';
import { getClient } from '@imajin/db';

const log = createLogger('events');
const sql = getClient();

/* ─── CSV helpers (same pattern as guest list export) ─── */

function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
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
  if (statuses.includes('held')) return 'pending';
  if (statuses.includes('valid') || statuses.includes('used')) return 'partial';
  return 'unknown';
}

interface ResolvedBuyer {
  displayName: string | null;
  handle: string | null;
  email?: string;
}

/** Look up a resolved identity for `did` in `resolvedMap`, or undefined when there is no DID to look up. */
function lookupResolved(did: string | null | undefined, resolvedMap: Map<string, ResolvedBuyer>): ResolvedBuyer | undefined {
  return did ? resolvedMap.get(did) : undefined;
}

/** Build the JSON-shaped orphan-ticket sale row (#1998: owner identity now comes from the batched resolve map). */
function buildOrphanSale(r: any, resolvedMap: Map<string, ResolvedBuyer>, fallbackCurrency: string) {
  const ownerResolved = lookupResolved(r.owner_did, resolvedMap);
  return {
    ticketId: r.ticket_id,
    status: r.status ?? 'unknown',
    ownerDid: r.owner_did ?? null,
    ownerName: ownerResolved?.displayName ?? r.attendee_name ?? null,
    ownerHandle: ownerResolved?.handle ?? null,
    ownerEmail: ownerResolved?.email ?? null,
    pricePaid: r.price_paid ?? null,
    currency: r.currency ?? fallbackCurrency,
    purchasedAt: r.purchased_at ? new Date(r.purchased_at).toISOString() : null,
    ticketType: r.ticket_type_name ?? 'Unknown',
    paymentMethod: r.payment_method ?? null,
    paymentId: r.payment_id ?? null,
    attendeeName: r.attendee_name ?? null,
    attendeeEmail: r.attendee_email ?? null,
  };
}

/* ─── Fetch helpers ─── */

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
    email: string | null;
  };
  tickets: SaleTicket[];
  amount: number;
  currency: string;
  status: string;
  paymentMethod: string | null;
  stripeSessionId: string | null;
  createdAt: string;
};

/**
 * Fetch all orders for `eventId`, joined with tickets/ticket types/survey
 * responses, and group them into one `Sale` per order (with computed status).
 */
async function fetchOrderSales(eventId: string, fallbackCurrency: string | null): Promise<Sale[]> {
  /*
   * Fetch all orders for this event, joined with:
   *   - auth.identities (buyer name / handle)
   *   - pay.transactions (stripe session id when available)
   *   - events.tickets + ticket_types + dykil.survey_responses
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
      t.id AS ticket_id,
      t.status AS ticket_status,
      tt.name AS ticket_type_name,
      COALESCE(sr.answers->>'full_name', sr.answers->>'name') AS attendee_name,
      sr.answers->>'email' AS attendee_email,
      tx.id AS transaction_id,
      tx.amount AS tx_amount,
      tx.status AS tx_status,
      tx.stripe_id AS tx_stripe_id,
      tx.metadata AS tx_metadata
    FROM events.orders o
    LEFT JOIN pay.transactions tx ON tx.stripe_id = o.stripe_session_id
    LEFT JOIN events.tickets t ON t.order_id = o.id
    LEFT JOIN events.ticket_types tt ON tt.id = t.ticket_type_id
    LEFT JOIN dykil.survey_responses sr ON sr.ticket_id = t.id
    WHERE o.event_id = ${eventId}
    ORDER BY o.created_at DESC, t.created_at ASC
  `;

  // Batch-resolve buyer DIDs via the profile service's batched /api/resolve
  // route (#1998) — replaces the raw auth.identities / auth.credentials
  // joins this query used to run for itself.
  const buyerDids = [...new Set(orderRows.map((r: any) => r.buyer_did).filter(Boolean))] as string[];
  const buyerResolvedMap = await resolveIdentitiesForDids(buyerDids);

  function buildSaleFromOrderRow(row: typeof orderRows[number]): Sale {
    const buyerResolved = lookupResolved(row.buyer_did, buyerResolvedMap);
    return {
      transactionId: row.transaction_id ?? null,
      orderId: row.order_id,
      buyer: {
        did: row.buyer_did ?? null,
        name: buyerResolved?.displayName ?? null,
        handle: buyerResolved?.handle ?? null,
        email: buyerResolved?.email ?? null,
      },
      tickets: [],
      amount: row.amount_total ? row.amount_total / 100 : 0,
      currency: row.currency ?? fallbackCurrency ?? 'USD',
      status: row.order_status ?? 'completed',
      paymentMethod: row.payment_method ?? null,
      stripeSessionId: row.stripe_session_id ?? row.tx_stripe_id ?? null,
      createdAt: row.purchased_at
        ? new Date(row.purchased_at).toISOString()
        : new Date(row.created_at).toISOString(),
    };
  }

  const saleMap = new Map<string, Sale>();

  for (const row of orderRows) {
    const orderId = row.order_id;
    if (!saleMap.has(orderId)) {
      saleMap.set(orderId, buildSaleFromOrderRow(row));
    }

    const sale = saleMap.get(orderId)!;
    if (row.ticket_id && !sale.tickets.some((t) => t.id === row.ticket_id)) {
      sale.tickets.push({
        id: row.ticket_id,
        type: row.ticket_type_name ?? 'Unknown',
        attendeeName: row.attendee_name ?? null,
        status: row.ticket_status ?? 'unknown',
      });
    }
  }

  // Compute meaningful status from tickets (orders table status defaults to 'pending')
  return Array.from(saleMap.values()).map((sale) => ({
    ...sale,
    status: computeOrderStatus(sale.tickets),
  }));
}

/** Fetch orphan tickets (no order_id) — these predate the orders system — with resolved owner identities. */
async function fetchOrphanSales(eventId: string, fallbackCurrency: string) {
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
      COALESCE(sr.answers->>'full_name', sr.answers->>'name') AS attendee_name,
      sr.answers->>'email' AS attendee_email
    FROM events.tickets t
    LEFT JOIN events.ticket_types tt ON tt.id = t.ticket_type_id
    LEFT JOIN dykil.survey_responses sr ON sr.ticket_id = t.id
    WHERE t.event_id = ${eventId}
      AND t.order_id IS NULL
    ORDER BY t.purchased_at DESC NULLS LAST, t.created_at DESC
  `;

  // Batch-resolve orphan ticket owner DIDs the same way as order buyers.
  const orphanOwnerDids = [...new Set(orphanRows.map((r: any) => r.owner_did).filter(Boolean))] as string[];
  const orphanOwnerResolvedMap = await resolveIdentitiesForDids(orphanOwnerDids);

  return orphanRows.map((r: any) => buildOrphanSale(r, orphanOwnerResolvedMap, fallbackCurrency));
}

/* ─── Response builders ─── */

/** Group a sale's tickets by type into a display string, e.g. "VIP (2); GA (1)". */
function groupTicketTypesForCsv(tickets: SaleTicket[]): string {
  const grouped = tickets.reduce<Record<string, number>>((acc, t) => {
    acc[t.type] = (acc[t.type] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(grouped)
    .map(([type, qty]) => `${type} (${qty})`)
    .join('; ');
}

function buildCsvResponse(sales: Sale[], eventId: string, eventTitle: string | null, format: string): NextResponse {
  const dateStr = new Date().toISOString().split('T')[0];
  const safeTitle = eventTitle
    ? eventTitle.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
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
    'Buyer Email',
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
    csvBody += csvRow([
      sale.orderId,
      sale.transactionId ?? '',
      sale.buyer.name ?? '',
      sale.buyer.handle ?? '',
      sale.buyer.email ?? '',
      sale.buyer.did ?? '',
      groupTicketTypesForCsv(sale.tickets),
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

/** Convert an order-based Sale into the unified sale shape expected by the SalesTab component. */
function toOrderSaleView(s: Sale) {
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
    buyerEmail: s.buyer.email,
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
}

type OrphanSale = ReturnType<typeof buildOrphanSale>;

/** Convert an orphan ticket sale into the same unified sale shape as `toOrderSaleView`. */
function toOrphanSaleView(o: OrphanSale) {
  return {
    orderId: o.ticketId,
    buyerDid: o.ownerDid,
    buyerName: o.ownerName ?? o.attendeeName,
    buyerHandle: o.ownerHandle,
    buyerEmail: o.ownerEmail,
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
  };
}

function buildJsonResponse(sales: Sale[], orphans: OrphanSale[], totalRevenue: number): NextResponse {
  // JSON response — shape must match SalesTab component interface
  // Merge order-based sales and orphan tickets into one unified list
  const orderSales = sales.map(toOrderSaleView);
  const orphanSales = orphans.map(toOrphanSaleView);

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
  const did = resolveActingDid(identity);
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

    const sales = await fetchOrderSales(eventId, eventRow.currency);
    const orphans = await fetchOrphanSales(eventId, eventRow.currency ?? 'CAD');

    // Summary — include orphan revenue
    const orphanRevenue = orphans.reduce((sum, o) => sum + (o.pricePaid ?? 0), 0) / 100;
    const totalRevenue = sales.reduce((sum, s) => sum + s.amount, 0) + orphanRevenue;

    // Export format?
    const url = new URL(request.url);
    const format = url.searchParams.get('format');

    if (format === 'csv' || format === 'xlsx') {
      return buildCsvResponse(sales, eventId, eventRow.title, format);
    }

    return buildJsonResponse(sales, orphans, totalRevenue);
  } catch (error) {
    log.error({ err: String(error), eventId }, 'Failed to fetch sales');
    return NextResponse.json({ error: 'Failed to fetch sales' }, { status: 500 });
  }
}
