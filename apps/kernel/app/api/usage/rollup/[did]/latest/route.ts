/**
 * GET /api/usage/rollup/{did}/latest (#2030)
 *
 * PUBLIC, unauthenticated — the README's link target (#2028). Returns the
 * most recent signed `usage.rollup` attestation for the DID exactly as
 * stored (id, window, totals, signature, issuer, signed-at); never
 * recomputed. Optional `?window=YYYY-MM-DD` fetches the rollup for that
 * specific UTC day (matching `lib/usage/rollup.ts`'s own `contextIdFor`
 * idempotency key) instead of the newest one.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { db, attestations } from '@/src/db';
import { contextIdFor } from '@/src/lib/usage/rollup';

const log = createLogger('kernel');

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ did: string }> }) {
  const cors = corsHeaders(request);
  const { did: rawDid } = await params;
  const did = decodeURIComponent(rawDid);

  const conditions = [
    eq(attestations.type, 'usage.rollup'),
    eq(attestations.subjectDid, did),
    isNull(attestations.revokedAt),
  ];

  const windowParam = new URL(request.url).searchParams.get('window');
  if (windowParam) {
    const windowStart = new Date(`${windowParam}T00:00:00.000Z`);
    if (Number.isNaN(windowStart.getTime())) {
      return NextResponse.json({ error: 'window must be a YYYY-MM-DD date' }, { status: 400, headers: cors });
    }
    conditions.push(eq(attestations.contextId, contextIdFor(did, windowStart)));
  }

  try {
    const [row] = await db
      .select()
      .from(attestations)
      .where(and(...conditions))
      .orderBy(desc(attestations.issuedAt))
      .limit(1);

    if (!row) {
      return NextResponse.json({ error: 'No usage.rollup attestation found for this DID' }, { status: 404, headers: cors });
    }

    const payload = (row.payload ?? {}) as Record<string, unknown>;
    return NextResponse.json(
      {
        id: row.id,
        issuerDid: row.issuerDid,
        subjectDid: row.subjectDid,
        windowStart: payload.windowStart ?? null,
        windowEnd: payload.windowEnd ?? null,
        totalCostEstimateUsd: payload.totalCostEstimateUsd ?? null,
        breakdown: payload.breakdown ?? [],
        signature: row.signature,
        signedAt: row.issuedAt?.toISOString() ?? null,
      },
      { headers: { ...cors, 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    log.error({ err: String(err), did }, 'public usage rollup fetch failed');
    return NextResponse.json({ error: 'Failed to fetch usage rollup' }, { status: 500, headers: cors });
  }
}
