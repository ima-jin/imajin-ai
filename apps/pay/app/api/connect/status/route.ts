/**
 * GET /api/connect/status?account_id=acct_xxx
 *
 * Returns whether a connected account has completed onboarding.
 *
 * Response:
 * { accountId: string, chargesEnabled: boolean, payoutsEnabled: boolean, detailsSubmitted: boolean }
 */

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { corsHeaders } from '@/src/lib/cors';
import { rateLimit, getClientIP } from '@/src/lib/rate-limit';
import { authenticateRequest } from '@/lib/session-auth';

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
  const accountId = searchParams.get('account_id');

  if (!accountId) {
    return NextResponse.json(
      { error: 'account_id query parameter is required' },
      { status: 400, headers: cors }
    );
  }

  try {
    const stripe = getStripe();
    const account = await stripe.accounts.retrieve(accountId);

    return NextResponse.json(
      {
        accountId: account.id,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        detailsSubmitted: account.details_submitted,
      },
      { headers: cors }
    );
  } catch (error) {
    console.error('Connect status error:', error);
    return NextResponse.json(
      { error: 'Status check failed' },
      { status: 500, headers: cors }
    );
  }
}
