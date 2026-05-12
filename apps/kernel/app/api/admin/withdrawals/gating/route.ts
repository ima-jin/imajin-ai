/**
 * POST /api/admin/withdrawals/gating
 *
 * Toggle withdrawals_enabled for a DID. Admin only.
 *
 * Request:
 * { did: string, enabled: boolean }
 *
 * Response:
 * { success: boolean }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, balances } from '@/src/db';
import { requireAdmin } from '@imajin/auth';
import { withLogger } from '@imajin/logger';

export const POST = withLogger('kernel', async (req: NextRequest, { log }) => {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = (await req.json()) as { did?: string; enabled?: boolean };
    const { did, enabled } = body;

    if (!did || typeof did !== 'string') {
      return NextResponse.json({ error: 'did is required' }, { status: 400 });
    }
    if (typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
    }

    await db
      .insert(balances)
      .values({
        did,
        cashAmount: '0',
        creditAmount: '0',
        currency: 'CAD',
        withdrawalsEnabled: enabled,
      })
      .onConflictDoUpdate({
        target: balances.did,
        set: {
          withdrawalsEnabled: enabled,
          updatedAt: new Date(),
        },
      });

    return NextResponse.json({ success: true });
  } catch (error) {
    log.error({ err: String(error) }, 'Admin withdrawals gating error');
    return NextResponse.json(
      { error: 'Failed to update gating' },
      { status: 500 }
    );
  }
});
