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
import { requireAuth } from '@imajin/auth';
import type { CheckoutRequest, FiatCurrency } from '@/src/lib/pay';
import { DEFAULT_PLATFORM_FEE_BPS } from '@/src/lib/pay';
import { STRIPE_RATE_BPS, STRIPE_FIXED_CENTS } from '@imajin/fair';
import { db, transactions, connectedAccounts } from '@/src/db';
import { eq } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { rateLimit, getClientIP } from '@/src/lib/kernel/rate-limit';
import { withLogger } from '@imajin/logger';

interface CheckoutBody {
  items: Array<{
    name: string;
    description?: string;
    amount: number;
    quantity: number;
    image?: string;
  }>;
  currency: FiatCurrency;
  mode?: 'payment' | 'subscription';
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
  fairManifest?: Record<string, any>;
  connectedAccountId?: string;
  sellerDid?: string;
}

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

    // Validate required fields
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      return NextResponse.json(
        { error: 'items array is required' },
        { status: 400, headers: cors }
      );
    }

    if (!body.successUrl || !body.cancelUrl) {
      return NextResponse.json(
        { error: 'successUrl and cancelUrl are required' },
        { status: 400, headers: cors }
      );
    }

    // Validate each item's amount and quantity
    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i];
      if (!Number.isInteger(item.amount) || item.amount <= 0) {
        return NextResponse.json(
          { error: `items[${i}].amount must be a positive integer` },
          { status: 400, headers: cors }
        );
      }
      if (item.amount < 50) {
        return NextResponse.json(
          { error: `items[${i}].amount must be >= 50 (Stripe minimum is 50 cents)` },
          { status: 400, headers: cors }
        );
      }
      if (item.amount > 99_999_900) {
        return NextResponse.json(
          { error: `items[${i}].amount must be < $1,000,000` },
          { status: 400, headers: cors }
        );
      }
      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        return NextResponse.json(
          { error: `items[${i}].quantity must be a positive integer >= 1` },
          { status: 400, headers: cors }
        );
      }
      if (item.quantity > 100) {
        return NextResponse.json(
          { error: `items[${i}].quantity must be <= 100` },
          { status: 400, headers: cors }
        );
      }
    }

    // Optional: capture identity if authenticated
    let identity: { id: string; actingAs?: string } | null = null;
    const authResult = await requireAuth(request);
    if (!('error' in authResult)) {
      identity = authResult.identity;
    }
    
    const pay = getPaymentService();

    // Resolve connected account from sellerDid if provided
    const sellerDid = body.sellerDid || body.metadata?.sellerDid;
    let resolvedConnectedAccountId = body.connectedAccountId;
    let applicationFeeAmount: number | undefined;

    if (sellerDid) {
      const [account] = await db
        .select()
        .from(connectedAccounts)
        .where(eq(connectedAccounts.did, sellerDid))
        .limit(1);

      if (account) {
        if (!account.chargesEnabled) {
          return NextResponse.json(
            { error: "Seller hasn't completed payment setup" },
            { status: 400, headers: cors }
          );
        }
        resolvedConnectedAccountId = account.stripeAccountId;
        const totalAmount = body.items.reduce((sum, item) => sum + (item.amount * item.quantity), 0);

        // Calculate application fee: platform shares + processing fees
        // Stripe processing fees are deducted from the application fee,
        // so we must collect enough to cover them plus our platform margin.

        // 1. Platform share (from .fair manifest or fallback rate)
        let platformShareCents: number;
        if (body.fairManifest?.chain) {
          const sellerEntry = body.fairManifest.chain.find((e: any) => e.role === 'seller');
          const feeShare = sellerEntry ? 1 - sellerEntry.share : 0;
          platformShareCents = Math.round(totalAmount * feeShare);
        } else {
          platformShareCents = Math.round(totalAmount * (account.platformFeeBps || DEFAULT_PLATFORM_FEE_BPS) / 10000);
        }

        // 2. Processing fees (from .fair manifest fees array or Stripe defaults)
        let processingFeeCents: number;
        const feeEntry = body.fairManifest?.fees?.find((f: any) => f.role === 'processor');
        if (feeEntry) {
          processingFeeCents = Math.round(totalAmount * feeEntry.rateBps / 10000) + (feeEntry.fixedCents || 0);
        } else {
          processingFeeCents = Math.round(totalAmount * STRIPE_RATE_BPS / 10000) + STRIPE_FIXED_CENTS;
        }

        applicationFeeAmount = platformShareCents + processingFeeCents;
      } else {
        return NextResponse.json(
          { error: "Seller hasn't completed payment setup", code: "SELLER_NOT_CONNECTED" },
          { status: 400, headers: cors }
        );
      }
    }

    const checkoutRequest: CheckoutRequest = {
      items: body.items,
      currency: body.currency || 'USD',
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
      fromDid: (identity?.actingAs || identity?.id) || null,
      toDid: body.metadata?.to_did || body.metadata?.recipient_did || 'platform',
      amount: (totalAmount / 100).toString(), // Convert cents to dollars
      currency: body.currency || 'USD',
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
