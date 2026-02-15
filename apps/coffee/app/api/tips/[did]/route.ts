import { NextRequest } from 'next/server';
import { db, coffeePages, tips } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq, desc, sql } from 'drizzle-orm';

interface RouteParams {
  params: { did: string };
}

/**
 * GET /api/tips/:did - Get tips received by a DID (owner only)
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { did } = params;

  // Require authentication
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  // Check ownership
  if (identity.id !== did) {
    return errorResponse('Not authorized to view these tips', 403);
  }

  try {
    // Get user's coffee page
    const page = await db.query.coffeePages.findFirst({
      where: (pages, { eq }) => eq(pages.did, did),
    });

    if (!page) {
      return errorResponse('No coffee page found for this DID', 404);
    }

    const searchParams = request.nextUrl.searchParams;
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100);
    const offset = parseInt(searchParams.get('offset') || '0');
    const status = searchParams.get('status'); // filter by status

    // Get tips
    const tipsList = await db.query.tips.findMany({
      where: (tips, { eq, and }) => {
        const conditions = [eq(tips.pageId, page.id)];
        if (status) {
          conditions.push(eq(tips.status, status));
        }
        return and(...conditions);
      },
      limit,
      offset,
      orderBy: (tips, { desc }) => [desc(tips.createdAt)],
    });

    // Get totals by currency
    const totals = await db
      .select({
        currency: tips.currency,
        total: sql<number>`sum(${tips.amount})`,
        count: sql<number>`count(*)`,
      })
      .from(tips)
      .where(eq(tips.pageId, page.id))
      .groupBy(tips.currency);

    return jsonResponse({
      tips: tipsList,
      totals: totals.reduce((acc, t) => {
        acc[t.currency] = { total: Number(t.total), count: Number(t.count) };
        return acc;
      }, {} as Record<string, { total: number; count: number }>),
      pagination: {
        limit,
        offset,
      },
    });
  } catch (error) {
    console.error('Failed to fetch tips:', error);
    return errorResponse('Failed to fetch tips', 500);
  }
}
