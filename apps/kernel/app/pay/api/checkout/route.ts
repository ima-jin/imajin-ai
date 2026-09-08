/**
 * POST /api/checkout
 * 
 * Create a hosted Stripe Checkout session.
 * Returns a URL to redirect the customer to.
 * 
 * Request:
 * {
 *   items: [{ name: string, description?: string, amount: number, quantity: number, image?: string }],
 *   currency: "USD" | "CAD" | "EUR" | "GBP",
 *   customerEmail?: string,
 *   successUrl: string,
 *   cancelUrl: string,
 *   metadata?: Record<string, string>
 * }
 * 
 * Response:
 * {
 *   id: string,
 *   url: string,
 *   expiresAt: string
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getPaymentService } from '@/src/lib/pay/pay';
import { resolveActingDid } from '@imajin/auth';
import type { CheckoutRequest, FiatCurrency } from '@/src/lib/pay';
import { db, transactions } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { rateLimit, getClientIP } from '@imajin/config';
import { withLogger } from '@imajin/logger';
import {
  resolveCheckoutIdentity,
  resolveConnectedAccountFee,
  validateCheckoutBody,
  type CheckoutBody as CheckoutBodyBase,
} from '@/src/lib/pay/checkout';

type CheckoutBody = CheckoutBodyBase & { currency: FiatCurrency };

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

  try {
    const body: CheckoutBody = await request.json();

    const bodyValidation = validateCheckoutBody(body);
    if (!bodyValidation.ok) {
      return NextResponse.json({ error: bodyValidation.error }, { status: bodyValidation.status, headers: cors });
    }

    const identityResult = await resolveCheckoutIdentity(request);
    if (!identityResult.ok) {
      return NextResponse.json({ error: identityResult.error }, { status: identityResult.status, headers: cors });
    }
    const { identity } = identityResult;

    const pay = getPaymentService();

    // Resolve connected account from sellerDid if provided, and compute the
    // application fee (platform share + processing fees).
    const feeResult = await resolveConnectedAccountFee(body);
    if (!feeResult.ok) {
      return NextResponse.json(
        { error: feeResult.error, ...(feeResult.code && { code: feeResult.code }) },
        { status: feeResult.status, headers: cors },
      );
    }
    const { connectedAccountId: resolvedConnectedAccountId, applicationFeeAmount } = feeResult;

    const checkoutRequest: CheckoutRequest = {
      items: body.items,
      currency: body.currency || 'CAD',
      mode: body.mode,
      customerEmail: body.customerEmail,
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      metadata: {
        ...body.metadata,
        // Add identity if authenticated
        ...(identity && { identity_id: identity.id }),
      },
      connectedAccountId: resolvedConnectedAccountId,
      applicationFeeAmount,
    };
    
    const result = await pay.checkout(checkoutRequest);

    // Create a pending transaction
    const totalAmount = body.items.reduce((sum, item) => sum + (item.amount * item.quantity), 0);
    const txId = generateId('tx');

    await db.insert(transactions).values({
      id: txId,
      service: body.metadata?.service || 'unknown',
      type: body.metadata?.type || 'checkout',
      fromDid: identity ? resolveActingDid(identity) : null,
      toDid: body.metadata?.to_did || body.metadata?.recipient_did || 'platform',
      amount: (totalAmount / 100).toString(), // Convert cents to dollars
      currency: body.currency || 'CAD',
      status: 'pending',
      stripeId: result.id,
      metadata: body.metadata,
      fairManifest: body.fairManifest || null,
    });

    return NextResponse.json({
      id: result.id,
      url: result.url,
      expiresAt: result.expiresAt.toISOString(),
      transactionId: txId,
    }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Checkout error');
    return NextResponse.json(
      { error: 'Checkout failed' },
      { status: 500, headers: cors }
    );
  }
});
