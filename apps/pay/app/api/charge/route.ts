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
 *   to: { stripeCustomerId?: string, solanaAddress?: string, did?: string },
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
 *   clientSecret?: string,   // Stripe - for frontend confirmation
 *   signature?: string,      // Solana - if already signed
 *   metadata?: object
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getPaymentService } from '@/lib/pay';
import { extractToken, validateToken } from '@/lib/auth';
import type { ChargeRequest, Currency, Recipient } from '@/lib';

interface ChargeBody {
  amount: number;
  currency: Currency;
  to: Recipient;
  description?: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body: ChargeBody = await request.json();
    
    // Validate required fields
    if (typeof body.amount !== 'number' || body.amount <= 0) {
      return NextResponse.json(
        { error: 'amount must be a positive number' },
        { status: 400 }
      );
    }
    
    if (!body.currency) {
      return NextResponse.json(
        { error: 'currency is required' },
        { status: 400 }
      );
    }
    
    if (!body.to) {
      return NextResponse.json(
        { error: 'to (recipient) is required' },
        { status: 400 }
      );
    }
    
    // Optional: validate auth token if provided
    const token = extractToken(request.headers.get('authorization'));
    let fromDid: string | undefined;
    if (token) {
      const validation = await validateToken(token);
      if (validation.valid && validation.identity) {
        fromDid = validation.identity.id;
      }
    }
    
    const pay = getPaymentService();
    
    const chargeRequest: ChargeRequest = {
      amount: body.amount,
      currency: body.currency,
      to: body.to,
      from: fromDid,
      description: body.description,
      metadata: body.metadata,
      idempotencyKey: body.idempotencyKey,
    };
    
    const result = await pay.charge(chargeRequest);
    
    return NextResponse.json({
      id: result.id,
      provider: result.provider,
      status: result.status,
      amount: result.amount,
      currency: result.currency,
      fee: result.fee,
      clientSecret: result.clientSecret,
      signature: result.signature,
      createdAt: result.createdAt.toISOString(),
      metadata: result.metadata,
    });
  } catch (error) {
    console.error('Charge error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Charge failed' },
      { status: 500 }
    );
  }
}
