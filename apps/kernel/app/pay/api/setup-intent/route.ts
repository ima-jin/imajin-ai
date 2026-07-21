/**
 * POST /api/setup-intent
 *
 * Create a Stripe SetupIntent to save a payment method for later charging.
 * Used by campaign pledges — no money moves until the campaign succeeds.
 *
 * Request:
 * {
 *   amount: number,          // informational, stored in metadata (cents)
 *   currency: string,        // e.g. "CAD"
 *   metadata?: Record<string, string>
 * }
 *
 * Response:
 * {
 *   clientSecret: string,
 *   setupIntentId: string,
 *   customerId: string
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth , resolveActingDid } from '@imajin/auth';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { rateLimit, getClientIP } from '@imajin/config';
import { withLogger } from '@imajin/logger';
import { getStripe } from '@/src/lib/pay/stripe';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 20, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } }
    );
  }

  // Require auth
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status, headers: cors }
    );
  }

  const did = resolveActingDid(authResult.identity);

  try {
    const body = await request.json();
    const { amount, currency, metadata = {} } = body;

    if (typeof amount !== 'number' || amount <= 0) {
      return NextResponse.json(
        { error: 'amount must be a positive number' },
        { status: 400, headers: cors }
      );
    }

    if (!currency || typeof currency !== 'string') {
      return NextResponse.json(
        { error: 'currency is required' },
        { status: 400, headers: cors }
      );
    }

    const stripe = getStripe();

    // Find existing customer for this DID, or create one
    let customerId: string;
    try {
      const customers = await stripe.customers.list({
        limit: 1,
        ...(did ? { ['metadata[did]' as any]: did } : {}),
      } as any);
      if (customers.data.length > 0) {
        customerId = customers.data[0].id;
      } else {
        const newCustomer = await stripe.customers.create({
          metadata: { did },
        });
        customerId = newCustomer.id;
      }
    } catch (err) {
      log.error({ err: String(err) }, 'Stripe customer lookup/creation failed');
      return NextResponse.json(
        { error: 'Failed to set up payment customer' },
        { status: 500, headers: cors }
      );
    }

    // Create SetupIntent
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      metadata: {
        ...metadata,
        amount: String(amount),
        currency: currency.toUpperCase(),
        did,
      },
      usage: 'off_session',
    });

    return NextResponse.json({
      clientSecret: setupIntent.client_secret!,
      setupIntentId: setupIntent.id,
      customerId,
    }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'SetupIntent error');
    return NextResponse.json(
      { error: 'Failed to create setup intent' },
      { status: 500, headers: cors }
    );
  }
});
