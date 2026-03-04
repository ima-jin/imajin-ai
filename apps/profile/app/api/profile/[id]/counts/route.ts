import { NextRequest } from 'next/server';
import { db, follows, connections, profiles } from '@/db';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq, or, count } from 'drizzle-orm';

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

    const [connectionsResult] = await db
      .select({ count: count() })
      .from(connections)
      .where(
        or(
          eq(connections.fromDid, profile.did),
          eq(connections.toDid, profile.did),
        )
      );

    return jsonResponse({
      followers: Number(followersResult.count),
      following: Number(followingResult.count),
      connections: Number(connectionsResult.count),
    });
  } catch (error) {
    console.error('Failed to fetch profile counts:', error);
    return errorResponse('Failed to fetch profile counts', 500);
  }
}
