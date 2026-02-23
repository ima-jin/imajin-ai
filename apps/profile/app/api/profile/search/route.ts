import { NextRequest } from 'next/server';
import { db, profiles } from '@/db';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { ilike, eq, or, sql, type SQL } from 'drizzle-orm';

/**
 * GET /api/profile/search - Search profiles
 * 
 * Query params:
 * - q: search query (searches displayName and bio)
 * - type: filter by displayType (human, agent, presence)
 * - limit: max results (default 20, max 100)
 * - offset: pagination offset
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  
  const q = searchParams.get('q');
  const type = searchParams.get('type');
  const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 100);
  const offset = parseInt(searchParams.get('offset') || '0');

  try {
    // Build query conditions
    const conditions: SQL[] = [];

    if (q) {
      // Simple search on displayName and bio
      const searchCondition = or(
        ilike(profiles.displayName, `%${q}%`),
        ilike(profiles.bio, `%${q}%`)
      );
      if (searchCondition) conditions.push(searchCondition);
    }

    if (type) {
      if (!['human', 'agent', 'presence'].includes(type)) {
        return errorResponse('Invalid type filter');
      }
      conditions.push(eq(profiles.displayType, type));
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
    console.error('Failed to search profiles:', error);
    return errorResponse('Failed to search profiles', 500);
  }
}
