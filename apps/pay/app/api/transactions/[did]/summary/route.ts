/**
 * GET /api/transactions/[did]/summary
 *
 * Aggregated transaction summary for a DID.
 * Returns earned/spent breakdown by service.
 * Auth: must be authenticated as the same DID.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, transactions } from '@/src/db';
import { eq, and, sql, or } from 'drizzle-orm';
import { extractToken, validateToken } from '@/lib/auth';
import { corsHeaders } from '@/src/lib/cors';

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

    // Auth: must be the DID owner
    const token = extractToken(request.headers.get('authorization'));
    if (!token) {
      return NextResponse.json(
        { error: 'Unauthorized - no token provided' },
        { status: 401, headers: cors }
      );
    }

    const validation = await validateToken(token);
    if (!validation.valid || !validation.identity) {
      return NextResponse.json(
        { error: 'Unauthorized - invalid token' },
        { status: 401, headers: cors }
      );
    }

    if (validation.identity.id !== did) {
      return NextResponse.json(
        { error: 'Forbidden - can only access your own summary' },
        { status: 403, headers: cors }
      );
    }

    // Aggregate earned (where to_did = did)
    const earnedResults = await db
      .select({
        service: transactions.service,
        total: sql<string>`SUM(CAST(${transactions.amount} AS NUMERIC))`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.toDid, did),
          eq(transactions.status, 'completed')
        )
      )
      .groupBy(transactions.service);

    // Aggregate spent (where from_did = did)
    const spentResults = await db
      .select({
        service: transactions.service,
        total: sql<string>`SUM(CAST(${transactions.amount} AS NUMERIC))`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.fromDid, did),
          eq(transactions.status, 'completed')
        )
      )
      .groupBy(transactions.service);

    // Build service breakdown
    const services: Record<string, { earned: number; spent: number; count: number }> = {};

    for (const row of earnedResults) {
      if (!services[row.service]) {
        services[row.service] = { earned: 0, spent: 0, count: 0 };
      }
      services[row.service].earned = parseFloat(row.total);
      services[row.service].count += row.count;
    }

    for (const row of spentResults) {
      if (!services[row.service]) {
        services[row.service] = { earned: 0, spent: 0, count: 0 };
      }
      services[row.service].spent = parseFloat(row.total);
      services[row.service].count += row.count;
    }

    // Calculate totals
    let totalEarned = 0;
    let totalSpent = 0;

    for (const service of Object.values(services)) {
      totalEarned += service.earned;
      totalSpent += service.spent;
    }

    return NextResponse.json(
      {
        services,
        total: {
          earned: totalEarned,
          spent: totalSpent,
          net: totalEarned - totalSpent,
        },
      },
      { headers: cors }
    );
  } catch (error) {
    console.error('Summary fetch error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch summary' },
      { status: 500, headers: cors }
    );
  }
}
