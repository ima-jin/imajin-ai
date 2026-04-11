import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { withLogger } from '@imajin/logger';
import { requireAdmin } from '@imajin/auth';

const sql = getClient();

export const GET = withLogger('kernel', async (req, { log }) => {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Extract correlationId from path: .../trace/[correlationId]
  const correlationId = new URL(req.url).pathname.split('/').at(-1);
  if (!correlationId) {
    return NextResponse.json({ error: 'Missing correlationId' }, { status: 400 });
  }

  const events = await sql`
    SELECT id, service, action, did, correlation_id, parent_event_id, payload, status, duration_ms, created_at
    FROM registry.system_events
    WHERE correlation_id = ${correlationId}
    ORDER BY created_at ASC
  `;

  log.info({ service: 'kernel', correlationId, count: events.length }, 'admin events trace query');

  return NextResponse.json({ events, correlationId });
});
