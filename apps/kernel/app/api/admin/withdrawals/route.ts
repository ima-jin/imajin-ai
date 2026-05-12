/**
 * GET /api/admin/withdrawals
 *
 * List withdrawal requests. Optional ?status= filter.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, withdrawalRequests } from '@/src/db';
import { eq, desc } from 'drizzle-orm';
import { requireAdmin } from '@imajin/auth';
import { withLogger } from '@imajin/logger';

export const GET = withLogger(async (request: NextRequest) => {
  const authResult = await requireAdmin(request);
  if (authResult instanceof NextResponse) return authResult;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status');

  const rows = status
    ? await db
        .select()
        .from(withdrawalRequests)
        .where(eq(withdrawalRequests.status, status))
        .orderBy(desc(withdrawalRequests.requestedAt))
    : await db
        .select()
        .from(withdrawalRequests)
        .orderBy(desc(withdrawalRequests.requestedAt));

  return NextResponse.json({ withdrawals: rows });
});
