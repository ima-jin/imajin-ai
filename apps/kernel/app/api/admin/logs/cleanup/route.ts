import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { withLogger } from '@imajin/logger';
import { requireAdmin } from '@imajin/auth';

export const POST = withLogger('kernel', async (req: NextRequest, { log }) => {
  const sql = getClient();
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const days = Math.max(1, parseInt(url.searchParams.get('days') || '14', 10));

  const [result] = await sql`
    SELECT registry.cleanup_old_logs(${days}) AS deleted
  `;

  const deleted = result?.deleted ?? 0;
  log.info({ service: 'kernel', days, deleted }, 'admin logs cleanup');

  return NextResponse.json({ deleted });
});
