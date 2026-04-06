import { NextRequest } from 'next/server';
import { db, follows } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse } from '@/src/lib/profile/utils';
import { eq, and } from 'drizzle-orm';

/**
 * GET /api/follow/status?did=xxx - Check if current user follows a DID
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  const { searchParams } = new URL(request.url);
  const did = searchParams.get('did');

  if (!did) {
    return errorResponse('Missing did query param');
  }

  try {
    const existing = await db.query.follows.findFirst({
      where: (follows, { eq, and }) =>
        and(
          eq(follows.followerDid, identity.id),
          eq(follows.followedDid, did),
        ),
    });

    return jsonResponse({ following: !!existing });
  } catch (error) {
    console.error('Failed to check follow status:', error);
    return errorResponse('Failed to check follow status', 500);
  }
}
