/**
 * GET /api/connect/dashboard?did=xxx
 *
 * Generate a Stripe Express Dashboard login link for the connected account.
 *
 * Auth: required
 *
 * Response:
 * { url: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { rateLimit, getClientIP } from '@/src/lib/kernel/rate-limit';
import { db, connectedAccounts } from '@/src/db';
import { getStripe } from '@/src/lib/pay/stripe';
import { withLogger } from '@imajin/logger';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const GET = withLogger('kernel', async (request: NextRequest, { log }) => {
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

    if (!account.onboardingComplete) {
      return NextResponse.json(
        { error: 'Onboarding not complete for this account' },
        { status: 400, headers: cors }
      );
    }

    const stripe = getStripe();
    const loginLink = await stripe.accounts.createLoginLink(account.stripeAccountId);

    return NextResponse.json({ url: loginLink.url }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Connect dashboard error');
    return NextResponse.json(
      { error: 'Dashboard link generation failed' },
      { status: 500, headers: cors }
    );
  }
});
