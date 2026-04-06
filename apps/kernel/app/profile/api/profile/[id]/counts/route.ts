import { NextRequest } from 'next/server';
import { db, follows, profiles } from '@/src/db';
import { getClient } from '@imajin/db';
import { jsonResponse, errorResponse } from '@/src/lib/kernel/utils';
import { eq, count } from 'drizzle-orm';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/profile/:id/counts - Get follower/following/connection counts
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;

  try {
    const profile = await db.query.profiles.findFirst({
      where: (profiles, { eq, or }) =>
        or(eq(profiles.did, id), eq(profiles.handle, id)),
    });

    if (!profile) {
      return errorResponse('Profile not found', 404);
    }

    const [followersResult] = await db
      .select({ count: count() })
      .from(follows)
      .where(eq(follows.followedDid, profile.did));

    const [followingResult] = await db
      .select({ count: count() })
      .from(follows)
      .where(eq(follows.followerDid, profile.did));

    const sql = getClient();
    const [connectionsResult] = await sql`
      SELECT count(*)::int as count
      FROM connections.connections
      WHERE (did_a = ${profile.did} OR did_b = ${profile.did})
        AND disconnected_at IS NULL
    `;

    return jsonResponse({
      followers: Number(followersResult.count),
      following: Number(followingResult.count),
      connections: connectionsResult?.count ?? 0,
    });
  } catch (error) {
    console.error('Failed to fetch profile counts:', error);
    return errorResponse('Failed to fetch profile counts', 500);
  }
}
