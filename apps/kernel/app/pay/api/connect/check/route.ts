/**
 * GET /api/connect/check?did=xxx
 *
 * Public (no auth required) endpoint — returns minimal seller connect status
 * for buyer-facing pages to determine which payment options to show.
 *
 * Response: { connected: boolean, chargesEnabled: boolean }
 */

import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { rateLimit, getClientIP } from '@/src/lib/kernel/rate-limit';
import { db, connectedAccounts } from '@/src/db';
import { withLogger } from '@imajin/logger';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const GET = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 60, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } }
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

  try {
    const rows = await db
      .select({
        chargesEnabled: connectedAccounts.chargesEnabled,
      })
      .from(connectedAccounts)
      .where(eq(connectedAccounts.did, did))
      .limit(1);

    if (rows.length === 0) {
      return NextResponse.json(
        { connected: false, chargesEnabled: false },
        { headers: cors }
      );
    }

    const account = rows[0];
    return NextResponse.json(
      { connected: true, chargesEnabled: account.chargesEnabled ?? false },
      { headers: cors }
    );
  } catch (error) {
    log.error({ err: String(error) }, 'Connect check error');
    return NextResponse.json(
      { error: 'Check failed' },
      { status: 500, headers: cors }
    );
  }
});
