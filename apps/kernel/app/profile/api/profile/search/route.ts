import { NextRequest } from 'next/server';
import { db, profiles } from '@/src/db';
import { jsonResponse, errorResponse } from '@/src/lib/kernel/utils';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { ilike, or, sql, type SQL } from 'drizzle-orm';
import { withLogger } from '@imajin/logger';
import { requireAppAuth } from '@imajin/auth';

/** Fields safe to return for profile:read app scope */
function filterProfileForApp(profile: Record<string, any>): Record<string, any> {
  const { did, displayName, handle, avatar, bio, visibility, scope, subtype } = profile;
  return { did, displayName, handle, avatar, bio, visibility, scope, subtype };
}

/**
 * GET /api/profile/search - Search profiles
 *
 * Query params:
 * - q: search query (searches displayName and handle)
 * - limit: max results (default 20, max 100)
 * - offset: pagination offset
 */
export const GET = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  // App auth path — validate and return filtered results
  const isAppRequest = !!request.headers.get('x-app-did');
  if (isAppRequest) {
    const appResult = await requireAppAuth(request, { scope: 'profile:read' });
    if ('error' in appResult) {
      return errorResponse(appResult.error, appResult.status, cors);
    }
  }

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

    const profileData = isAppRequest
      ? results.map(p => filterProfileForApp(p as Record<string, any>))
      : results;

    return jsonResponse({
      profiles: profileData,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + results.length < total,
      },
    }, 200, isAppRequest ? cors : undefined);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to search profiles');
    return errorResponse('Failed to search profiles', 500);
  }
});
