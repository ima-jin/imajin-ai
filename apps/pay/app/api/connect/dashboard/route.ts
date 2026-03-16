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
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { authenticateRequest } from '@/lib/session-auth';
import { corsHeaders } from '@/src/lib/cors';
import { rateLimit, getClientIP } from '@/src/lib/rate-limit';
import { db, connectedAccounts } from '@/src/db';

let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY not configured');
    }
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
    });
  }
  return _stripe;
}

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

  const auth = await authenticateRequest(request);
  if (!auth.authenticated) {
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
    console.error('Connect dashboard error:', error);
    return NextResponse.json(
      { error: 'Dashboard link generation failed' },
      { status: 500, headers: cors }
    );
  }
}
