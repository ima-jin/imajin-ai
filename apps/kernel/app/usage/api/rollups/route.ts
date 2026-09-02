/**
 * GET /usage/api/rollups?did=&from=&to=
 *
 * Queryable read for #1148's clock-rollup: returns `usage.rollup`
 * attestations for a principal, newest first. `did` defaults to the caller's
 * own effective DID; when supplied explicitly it must match it — owner-only,
 * no agent-delegation path (unlike the pay/balance dashboards), since
 * usage-cost visibility isn't something this primitive extends to a
 * delegated agent yet.
 *
 * `from`/`to` (optional, ISO 8601) filter on `issuedAt` — the attestation's
 * own signing time, which for `usage.rollup` rows always falls right after
 * the cron's own window (see apps/kernel/src/lib/usage/rollup.ts), so this
 * is an honest proxy for "rollups covering windows in this range" without
 * needing to reach into each row's payload to filter.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, gte, isNull, lte } from 'drizzle-orm';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@imajin/config';
import { createLogger } from '@imajin/logger';
import { db, attestations } from '@/src/db';

const log = createLogger('kernel');
const LIMIT = 100;

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const effectiveDid = resolveActingDid(authResult.identity);

  const { searchParams } = new URL(request.url);
  const did = searchParams.get('did') ?? effectiveDid;

  if (did !== effectiveDid) {
    return NextResponse.json(
      { error: 'Forbidden - can only access your own usage rollups' },
      { status: 403, headers: cors },
    );
  }

  const conditions = [
    eq(attestations.type, 'usage.rollup'),
    eq(attestations.subjectDid, did),
    isNull(attestations.revokedAt),
  ];

  const fromParam = searchParams.get('from');
  if (fromParam) {
    const from = new Date(fromParam);
    if (Number.isNaN(from.getTime())) {
      return NextResponse.json({ error: 'from must be a valid ISO 8601 timestamp' }, { status: 400, headers: cors });
    }
    conditions.push(gte(attestations.issuedAt, from));
  }

  const toParam = searchParams.get('to');
  if (toParam) {
    const to = new Date(toParam);
    if (Number.isNaN(to.getTime())) {
      return NextResponse.json({ error: 'to must be a valid ISO 8601 timestamp' }, { status: 400, headers: cors });
    }
    conditions.push(lte(attestations.issuedAt, to));
  }

  try {
    const rows = await db
      .select()
      .from(attestations)
      .where(and(...conditions))
      .orderBy(desc(attestations.issuedAt))
      .limit(LIMIT);

    const rollups = rows.map((row) => {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        principalDid: row.subjectDid,
        issuerDid: row.issuerDid,
        windowStart: payload.windowStart ?? null,
        windowEnd: payload.windowEnd ?? null,
        totalCostEstimateUsd: payload.totalCostEstimateUsd ?? null,
        breakdown: payload.breakdown ?? [],
        issuedAt: row.issuedAt?.toISOString() ?? null,
      };
    });

    return NextResponse.json({ rollups }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Usage rollups fetch error');
    return NextResponse.json({ error: 'Failed to fetch usage rollups' }, { status: 500, headers: cors });
  }
}
