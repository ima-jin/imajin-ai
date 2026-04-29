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

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get('limit') ?? '50'), 200);
  const offset = Number(searchParams.get('offset') ?? '0');

  const rows = await sql`
    SELECT
      id, service, method, path, status, duration_ms, did, ip,
      correlation_id, error_message, created_at
    FROM registry.logs
    WHERE source = 'request'
      AND status >= 400
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count
    FROM registry.logs
    WHERE source = 'request'
      AND status >= 400
  `;

  log.info({ count, limit, offset }, 'error requests fetched');

  return NextResponse.json({ rows, total: count, limit, offset });
});
