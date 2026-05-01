import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { requireAuth } from '@imajin/auth';
import { isEventOrganizer } from '@/src/lib/organizer';
import { getClient } from '@imajin/db';

const log = createLogger('events');
const sql = getClient();
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(values: unknown[]): string {
  return values.map(csvEscape).join(',') + '\r\n';
}

async function resolveProfile(did: string): Promise<{ name: string | null; handle: string | null; email: string | null }> {
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/lookup/${encodeURIComponent(did)}`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      const identity = data.identity || data;
      return {
        name: identity.name || null,
        handle: identity.handle || null,
        email: identity.email || null,
      };
    }
  } catch { /* ignore */ }
  return { name: null, handle: null, email: null };
}

function computeOrderStatus(tickets: { status: string }[]): string {
  if (tickets.length === 0) return 'unknown';
  const statuses = tickets.map(t => t.status);
  if (statuses.every(s => s === 'valid' || s === 'used')) return 'completed';
  if (statuses.every(s => s === 'refunded')) return 'refunded';
  if (statuses.every(s => s === 'cancelled')) return 'cancelled';
  if (statuses.some(s => s === 'held')) return 'pending';
  if (statuses.some(s => s === 'valid' || s === 'used')) return 'partial';
  return 'unknown';
}

/**
 * GET /api/events/[id]/sales/export — export sales as CSV
 * Query: ?format=xlsx (returns CSV for now — xlsx library not available)
 */
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
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const format = searchParams.get('format') || 'csv';

  try {
    const orgCheck = await isEventOrganizer(id, did);
    if (!orgCheck.authorized) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Fetch event for filename
    const [event] = await sql`
      SELECT id, title FROM events.events WHERE id = ${id} LIMIT 1
    `;
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Fetch orders
    const orderRows = await sql`
      SELECT
        o.id as order_id,
        o.buyer_did,
        o.quantity,
        o.amount_total,
        o.currency,
        o.payment_method,
        o.stripe_session_id,
        o.payment_id,
        o.purchased_at,
        tt.name as ticket_type
      FROM events.orders o
      JOIN events.ticket_types tt ON o.ticket_type_id = tt.id
      WHERE o.event_id = ${id}
      ORDER BY o.purchased_at DESC NULLS LAST, o.created_at DESC
    `;

    // Fetch tickets grouped by order
    const ticketRows = await sql`
      SELECT id, status, order_id
      FROM events.tickets
      WHERE event_id = ${id}
    `;

    const ticketsByOrder = new Map<string, { ticketId: string; status: string }[]>();
    for (const t of ticketRows) {
      if (t.order_id) {
        const list = ticketsByOrder.get(t.order_id) || [];
        list.push({ ticketId: t.id, status: t.status });
        ticketsByOrder.set(t.order_id, list);
      }
    }

    // Resolve buyer profiles
    const uniqueDids = [...new Set(orderRows.map((o: any) => o.buyer_did).filter(Boolean))] as string[];
    const profileMap = new Map<string, { name: string | null; handle: string | null; email: string | null }>();
    await Promise.all(
      uniqueDids.map(async (buyerDid) => {
        const profile = await resolveProfile(buyerDid);
        profileMap.set(buyerDid, profile);
      })
    );

    const dateStr = new Date().toISOString().split('T')[0];
    const safeTitle = event.title
      ? event.title.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
      : event.id;
    const filename = `${safeTitle || event.id}-sales-${dateStr}.${format === 'xlsx' ? 'xlsx' : 'csv'}`;

    const headers = [
      'Order ID', 'Buyer Name', 'Buyer Handle', 'Buyer Email', 'Buyer DID',
      'Ticket Type', 'Quantity', 'Amount Total', 'Currency', 'Status',
      'Payment Method', 'Stripe Session ID', 'Stripe Payment ID',
      'Purchased At', 'Ticket IDs', 'Ticket Statuses',
    ];

    let csvBody = csvRow(headers);

    for (const o of orderRows) {
      const orderTickets = ticketsByOrder.get(o.order_id) || [];
      const profile = o.buyer_did ? profileMap.get(o.buyer_did) ?? null : null;
      const status = computeOrderStatus(orderTickets);

      const values = [
        o.order_id,
        profile?.name || '',
        profile?.handle || '',
        profile?.email || '',
        o.buyer_did || '',
        o.ticket_type,
        o.quantity,
        o.amount_total / 100,
        o.currency || 'CAD',
        status,
        o.payment_method || '',
        o.stripe_session_id || '',
        o.payment_id || '',
        o.purchased_at ? new Date(o.purchased_at).toISOString() : '',
        orderTickets.map(t => t.ticketId).join('; '),
        orderTickets.map(t => t.status).join('; '),
      ];

      csvBody += csvRow(values);
    }

    const bom = '\uFEFF';
    const contentType = format === 'xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'text/csv; charset=utf-8';

    return new NextResponse(bom + csvBody, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to export sales');
    return NextResponse.json({ error: 'Failed to export sales' }, { status: 500 });
  }
}
