import { NextRequest } from 'next/server';
import { db, listings } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq, and, desc, asc, sql } from 'drizzle-orm';

/**
 * GET /api/my/listings — Seller's own listings
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const sort = searchParams.get('sort') || 'newest';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)));
    const offset = (page - 1) * limit;

    const conditions = [eq(listings.sellerDid, identity.id)];

    if (status) {
      conditions.push(eq(listings.status, status));
    }

    const whereClause = and(...conditions);

    let orderBy;
    if (sort === 'price_asc') {
      orderBy = asc(listings.price);
    } else if (sort === 'price_desc') {
      orderBy = desc(listings.price);
    } else {
      orderBy = desc(listings.createdAt);
    }

    const [rows, countResult] = await Promise.all([
      db.select().from(listings).where(whereClause).orderBy(orderBy).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(listings).where(whereClause),
    ]);

    const total = Number(countResult[0]?.count ?? 0);

    return jsonResponse({
      listings: rows,
      total,
      page,
      limit,
      hasMore: offset + rows.length < total,
    });
  } catch (error) {
    console.error('Failed to fetch listings:', error);
    return errorResponse('Failed to fetch listings', 500);
  }
}
