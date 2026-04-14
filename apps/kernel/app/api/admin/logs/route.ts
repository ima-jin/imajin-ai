import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { withLogger } from '@imajin/logger';
import { requireAdmin } from '@imajin/auth';

const sql = getClient();

export const GET = withLogger('kernel', async (req: NextRequest, { log }) => {
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

  const [countRow] = await sql`
    SELECT COUNT(*)::int AS total
    FROM registry.app_logs
    WHERE TRUE
    ${service ? sql`AND service = ${service}` : sql``}
    ${levels && levels.length > 0 ? sql`AND level = ANY(${levels})` : sql``}
    ${correlationId ? sql`AND correlation_id = ${correlationId}` : sql``}
    ${did ? sql`AND did = ${did}` : sql``}
    ${search ? sql`AND message ILIKE ${'%' + search + '%'}` : sql``}
    ${from ? sql`AND created_at >= ${from}::timestamptz` : sql``}
    ${to ? sql`AND created_at <= ${to}::timestamptz` : sql``}
  `;

  const rows = await sql`
    SELECT id, service, level, message, correlation_id, did, method, path, metadata, created_at
    FROM registry.app_logs
    WHERE TRUE
    ${service ? sql`AND service = ${service}` : sql``}
    ${levels && levels.length > 0 ? sql`AND level = ANY(${levels})` : sql``}
    ${correlationId ? sql`AND correlation_id = ${correlationId}` : sql``}
    ${did ? sql`AND did = ${did}` : sql``}
    ${search ? sql`AND message ILIKE ${'%' + search + '%'}` : sql``}
    ${from ? sql`AND created_at >= ${from}::timestamptz` : sql``}
    ${to ? sql`AND created_at <= ${to}::timestamptz` : sql``}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  log.info({ service: 'kernel', filterService: service, levels, limit, offset, count: rows.length }, 'admin logs query');

  return NextResponse.json({ rows, total: countRow?.total ?? 0 });
});
