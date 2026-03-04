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
      { error: error instanceof Error ? error.message : 'Failed to retrieve account status' },
      { status: 500, headers: cors }
    );
  }
}
