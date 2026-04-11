import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { requireAdmin, withLogger } from '@imajin/logger';

const sql = getClient();

export const GET = withLogger('kernel', async (req: NextRequest, { log }) => {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const correlationId = req.url.split('/trace/')[1]?.split('?')[0];
  if (!correlationId) {
    return NextResponse.json({ error: 'Missing correlationId' }, { status: 400 });
  }

  const rows = await sql`
    SELECT
      id, service, method, path, status, duration_ms, did, ip,
      correlation_id, error_message, created_at
    FROM registry.request_log
    WHERE correlation_id = ${correlationId}
    ORDER BY created_at ASC
  `;

  log.info({ correlationId, steps: rows.length }, 'trace fetched');

  return NextResponse.json({ correlationId, steps: rows });
});
