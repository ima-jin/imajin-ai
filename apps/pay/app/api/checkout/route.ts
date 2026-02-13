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
import type { CheckoutRequest, FiatCurrency } from '@imajin/pay';

interface CheckoutBody {
  items: Array<{
    name: string;
    description?: string;
    amount: number;
    quantity: number;
    image?: string;
  }>;
  currency: FiatCurrency;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
}

export async function POST(request: NextRequest) {
  try {
    const body: CheckoutBody = await request.json();
    
    // Validate required fields
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      return NextResponse.json(
        { error: 'items array is required' },
        { status: 400 }
      );
    }
    
    if (!body.successUrl || !body.cancelUrl) {
      return NextResponse.json(
        { error: 'successUrl and cancelUrl are required' },
        { status: 400 }
      );
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
      customerEmail: body.customerEmail,
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      metadata: {
        ...body.metadata,
        // Add identity if authenticated
        ...(identity && { identity_id: identity.id }),
      },
    };
    
    const result = await pay.checkout(checkoutRequest);
    
    return NextResponse.json({
      id: result.id,
      url: result.url,
      expiresAt: result.expiresAt.toISOString(),
    });
  } catch (error) {
    console.error('Checkout error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Checkout failed' },
      { status: 500 }
    );
  }
}
