/**
 * POST /api/admin/withdrawals/gating
 *
 * Enable or disable withdrawals for a DID.
 * Body: { did: string, enabled: boolean }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, balances } from '@/src/db';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@imajin/auth';
import { withLogger } from '@imajin/logger';

export const POST = withLogger('kernel', async (request: NextRequest) => {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { did?: string; enabled?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { did, enabled } = body;
  if (!did || typeof enabled !== 'boolean') {
    return NextResponse.json(
      { error: 'did (string) and enabled (boolean) are required' },
      { status: 400 },
    );
  }

  const result = await db
    .update(balances)
    .set({ withdrawalsEnabled: enabled, updatedAt: new Date() })
    .where(eq(balances.did, did))
    .returning({ did: balances.did });

  if (result.length === 0) {
    return NextResponse.json({ error: 'Balance not found for DID' }, { status: 404 });
  }

  return NextResponse.json({ success: true, did, withdrawalsEnabled: enabled });
});
