/**
 * POST /api/connect/onboard
 *
 * Create a Stripe Connect Express account for the authenticated DID
 * and return an onboarding URL.
 *
 * Auth: required (must be a human/hard DID)
 *
 * Request:
 * { return_url: string, refresh_url: string }
 *
 * Response:
 * { accountId: string, onboardingUrl: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { authenticateRequest } from '@/lib/session-auth';
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

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const auth = await authenticateRequest(request);
  if (!auth.authenticated || !auth.identity) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: cors }
    );
  }

  // Must be a human (hard DID), not an agent
  if (auth.identity.type !== 'human') {
    return NextResponse.json(
      { error: 'Forbidden - only human accounts can onboard to Stripe Connect' },
      { status: 403, headers: cors }
    );
  }

  try {
    const body = await request.json();
    const { return_url, refresh_url } = body;

    if (!return_url || !refresh_url) {
      return NextResponse.json(
        { error: 'return_url and refresh_url are required' },
        { status: 400, headers: cors }
      );
    }

    const stripe = getStripe();

    // Create a Stripe Connect Express account for this DID
    const account = await stripe.accounts.create({
      type: 'express',
      metadata: {
        did: auth.identity.did,
      },
    });

    // Generate the onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      return_url,
      refresh_url,
      type: 'account_onboarding',
    });

    return NextResponse.json(
      {
        accountId: account.id,
        onboardingUrl: accountLink.url,
      },
      { headers: cors }
    );
  } catch (error) {
    console.error('Connect onboard error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Onboarding failed' },
      { status: 500, headers: cors }
    );
  }
}
