/**
 * POST /api/admin/withdrawals/[id]/complete
 *
 * Mark a withdrawal request as 'sent' and update related transaction.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, withdrawalRequests } from '@/src/db';
import { eq, sql } from 'drizzle-orm';
import { requireAdmin } from '@imajin/auth';
import { withLogger } from '@imajin/logger';

export const POST = withLogger('kernel', async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;

  // Find the withdrawal request
  const [wr] = await db
    .select()
    .from(withdrawalRequests)
    .where(eq(withdrawalRequests.id, id));

  if (!wr) {
    return NextResponse.json({ error: 'Withdrawal request not found' }, { status: 404 });
  }

  if (wr.status === 'sent') {
    return NextResponse.json({ error: 'Already marked as sent' }, { status: 400 });
  }

  const now = new Date();

  // Parse optional admin notes
  let adminNotes: string | undefined;
  try {
    const body = await request.json();
    adminNotes = body.adminNotes;
  } catch {
    // No body is fine
  }

  await db.transaction(async (tx) => {
    // Update withdrawal request
    await tx
      .update(withdrawalRequests)
      .set({
        status: 'sent',
        processedAt: now,
        ...(adminNotes ? { adminNotes } : {}),
      })
      .where(eq(withdrawalRequests.id, id));

    // Update related transaction to completed
    // Find by metadata match
    await tx.execute(
      sql`UPDATE pay.transactions
          SET status = 'completed'
          WHERE metadata->>'withdrawal_request_id' = ${id}
            AND status = 'pending'`,
    );
  });

  return NextResponse.json({ success: true, id, status: 'sent' });
});
