/**
 * GET /api/connect/status?did=xxx
 *
 * Returns the connected account status for a DID (from DB, kept fresh by webhook).
 *
 * Response:
 * { id, did, stripeAccountId, chargesEnabled, payoutsEnabled, detailsSubmitted, onboardingComplete, ... }
 */

import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { corsHeaders } from '@/src/lib/pay/cors';
import { rateLimit, getClientIP } from '@/src/lib/pay/rate-limit';
import { requireAuth } from '@imajin/auth';
import { db, connectedAccounts } from '@/src/db';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 30, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } }
    );
  }

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: cors }
    );
  }

  const { searchParams } = new URL(request.url);
  const did = searchParams.get('did');

  if (!did) {
    return NextResponse.json(
      { error: 'did query parameter is required' },
      { status: 400, headers: cors }
    );
  }

  const effectiveDid = authResult.identity.actingAs || authResult.identity.id;
  if (effectiveDid !== did) {
    return NextResponse.json(
      { error: 'Not authorized to access this account' },
      { status: 403, headers: cors }
    );
  }

  try {
    const rows = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.did, did))
      .limit(1);

    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'No connected account for this DID' },
        { status: 404, headers: cors }
      );
    }

    const account = rows[0];
    return NextResponse.json({
      did: account.did,
      stripeAccountId: account.stripeAccountId,
      chargesEnabled: account.chargesEnabled,
      payoutsEnabled: account.payoutsEnabled,
      detailsSubmitted: account.detailsSubmitted,
      onboardingComplete: account.onboardingComplete,
      defaultCurrency: account.defaultCurrency,
    }, { headers: cors });
  } catch (error) {
    console.error('Connect status error:', error);
    return NextResponse.json(
      { error: 'Status check failed' },
      { status: 500, headers: cors }
    );
  }
}
