/**
 * GET /api/balance/[did]
 *
 * Get current balance for a DID.
 * Auth: must be authenticated as the requested DID.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/src/db';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { requireAuth, requireAppAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { MJN, MJNX, amountOf, getBalances } from '@/src/lib/pay/ledger';

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
    effectiveDid = resolveActingDid(authResult.identity);
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
    const rows = await getBalances(db, decoded);
    const mjnRow = rows.find((r) => r.unit === MJN);
    const mjnxRow = rows.find((r) => r.unit === MJNX);

    const mjnAmount = amountOf(mjnRow);
    const mjnxAmount = amountOf(mjnxRow);
    const updatedAt = mjnRow?.updatedAt ?? mjnxRow?.updatedAt ?? null;

    // #2016: balances is now an explicit per-unit array (decision 5) — MJN
    // (receipt-backed, withdrawable) and MJNx (emitted, in-platform, never
    // withdrawable) are always distinct entries, never summed into one
    // ambiguous number. `total`/`currency` are kept for the handful of
    // downstream app proxies (coffee/events/market/learn) that only ever
    // read those two fields — see the #2016 wire-contract table in the PR.
    return NextResponse.json(
      {
        did: decoded,
        balances: [
          { unit: MJN, amount: mjnAmount, withdrawable: true },
          { unit: MJNX, amount: mjnxAmount, withdrawable: false },
        ],
        total: mjnAmount + mjnxAmount,
        currency: mjnRow?.currency || 'CAD',
        updatedAt: updatedAt?.toISOString() || new Date().toISOString(),
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
