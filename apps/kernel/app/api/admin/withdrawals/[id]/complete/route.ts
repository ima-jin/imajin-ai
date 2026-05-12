/**
 * POST /api/admin/withdrawals/[id]/complete
 *
 * Mark a withdrawal request as sent. Admin only.
 *
 * Request:
 * { admin_notes?: string }
 *
 * Response:
 * { success: boolean }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, withdrawalRequests, transactions } from '@/src/db';
import { eq, sql } from 'drizzle-orm';
import { requireAdmin } from '@imajin/auth';
import { withLogger } from '@imajin/logger';

export const POST = withLogger('kernel', async (req: NextRequest, { log }) => {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const id = req.nextUrl.pathname.split('/').pop();
    if (!id || !id.startsWith('wr_')) {
      return NextResponse.json({ error: 'Invalid withdrawal request ID' }, { status: 400 });
    }

    const body = (await req.json().catch(() => ({}))) as { admin_notes?: string };
    const adminNotes = body.admin_notes ?? null;

    // Find the withdrawal request
    const [request] = await db
      .select()
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.id, id))
      .limit(1);

    if (!request) {
      return NextResponse.json({ error: 'Withdrawal request not found' }, { status: 404 });
    }

    if (request.status === 'sent') {
      return NextResponse.json({ error: 'Already marked as sent' }, { status: 409 });
    }

    // Atomic update
    await db.transaction(async (tx) => {
      // Update withdrawal request
      await tx
        .update(withdrawalRequests)
        .set({
          status: 'sent',
          processedAt: new Date(),
          adminNotes: adminNotes ?? request.adminNotes,
        })
        .where(eq(withdrawalRequests.id, id));

      // Update related transaction to completed
      await tx
        .update(transactions)
        .set({
          status: 'completed',
        })
        .where(sql`${transactions.metadata}->>'withdrawal_request_id' = ${id}`);
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    log.error({ err: String(error) }, 'Admin withdrawal complete error');
    return NextResponse.json(
      { error: 'Failed to complete withdrawal' },
      { status: 500 }
    );
  }
});
