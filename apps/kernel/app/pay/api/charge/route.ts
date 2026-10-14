/**
 * POST /api/charge
 * 
 * Create a direct payment charge.
 * For Stripe: creates PaymentIntent (requires frontend to confirm)
 * For Solana: returns unsigned transaction (requires wallet signature)
 * 
 * Request:
 * {
 *   amount: number,          // cents for fiat, lamports for SOL, base units for tokens
 *   currency: string,        // USD, CAD, SOL, USDC, MJN
 *   to: { customerId?: string, provider?: "stripe", solanaAddress?: string, did?: string,
 *         stripeCustomerId?: string },   // stripeCustomerId = legacy alias of customerId
 *   description?: string,
 *   metadata?: Record<string, string>,
 *   idempotencyKey?: string
 * }
 * 
 * Response:
 * {
 *   id: string,
 *   provider: "stripe" | "solana",
 *   status: "pending" | "requires_action" | "succeeded" | "failed",
 *   amount: number,
 *   currency: string,
 *   clientSecret?: string,   // rail client confirmation secret (Stripe PaymentIntent) - for frontend confirmation
 *   signature?: string,      // Solana - if already signed
 *   metadata?: object
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveDidStripeKeys, SellerNoCardRailError } from '@/src/lib/pay/rails/stripe-keys';
import { chargeSeller } from '@/src/lib/pay/providers/seller-stripe-payments';
import { prepareSellerCharge, persistSellerCharge, SellerChargeAlreadyAttemptedError } from '@/src/lib/pay/providers/seller-transactions';
import { rateLimit, getClientIP } from '@imajin/config';
import { getCryptoOnlyProvider } from '@/src/lib/pay/providers/crypto-only';
import { isCryptoCurrency } from '@/src/lib/pay/types';
import { requireAuth, requireAppAuth , resolveActingDid } from '@imajin/auth';
import type { ChargeRequest, Currency, Recipient } from '@/src/lib/pay';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { withLogger } from '@imajin/logger';
import { normalizeChargeRecipient } from '@/src/lib/pay/rail-alias';
import { enforceRoutePolicy } from '@imajin/auth/delegation-policy';

interface ChargeBody {
  amount: number;
  currency: Currency;
  to: Recipient;
  sellerDid?: string;
  description?: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
async function authenticateCharge(request: NextRequest, cors: Record<string, string>) {
  if (request.headers.get('x-app-did')) {
    const result = await requireAppAuth(request, { scope: 'wallet:write' });
    if ('error' in result) {
      return { denied: NextResponse.json({ error: result.error }, { status: result.status, headers: cors }) };
    }
    return { fromDid: result.appAuth.userDid, appDid: result.appAuth.appDid };
  }
  const result = await requireAuth(request);
  if ('error' in result) return {};
  const denied = enforceRoutePolicy(result.identity, 'pay.charge', { headers: cors });
  if (denied) return { denied };
  return { fromDid: resolveActingDid(result.identity) };
}

function isSellerDid(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('did:');
}

async function startSellerCharge(sellerDid: string, request: ChargeRequest, appDid?: string) {
  const keys = await resolveDidStripeKeys(sellerDid);
  if (!keys.publishableKey) throw new SellerNoCardRailError();
  const boundRequest = {
    ...request,
    metadata: {
      ...Object.fromEntries(Object.entries(request.metadata ?? {}).filter(([key]) => key !== 'appDid')),
      ...(appDid && { appDid }),
    },
  };
  const transactionId = await prepareSellerCharge(boundRequest, sellerDid, appDid);
  const result = await chargeSeller(keys.secretKey, sellerDid, boundRequest, transactionId);
  await persistSellerCharge(transactionId, result);
  return { result, publishableKey: keys.publishableKey };
}

export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);
  const rl = rateLimit(getClientIP(request), 10, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } },
    );
  }
  try {
    const body: ChargeBody = await request.json();
    
    // Validate required fields
    if (typeof body.amount !== 'number' || body.amount <= 0) {
      return NextResponse.json(
        { error: 'amount must be a positive number' },
        { status: 400, headers: cors }
      );
    }

    if (!body.currency) {
      return NextResponse.json(
        { error: 'currency is required' },
        { status: 400, headers: cors }
      );
    }

    if (!body.to) {
      return NextResponse.json(
        { error: 'to (recipient) is required' },
        { status: 400, headers: cors }
      );
    }
    
    // #2177: accept the rail-generic recipient ({ customerId, provider }) alongside
    // the original { stripeCustomerId } shape.
    const recipient = normalizeChargeRecipient(body.to as unknown as Record<string, unknown>);
    if (!recipient.ok) {
      return NextResponse.json(
        { error: recipient.error },
        { status: 400, headers: cors }
      );
    }

    // Anonymous charges remain supported; app requests must authenticate.
    const auth = await authenticateCharge(request, cors);
    if (auth.denied) return auth.denied;
    const fromDid = auth.fromDid;
    
    const chargeRequest: ChargeRequest = {
      amount: body.amount,
      currency: body.currency,
      to: recipient.to as unknown as Recipient,
      from: fromDid,
      description: body.description,
      metadata: body.metadata,
      idempotencyKey: body.idempotencyKey,
    };
    
    let result;
    let publishableKey: string | undefined;
    if (isCryptoCurrency(body.currency)) {
      result = await getCryptoOnlyProvider().charge(chargeRequest);
    } else {
      const sellerDid = recipient.to.did ?? body.sellerDid;
      if (!isSellerDid(sellerDid)) {
        return NextResponse.json(
          { error: 'to.did or sellerDid is required for card charges' },
          { status: 400, headers: cors }
        );
      }
      ({ result, publishableKey } = await startSellerCharge(sellerDid, chargeRequest, auth.appDid));
    }
    
    return NextResponse.json({
      id: result.id,
      provider: result.provider,
      status: result.status,
      amount: result.amount,
      currency: result.currency,
      fee: result.fee,
      clientSecret: result.clientSecret,
      publishableKey,
      signature: result.signature,
      createdAt: result.createdAt.toISOString(),
      metadata: result.metadata,
    }, { headers: cors });
  } catch (error) {
    if (error instanceof SellerChargeAlreadyAttemptedError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409, headers: cors });
    }
    if (error instanceof SellerNoCardRailError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400, headers: cors });
    }
    log.error({}, 'Charge error');
    return NextResponse.json(
      { error: 'Charge failed' },
      { status: 500, headers: cors }
    );
  }
});
