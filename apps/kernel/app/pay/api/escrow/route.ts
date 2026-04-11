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
import { getPaymentService } from '@/src/lib/pay/pay';
import { requireAuth } from '@imajin/auth';
import type { EscrowRequest, Currency } from '@/src/lib/pay';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { withLogger } from '@imajin/logger';

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

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);
  try {
    const body: EscrowBody = await request.json();
    
    // Validate required fields
    if (typeof body.amount !== 'number' || body.amount <= 0) {
      return NextResponse.json(
        { error: 'amount must be a positive number' },
        { status: 400, headers: cors }
      );
    }

    if (!body.from || !body.to) {
      return NextResponse.json(
        { error: 'from and to DIDs are required' },
        { status: 400, headers: cors }
      );
    }

    // Require authentication for escrow
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status, headers: cors }
      );
    }

    // Verify the authenticated user is the depositor
    if (authResult.identity.id !== body.from) {
      return NextResponse.json(
        { error: 'Authenticated identity must match depositor (from)' },
        { status: 403, headers: cors }
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
    }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Escrow error');
    return NextResponse.json(
      { error: 'Escrow operation failed' },
      { status: 500, headers: cors }
    );
  }
});

/**
 * POST /api/escrow/release
 * Release funds from escrow to recipient
 */
export const PUT = withLogger('kernel', async (request: NextRequest, { log }) => {
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
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status }
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
    log.error({ err: String(error) }, 'Escrow release error');
    return NextResponse.json(
      { error: 'Escrow operation failed' },
      { status: 500 }
    );
  }
});
