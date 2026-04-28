import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { withLogger } from '@imajin/logger';
import { requireAdmin } from '@imajin/auth';

export const GET = withLogger('kernel', async (req: NextRequest, { log }) => {
  const sql = getClient();
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const service = url.searchParams.get('service') || null;
  const levelParam = url.searchParams.get('level') || null;
  const levels = levelParam ? levelParam.split(',').filter(Boolean) : null;
  const correlationId = url.searchParams.get('correlationId') || null;
  const did = url.searchParams.get('did') || null;
  const search = url.searchParams.get('search') || null;
  const from = url.searchParams.get('from') || null;
  const to = url.searchParams.get('to') || null;
  const limit = Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10));
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  // Map level filters to status code ranges
  const errorsOnly = levels && levels.length > 0 && levels.every(l => l === 'error');
  const warnsAndErrors = levels && levels.length > 0 && levels.every(l => l === 'error' || l === 'warn');

  const [countRow] = await sql`
    SELECT COUNT(*)::int AS total
    FROM registry.request_log
    WHERE TRUE
    ${service ? sql`AND service = ${service}` : sql``}
    ${errorsOnly ? sql`AND status >= 500` : warnsAndErrors ? sql`AND status >= 400` : sql``}
    ${correlationId ? sql`AND correlation_id = ${correlationId}` : sql``}
    ${did ? sql`AND did = ${did}` : sql``}
    ${search ? sql`AND (path ILIKE ${'%' + search + '%'} OR error_message ILIKE ${'%' + search + '%'})` : sql``}
    ${from ? sql`AND created_at >= ${from}::timestamptz` : sql``}
    ${to ? sql`AND created_at <= ${to}::timestamptz` : sql``}
  `;

  const rows = await sql`
    SELECT
      id,
      service,
      CASE WHEN status >= 500 THEN 'error' WHEN status >= 400 THEN 'warn' ELSE 'info' END AS level,
      COALESCE(error_message, method || ' ' || path || ' → ' || status) AS message,
      correlation_id,
      did,
      method,
      path,
      json_build_object('status', status, 'duration_ms', duration_ms, 'ip', ip) AS metadata,
      created_at
    FROM registry.request_log
    WHERE TRUE
    ${service ? sql`AND service = ${service}` : sql``}
    ${errorsOnly ? sql`AND status >= 500` : warnsAndErrors ? sql`AND status >= 400` : sql``}
    ${correlationId ? sql`AND correlation_id = ${correlationId}` : sql``}
    ${did ? sql`AND did = ${did}` : sql``}
    ${search ? sql`AND (path ILIKE ${'%' + search + '%'} OR error_message ILIKE ${'%' + search + '%'})` : sql``}
    ${from ? sql`AND created_at >= ${from}::timestamptz` : sql``}
    ${to ? sql`AND created_at <= ${to}::timestamptz` : sql``}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  log.info({ service: 'kernel', filterService: service, levels, limit, offset, count: rows.length }, 'admin logs query');

  return NextResponse.json({ rows, total: countRow?.total ?? 0 });
});
