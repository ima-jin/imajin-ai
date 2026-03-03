/**
 * GET /api/balance/[did]
 *
 * Get current balance for a DID.
 * Auth: must be authenticated as the requested DID.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, balances } from '@/src/db';
import { eq } from 'drizzle-orm';
import { corsHeaders } from '@/src/lib/cors';
import { authenticateRequest } from '@/lib/session-auth';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  const { did } = await params;
  const decoded = decodeURIComponent(did);

  // Authenticate via cookie or Bearer token
  const auth = await authenticateRequest(request);
  if (!auth.authenticated || !auth.identity) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: cors }
    );
  }

  // Must be requesting your own balance
  if (auth.identity.did !== decoded) {
    return NextResponse.json(
      { error: 'Forbidden - can only access your own balance' },
      { status: 403, headers: cors }
    );
  }

  try {
    const [row] = await db
      .select()
      .from(balances)
      .where(eq(balances.did, decoded))
      .limit(1);

    return NextResponse.json(
      {
        did: decoded,
        amount: row ? parseFloat(row.amount) : 0,
        currency: row?.currency || 'USD',
        updatedAt: row?.updatedAt?.toISOString() || new Date().toISOString(),
      },
      { headers: cors }
    );
  } catch (error) {
    console.error('Balance fetch error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch balance' },
      { status: 500, headers: cors }
    );
  }
}
