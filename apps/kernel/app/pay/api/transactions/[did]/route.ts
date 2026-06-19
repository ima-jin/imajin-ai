/**
 * GET /api/transactions/[did]
 *
 * List transactions for a DID.
 * Query params: ?service=coffee&type=tip&limit=50&offset=0
 * Auth: must be authenticated as the same DID.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, transactions } from '@/src/db';
import { eq, and, desc, or } from 'drizzle-orm';
import { requireAuth, requireAppAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(
  request: NextRequest,
  { params }: { params: { did: string } }
) {
  const cors = corsHeaders(request);

  try {
    const { did } = params;

    let effectiveDid: string;
    let isAgentDelegated = false;

    // App auth path
    if (request.headers.get('x-app-did')) {
      const appResult = await requireAppAuth(request, { scope: 'wallet:read' });
      if ('error' in appResult) {
        return NextResponse.json(
          { error: appResult.error },
          { status: appResult.status, headers: cors }
        );
      }
      effectiveDid = appResult.appAuth.userDid;
    } else {
      const authResult = await requireAuth(request);
      if ('error' in authResult) {
        return NextResponse.json(
          { error: 'Unauthorized' },
          { status: 401, headers: cors }
        );
      }
      effectiveDid = resolveActingDid(authResult.identity);
      isAgentDelegated =
        authResult.identity.actingAs === did &&
        authResult.identity.actingAsRole === 'agent';
    }

    if (effectiveDid !== did && !isAgentDelegated) {
      return NextResponse.json(
        { error: 'Forbidden - can only access your own transactions' },
        { status: 403, headers: cors }
      );
    }

    // Parse query params
    const url = new URL(request.url);
    const service = url.searchParams.get('service');
    const type = url.searchParams.get('type');
    const limit = Math.min(Number.parseInt(url.searchParams.get('limit') || '50'), 100);
    const offset = Number.parseInt(url.searchParams.get('offset') || '0');

    // Build query
    const conditions = [
      or(
        eq(transactions.fromDid, did),
        eq(transactions.toDid, did)
      )!
    ];

    if (service) {
      conditions.push(eq(transactions.service, service));
    }

    if (type) {
      conditions.push(eq(transactions.type, type));
    }

    const results = await db
      .select()
      .from(transactions)
      .where(and(...conditions))
      .orderBy(desc(transactions.createdAt))
      .limit(limit)
      .offset(offset);

    // Format results
    const formatted = results.map(tx => ({
      id: tx.id,
      service: tx.service,
      type: tx.type,
      from_did: tx.fromDid,
      to_did: tx.toDid,
      amount: Number.parseFloat(tx.amount),
      currency: tx.currency,
      status: tx.status,
      stripe_id: tx.stripeId,
      metadata: tx.metadata,
      fair_manifest: tx.fairManifest,
      batch_id: tx.batchId,
      created_at: tx.createdAt?.toISOString(),
    }));

    return NextResponse.json(
      {
        transactions: formatted,
        limit,
        offset,
        count: formatted.length,
      },
      { headers: cors }
    );
  } catch (error) {
    log.error({ err: String(error) }, 'Transactions fetch error');
    return NextResponse.json(
      { error: 'Failed to fetch transactions' },
      { status: 500, headers: cors }
    );
  }
}
