/**
 * GET /api/admin/withdrawals
 *
 * List withdrawal requests. Admin only.
 *
 * Query:
 * ?status=requested — filter by status
 *
 * Response:
 * { withdrawals: WithdrawalRequest[] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, withdrawalRequests } from '@/src/db';
import { desc, eq } from 'drizzle-orm';
import { requireAdmin } from '@imajin/auth';
import { withLogger } from '@imajin/logger';

export const GET = withLogger('kernel', async (req: NextRequest, { log }) => {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const statusFilter = searchParams.get('status')?.trim();

    let query = db
      .select()
      .from(withdrawalRequests)
      .orderBy(desc(withdrawalRequests.requestedAt));

    if (statusFilter) {
      query = query.where(eq(withdrawalRequests.status, statusFilter)) as typeof query;
    }

    const rows = await query;

    return NextResponse.json({ withdrawals: rows });
  } catch (error) {
    log.error({ err: String(error) }, 'Admin withdrawals list error');
    return NextResponse.json(
      { error: 'Failed to fetch withdrawals' },
      { status: 500 }
    );
  }
});
