import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { requireAdmin } from '@imajin/auth';
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

async function resolveHandle(did: string): Promise<string | null> {
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/lookup/${encodeURIComponent(did)}`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      const identity = data.identity || data;
      return identity.handle || null;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * GET /api/admin/events/export.csv — export all events overview as CSV
 */
export async function GET(request: NextRequest) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const rows = await sql`
      WITH ticket_stats AS (
        SELECT
          event_id,
          COUNT(*) FILTER (WHERE status IN ('valid', 'used', 'held')) AS sold,
          COUNT(*) FILTER (WHERE used_at IS NOT NULL) AS used,
          SUM(price_paid) FILTER (WHERE status NOT IN ('refunded', 'cancelled')) AS revenue,
          COUNT(*) FILTER (WHERE registration_status = 'complete') AS surveys_completed
        FROM events.tickets
        GROUP BY event_id
      ),
      currency_info AS (
        SELECT
          event_id,
          COUNT(DISTINCT currency) AS currency_count,
          MAX(currency) AS sample_currency
        FROM events.tickets
        WHERE currency IS NOT NULL
        GROUP BY event_id
      ),
      type_info AS (
        SELECT
          event_id,
          COUNT(*) AS type_count,
          BOOL_OR(registration_form_id IS NOT NULL) AS has_form
        FROM events.ticket_types
        GROUP BY event_id
      )
      SELECT
        e.id,
        e.title,
        e.status,
        e.starts_at,
        e.ends_at,
        e.city,
        e.creator_did,
        COALESCE(ti.type_count, 0) AS ticket_type_count,
        COALESCE(ts.sold, 0) AS tickets_sold,
        COALESCE(ts.used, 0) AS tickets_used,
        COALESCE(ts.revenue, 0) AS total_revenue,
        CASE WHEN ci.currency_count > 1 THEN '' ELSE ci.sample_currency END AS currency,
        COALESCE(ti.has_form, false) AS has_registration_form,
        COALESCE(ts.surveys_completed, 0) AS surveys_completed
      FROM events.events e
      LEFT JOIN ticket_stats ts ON ts.event_id = e.id
      LEFT JOIN currency_info ci ON ci.event_id = e.id
      LEFT JOIN type_info ti ON ti.event_id = e.id
      ORDER BY e.created_at DESC
    `;

    // Batch-resolve creator handles
    const creatorDids = [...new Set(rows.map((r: any) => r.creator_did).filter(Boolean))] as string[];
    const handleMap = new Map<string, string | null>();
    await Promise.all(
      creatorDids.map(async (did) => {
        const handle = await resolveHandle(did);
        handleMap.set(did, handle);
      })
    );

    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `imajin-events-${dateStr}.csv`;

    const headers = [
      'Event ID', 'Title', 'Status', 'Starts At', 'Ends At', 'City',
      'Creator DID', 'Creator Handle', 'Total Ticket Types', 'Tickets Sold',
      'Tickets Used', 'Total Revenue', 'Currency', 'Has Registration Form',
      'Surveys Completed Count',
    ];

    let csvBody = csvRow(headers);

    for (const r of rows) {
      const handle = r.creator_did ? (handleMap.get(r.creator_did) ?? '') : '';
      csvBody += csvRow([
        r.id,
        r.title,
        r.status,
        r.starts_at ? new Date(r.starts_at).toISOString() : '',
        r.ends_at ? new Date(r.ends_at).toISOString() : '',
        r.city || '',
        r.creator_did || '',
        handle,
        r.ticket_type_count,
        r.tickets_sold,
        r.tickets_used,
        r.total_revenue,
        r.currency || '',
        r.has_registration_form ? 'true' : 'false',
        r.surveys_completed,
      ]);
    }

    const bom = '\uFEFF';
    return new NextResponse(bom + csvBody, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to export events');
    return NextResponse.json({ error: 'Failed to export events' }, { status: 500 });
  }
}
