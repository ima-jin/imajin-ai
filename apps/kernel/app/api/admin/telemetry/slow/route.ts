import { NextRequest, NextResponse } from 'next/server';
import { withLogger } from '@imajin/logger';
import { requireAdmin } from '@imajin/auth';
import { fetchTelemetryRequests, parseTelemetryPagination } from '../shared';

export const GET = withLogger('kernel', async (req: NextRequest, { log }) => {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { limit, offset } = parseTelemetryPagination(req.url);
  const { rows, total, logLabel } = await fetchTelemetryRequests('slow', limit, offset);
  log.info({ count: total, limit, offset }, logLabel);
  return NextResponse.json({ rows, total, limit, offset });
});
