/**
 * GET /api/balance/[did]
 *
 * Get current balance for a DID.
 * Auth: must be authenticated as the same DID (via session).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, balances } from '@/src/db';
import { eq } from 'drizzle-orm';
import { extractToken, validateToken } from '@/lib/auth';
import { corsHeaders } from '@/src/lib/cors';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(
  request: NextRequest,
  { params }: { params: { did: string } }
) {
  const cors = corsHeaders(request);

  try {
    const { did } = params;

    // Auth: must be the DID owner
    const token = extractToken(request.headers.get('authorization'));
    if (!token) {
      return NextResponse.json(
        { error: 'Unauthorized - no token provided' },
        { status: 401, headers: cors }
      );
    }

    const validation = await validateToken(token);
    if (!validation.valid || !validation.identity) {
      return NextResponse.json(
        { error: 'Unauthorized - invalid token' },
        { status: 401, headers: cors }
      );
    }

    // Check if the authenticated user matches the requested DID
    if (validation.identity.id !== did) {
      return NextResponse.json(
        { error: 'Forbidden - can only access your own balance' },
        { status: 403, headers: cors }
      );
    }

    // Get balance from DB
    const balanceRows = await db
      .select()
      .from(balances)
      .where(eq(balances.did, did))
      .limit(1);

    const balance = balanceRows[0];

    return NextResponse.json(
      {
        did,
        amount: balance ? parseFloat(balance.amount) : 0,
        currency: balance?.currency || 'USD',
        updatedAt: balance?.updatedAt?.toISOString() || new Date().toISOString(),
      },
      { headers: cors }
    );
  } catch (error) {
    console.error('Balance fetch error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch balance' },
      { status: 500, headers: cors }
    );
  }
}
