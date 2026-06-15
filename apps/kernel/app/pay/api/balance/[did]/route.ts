/**
 * GET /api/balance/[did]
 *
 * Get current balance for a DID.
 * Auth: must be authenticated as the requested DID.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, balances } from '@/src/db';
import { eq } from 'drizzle-orm';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { requireAuth, requireAppAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

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

  let effectiveDid: string;
  let isAgentDelegated = false;

  // App auth path
  if (request.headers.get('x-app-did')) {
    const appResult = await requireAppAuth(request, { scope: 'wallet:read' });
    if ('error' in appResult) {
      return NextResponse.json(
        { error: appResult.error },
        { status: appResult.status, headers: cors }
      );
    }
    effectiveDid = appResult.appAuth.userDid;
  } else {
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: cors }
      );
    }
    effectiveDid = authResult.identity.actingAs || authResult.identity.id;
    isAgentDelegated =
      authResult.identity.actingAs === decoded &&
      authResult.identity.actingAsRole === 'agent';
  }

  if (effectiveDid !== decoded && !isAgentDelegated) {
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

    const cashAmount = row ? Number.parseFloat(row.cashAmount) : 0;
    const creditAmount = row ? Number.parseFloat(row.creditAmount) : 0;

    return NextResponse.json(
      {
        did: decoded,
        cashAmount,
        creditAmount,
        mjnBalance: creditAmount,
        total: cashAmount + creditAmount,
        currency: row?.currency || 'CAD',
        updatedAt: row?.updatedAt?.toISOString() || new Date().toISOString(),
      },
      { headers: cors }
    );
  } catch (error) {
    log.error({ err: String(error) }, 'Balance fetch error');
    return NextResponse.json(
      { error: 'Failed to fetch balance' },
      { status: 500, headers: cors }
    );
  }
}
