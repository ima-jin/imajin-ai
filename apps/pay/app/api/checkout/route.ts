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
import { getPaymentService } from '@/lib/pay';
import { extractToken, validateToken } from '@/lib/auth';
import type { CheckoutRequest, FiatCurrency } from '@/lib';
import { db, transactions } from '@/src/db';
import { genId } from '@/src/lib/id';
import { corsHeaders } from '@/src/lib/cors';
import { rateLimit, getClientIP } from '@/src/lib/rate-limit';

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
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: NextRequest) {
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

    // Optional: validate auth token if provided
    const token = extractToken(request.headers.get('authorization'));
    let identity = null;
    if (token) {
      const validation = await validateToken(token);
      if (validation.valid) {
        identity = validation.identity;
      }
    }
    
    const pay = getPaymentService();
    
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
      connectedAccountId: body.connectedAccountId,
    };
    
    const result = await pay.checkout(checkoutRequest);

    // Create a pending transaction
    const totalAmount = body.items.reduce((sum, item) => sum + (item.amount * item.quantity), 0);
    const txId = genId('tx');

    await db.insert(transactions).values({
      id: txId,
      service: body.metadata?.service || 'unknown',
      type: body.metadata?.type || 'checkout',
      fromDid: identity?.id || null,
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
    console.error('Checkout error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Checkout failed' },
      { status: 500, headers: cors }
    );
  }
}
