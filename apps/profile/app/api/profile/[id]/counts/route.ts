import { NextRequest } from 'next/server';
import { db, follows, profiles } from '@/db';
import { getClient } from '@imajin/db';
import { jsonResponse, errorResponse } from '@/lib/utils';
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

    // Query connections from connections schema (pod-based model)
    // A connection = being in the same pod as someone else
    // Only count members from 2-person pods (actual connections, not event/group pods)
    const sql = getClient();
    const [connectionsResult] = await sql`
      SELECT COUNT(DISTINCT pm2.did)::int as count
      FROM connections.pod_members pm1
      JOIN connections.pod_members pm2 ON pm1.pod_id = pm2.pod_id AND pm1.did != pm2.did
      WHERE pm1.did = ${profile.did}
        AND pm1.removed_at IS NULL
        AND pm2.removed_at IS NULL
        AND pm1.pod_id IN (
          SELECT pod_id FROM connections.pod_members
          WHERE removed_at IS NULL
          GROUP BY pod_id
          HAVING count(*) = 2
        )
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
