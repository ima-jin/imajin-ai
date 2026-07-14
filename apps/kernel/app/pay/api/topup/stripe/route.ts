/**
 * POST /pay/api/topup/stripe
 *
 * Create a Stripe Checkout session for MJNx top-up.
 * Auth required.
 *
 * Request: { amount: number, absorbFees: boolean }
 * Response: { url: string, sessionId: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getPaymentService } from '@/src/lib/pay/pay';
import { requireAuth } from '@imajin/auth';
import { db, transactions } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { rateLimit, getClientIP, buildPublicUrlAbsolute } from '@imajin/config';
import { STRIPE_RATE_BPS, STRIPE_FIXED_CENTS } from '@imajin/fair';
import { withLogger } from '@imajin/logger';

const MIN_TOPUP = 20; // $20 CAD minimum

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 10, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } }
    );
  }

  // Auth
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status || 401, headers: cors }
    );
  }

  const did = authResult.identity.actingAs || authResult.identity.id;
  const handle = authResult.identity.handle || '';

  let body: { amount?: number; absorbFees?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { amount, absorbFees } = body;

  if (!amount || typeof amount !== 'number' || amount < MIN_TOPUP) {
    return NextResponse.json(
      { error: `Minimum top-up is $${MIN_TOPUP}` },
      { status: 400, headers: cors }
    );
  }

  // Calculate charge amount in cents
  const amountCents = Math.round(amount * 100);
  let chargeAmountCents: number;

  if (absorbFees === false) {
    // User absorbs fees: they pay more, receive exact amount
    // chargeAmount = (amount + 0.30) / (1 - 0.029)
    chargeAmountCents = Math.ceil((amountCents + STRIPE_FIXED_CENTS) / (1 - STRIPE_RATE_BPS / 10000));
  } else {
    // Platform absorbs fees: charge = amount
    chargeAmountCents = amountCents;
  }

  // Ensure Stripe minimum (50 cents)
  if (chargeAmountCents < 50) {
    chargeAmountCents = 50;
  }

  const pay = getPaymentService();

  const baseUrl = buildPublicUrlAbsolute('pay');

  const result = await pay.checkout({
    items: [
      {
        name: 'MJNx Top-Up',
        description: `$${amount.toFixed(2)} CAD → MJNx balance`,
        amount: chargeAmountCents,
        quantity: 1,
      },
    ],
    currency: 'CAD',
    successUrl: `${baseUrl}/topup/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${baseUrl}/topup`,
    metadata: {
      service: 'topup',
      type: 'topup',
      buyerDid: did,
      topupAmount: amount.toString(),
      absorbFees: absorbFees === false ? 'false' : 'true',
      handle,
    },
  });

  // Create pending transaction record
  const txId = generateId('tx');
  await db.insert(transactions).values({
    id: txId,
    service: 'topup',
    type: 'topup',
    fromDid: did,
    toDid: did,
    amount: amount.toString(),
    currency: 'CAD',
    status: 'pending',
    stripeId: result.id,
    source: 'fiat',
    metadata: {
      method: 'stripe',
      topupAmount: amount.toString(),
      chargeAmountCents: chargeAmountCents.toString(),
      absorbFees: absorbFees === false ? 'false' : 'true',
      handle,
    },
  });

  log.info(
    { service: 'pay', did, amount, chargeAmountCents, absorbFees, sessionId: result.id },
    'Top-up Stripe checkout created'
  );

  return NextResponse.json(
    { url: result.url, sessionId: result.id },
    { headers: cors }
  );
});
