import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { withLogger } from '@imajin/logger';
import { requireAdmin } from '@imajin/auth';

export const GET = withLogger('kernel', async (req, { log }) => {
  const sql = getClient();
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const service = url.searchParams.get('service') || null;
  const action = url.searchParams.get('action') || null;
  const did = url.searchParams.get('did') || null;
  const correlationId = url.searchParams.get('correlationId') || null;
  const from = url.searchParams.get('from') || null;
  const to = url.searchParams.get('to') || null;
  const limit = Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10));
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const [countRow] = await sql`
    SELECT COUNT(*)::int AS total
    FROM registry.system_events
    WHERE TRUE
    ${service ? sql`AND service = ${service}` : sql``}
    ${action ? sql`AND action = ${action}` : sql``}
    ${did ? sql`AND did = ${did}` : sql``}
    ${correlationId ? sql`AND correlation_id = ${correlationId}` : sql``}
    ${from ? sql`AND created_at >= ${from}::timestamptz` : sql``}
    ${to ? sql`AND created_at <= ${to}::timestamptz` : sql``}
  `;

  const rows = await sql`
    SELECT id, service, action, did, correlation_id, parent_event_id, payload, status, duration_ms, created_at
    FROM registry.system_events
    WHERE TRUE
    ${service ? sql`AND service = ${service}` : sql``}
    ${action ? sql`AND action = ${action}` : sql``}
    ${did ? sql`AND did = ${did}` : sql``}
    ${correlationId ? sql`AND correlation_id = ${correlationId}` : sql``}
    ${from ? sql`AND created_at >= ${from}::timestamptz` : sql``}
    ${to ? sql`AND created_at <= ${to}::timestamptz` : sql``}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  log.info({ service: 'kernel', filterService: service, action, limit, offset, count: rows.length }, 'admin events query');

  return NextResponse.json({ rows, total: countRow?.total ?? 0 });
});
