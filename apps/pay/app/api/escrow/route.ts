/**
 * POST /api/escrow
 * 
 * Create an escrow (hold funds until released).
 * 
 * Request:
 * {
 *   amount: number,
 *   currency: string,
 *   from: string,           // DID of depositor (required)
 *   to: string,             // DID of recipient (required)
 *   arbiter?: string,       // DID of dispute resolver
 *   conditions?: {
 *     releaseAfter?: string,      // ISO date for auto-release
 *     requireSignatures?: string[] // DIDs that must sign
 *   },
 *   metadata?: Record<string, string>
 * }
 * 
 * Response:
 * {
 *   id: string,
 *   provider: "stripe" | "solana",
 *   status: "held",
 *   amount: number,
 *   currency: string,
 *   from: string,
 *   to: string,
 *   createdAt: string
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getPaymentService } from '@/lib/pay';
import { extractToken, validateToken } from '@/lib/auth';
import type { EscrowRequest, Currency } from '@imajin/pay';

interface EscrowBody {
  amount: number;
  currency: Currency;
  from: string;
  to: string;
  arbiter?: string;
  conditions?: {
    releaseAfter?: string;
    requireSignatures?: string[];
  };
  metadata?: Record<string, string>;
}

export async function POST(request: NextRequest) {
  try {
    const body: EscrowBody = await request.json();
    
    // Validate required fields
    if (typeof body.amount !== 'number' || body.amount <= 0) {
      return NextResponse.json(
        { error: 'amount must be a positive number' },
        { status: 400 }
      );
    }
    
    if (!body.from || !body.to) {
      return NextResponse.json(
        { error: 'from and to DIDs are required' },
        { status: 400 }
      );
    }
    
    // Require authentication for escrow
    const token = extractToken(request.headers.get('authorization'));
    if (!token) {
      return NextResponse.json(
        { error: 'Authentication required for escrow' },
        { status: 401 }
      );
    }
    
    const validation = await validateToken(token);
    if (!validation.valid) {
      return NextResponse.json(
        { error: 'Invalid token' },
        { status: 401 }
      );
    }
    
    // Verify the authenticated user is the depositor
    if (validation.identity?.id !== body.from) {
      return NextResponse.json(
        { error: 'Authenticated identity must match depositor (from)' },
        { status: 403 }
      );
    }
    
    const pay = getPaymentService();
    
    const escrowRequest: EscrowRequest = {
      amount: body.amount,
      currency: body.currency || 'USD',
      from: body.from,
      to: body.to,
      arbiter: body.arbiter,
      conditions: body.conditions ? {
        releaseAfter: body.conditions.releaseAfter 
          ? new Date(body.conditions.releaseAfter) 
          : undefined,
        requireSignatures: body.conditions.requireSignatures,
      } : undefined,
      metadata: body.metadata,
    };
    
    const result = await pay.escrow(escrowRequest);
    
    return NextResponse.json({
      id: result.id,
      provider: result.provider,
      status: result.status,
      amount: result.amount,
      currency: result.currency,
      from: result.from,
      to: result.to,
      createdAt: result.createdAt.toISOString(),
      expiresAt: result.expiresAt?.toISOString(),
    });
  } catch (error) {
    console.error('Escrow error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Escrow creation failed' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/escrow/release
 * Release funds from escrow to recipient
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { escrowId, provider, action } = body;
    
    if (!escrowId || !provider) {
      return NextResponse.json(
        { error: 'escrowId and provider are required' },
        { status: 400 }
      );
    }
    
    // Require authentication
    const token = extractToken(request.headers.get('authorization'));
    if (!token) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }
    
    const validation = await validateToken(token);
    if (!validation.valid) {
      return NextResponse.json(
        { error: 'Invalid token' },
        { status: 401 }
      );
    }
    
    const pay = getPaymentService();
    
    let result;
    if (action === 'refund') {
      result = await pay.refundEscrow(escrowId, provider);
    } else {
      result = await pay.releaseEscrow(escrowId, provider);
    }
    
    return NextResponse.json({
      id: result.id,
      provider: result.provider,
      status: result.status,
      amount: result.amount,
      currency: result.currency,
      from: result.from,
      to: result.to,
      createdAt: result.createdAt.toISOString(),
    });
  } catch (error) {
    console.error('Escrow release error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Escrow operation failed' },
      { status: 500 }
    );
  }
}
