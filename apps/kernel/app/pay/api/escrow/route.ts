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
import { resolveDidStripeKeys, SellerNoCardRailError } from '@/src/lib/pay/rails/stripe-keys';
import { escrowSeller, updateSellerEscrow } from '@/src/lib/pay/providers/seller-stripe-payments';
import { findSellerEscrow, markSellerEscrow, persistSellerEscrow } from '@/src/lib/pay/providers/seller-transactions';
import { getCryptoOnlyProvider } from '@/src/lib/pay/providers/crypto-only';
import { isCryptoCurrency } from '@/src/lib/pay/types';
import { requireAuth, requireAppAuth, resolveActingDid, resolveEffectiveDid } from '@imajin/auth';
import type { EscrowRequest, Currency } from '@/src/lib/pay';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { withLogger } from '@imajin/logger';
import { enforceRoutePolicy } from '@imajin/auth/delegation-policy';

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

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
async function authenticateEscrowUpdate(request: NextRequest) {
  if (request.headers.get('x-app-did')) {
    const result = await requireAppAuth(request, { scope: 'wallet:write' });
    if ('error' in result) {
      return { denied: NextResponse.json({ error: result.error }, { status: result.status }) };
    }
    return { actingDid: result.appAuth.userDid };
  }
  const result = await requireAuth(request);
  if ('error' in result) {
    return { denied: NextResponse.json({ error: result.error }, { status: result.status }) };
  }
  const denied = enforceRoutePolicy(result.identity, 'pay.escrow.update');
  if (denied) return { denied };
  return { actingDid: resolveActingDid(result.identity) };
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

    const auth = await resolveEffectiveDid(request, { scope: 'wallet:write' });
    if (!auth.ok) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.status, headers: cors }
      );
    }
    const depositorDid = auth.effectiveDid;
    const delegationDenied = enforceRoutePolicy(auth, 'pay.escrow.create', { headers: cors });
    if (delegationDenied) return delegationDenied;

    // Verify the authenticated user is the depositor
    if (depositorDid !== body.from) {
      return NextResponse.json(
        { error: 'Authenticated identity must match depositor (from)' },
        { status: 403, headers: cors }
      );
    }
    
    const escrowRequest: EscrowRequest = {
      amount: body.amount,
      currency: body.currency || 'CAD',
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
    
    let result;
    let publishableKey: string | undefined;
    let clientSecret: string | undefined;
    if (isCryptoCurrency(escrowRequest.currency)) {
      result = await getCryptoOnlyProvider().escrow(escrowRequest);
    } else {
      const keys = await resolveDidStripeKeys(body.to);
      if (!keys.publishableKey) throw new SellerNoCardRailError();
      publishableKey = keys.publishableKey;
      result = await escrowSeller(keys.secretKey, escrowRequest);
      clientSecret = result.clientSecret;
      await persistSellerEscrow(result, escrowRequest);
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
      expiresAt: result.expiresAt?.toISOString(),
      clientSecret,
      publishableKey,
    }, { headers: cors });
  } catch (error) {
    if (error instanceof SellerNoCardRailError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400, headers: cors });
    }
    log.error({}, 'Escrow error');
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
    
    const auth = await authenticateEscrowUpdate(request);
    if (auth.denied) return auth.denied;
    const actingDid = auth.actingDid;

    if (provider !== 'stripe') {
      return NextResponse.json({ error: 'Escrow release/refund not supported by this provider' }, { status: 400 });
    }
    const transaction = await findSellerEscrow(escrowId);
    if (transaction?.rail !== 'stripe-byo' || !transaction.toDid) {
      log.error({}, 'Legacy or unowned escrow cannot be released/refunded; platform fallback is disabled');
      return NextResponse.json({ error: 'Escrow has no seller-owned card rail', code: 'LEGACY_ESCROW_UNSUPPORTED' }, { status: 422 });
    }
    const metadata = transaction.metadata as Record<string, unknown> | null;
    if (![transaction.fromDid, transaction.toDid, metadata?.arbiter_did].includes(actingDid)) {
      return NextResponse.json({ error: 'Forbidden - identity is not an escrow party' }, { status: 403 });
    }
    const keys = await resolveDidStripeKeys(transaction.toDid);
    const result = await updateSellerEscrow(keys.secretKey, escrowId, action === 'refund' ? 'refund' : 'release');
    await markSellerEscrow(transaction.id, result.status === 'refunded' ? 'refunded' : 'released');
    
    return NextResponse.json({
      id: result.id,
      provider: result.provider,
      status: result.status,
      amount: result.amount,
      currency: result.currency,
      from: transaction.fromDid,
      to: transaction.toDid,
      createdAt: result.createdAt.toISOString(),
    });
  } catch (error) {
    if (error instanceof SellerNoCardRailError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    log.error({}, 'Escrow release error');
    return NextResponse.json(
      { error: 'Escrow operation failed' },
      { status: 500 }
    );
  }
});
