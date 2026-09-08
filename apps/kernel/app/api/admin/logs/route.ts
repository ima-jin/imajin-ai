import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { withLogger } from '@imajin/logger';
import { requireAdmin } from '@imajin/auth';
import { buildLogsWhereFragment, parseLogFilters } from '@/src/lib/admin/logs-query';

export const GET = withLogger('kernel', async (req: NextRequest, { log }) => {
  const sql = getClient();
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const filters = parseLogFilters(url);
  const whereFragment = buildLogsWhereFragment(sql, filters);

  const [countRow] = await sql`
    SELECT COUNT(*)::int AS total
    FROM registry.logs
    WHERE TRUE
    ${whereFragment}
  `;

  const rows = await sql`
    SELECT id, source, service, level, message, correlation_id, did, method, path, status, duration_ms, ip, error_message, metadata, created_at
    FROM registry.logs
    WHERE TRUE
    ${whereFragment}
    ORDER BY created_at DESC
    LIMIT ${filters.limit} OFFSET ${filters.offset}
  `;

  log.info(
    { service: 'kernel', filterService: filters.service, levels: filters.levels, source: filters.source, limit: filters.limit, offset: filters.offset, count: rows.length },
    'admin logs query',
  );

  return NextResponse.json({ rows, total: countRow?.total ?? 0 });
});
