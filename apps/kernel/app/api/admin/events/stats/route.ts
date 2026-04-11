import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { requireAdmin, withLogger } from '@imajin/logger';

const sql = getClient();

export const GET = withLogger('kernel', async (req, { log }) => {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const defaultFrom = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const from = url.searchParams.get('from') || defaultFrom;
  const to = url.searchParams.get('to') || new Date().toISOString();

  const [countRow] = await sql`
    SELECT COUNT(*)::int AS total
    FROM registry.system_events
    WHERE created_at >= ${from}::timestamptz
    AND created_at <= ${to}::timestamptz
  `;

  const byService = await sql`
    SELECT service, COUNT(*)::int AS count
    FROM registry.system_events
    WHERE created_at >= ${from}::timestamptz
    AND created_at <= ${to}::timestamptz
    GROUP BY service
    ORDER BY count DESC
  `;

  const byAction = await sql`
    SELECT service, action, COUNT(*)::int AS count
    FROM registry.system_events
    WHERE created_at >= ${from}::timestamptz
    AND created_at <= ${to}::timestamptz
    GROUP BY service, action
    ORDER BY count DESC
    LIMIT 50
  `;

  log.info({ service: 'kernel', total: countRow?.total ?? 0 }, 'admin events stats query');

  return NextResponse.json({
    byService,
    byAction,
    total: countRow?.total ?? 0,
  });
});
