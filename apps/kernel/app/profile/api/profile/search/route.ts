import { NextRequest } from 'next/server';
import { db, profiles } from '@/src/db';
import { jsonResponse, errorResponse } from '@/src/lib/kernel/utils';
import { ilike, or, sql, type SQL } from 'drizzle-orm';
import { withLogger } from '@imajin/logger';

/**
 * GET /api/profile/search - Search profiles
 *
 * Query params:
 * - q: search query (searches displayName and handle)
 * - limit: max results (default 20, max 100)
 * - offset: pagination offset
 */
export const GET = withLogger('kernel', async (request: NextRequest, { log }) => {
  const searchParams = request.nextUrl.searchParams;

  const q = searchParams.get('q');
  const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 100);
  const offset = parseInt(searchParams.get('offset') || '0');

  try {
    // Build query conditions
    const conditions: SQL[] = [];

    if (q) {
      // Simple search on displayName and handle
      const searchCondition = or(
        ilike(profiles.handle, `%${q}%`),
        ilike(profiles.displayName, `%${q}%`),
      );
      if (searchCondition) conditions.push(searchCondition);
    }

    // Execute query
    const results = await db.query.profiles.findMany({
      where: conditions.length > 0 
        ? (profiles, { and }) => and(...conditions) 
        : undefined,
      limit,
      offset,
      orderBy: (profiles, { desc }) => [desc(profiles.createdAt)],
    });

    // Get total count for pagination
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(profiles);
    
    const total = Number(countResult[0]?.count || 0);

    return jsonResponse({
      profiles: results,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + results.length < total,
      },
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to search profiles');
    return errorResponse('Failed to search profiles', 500);
  }
});
