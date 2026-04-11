import { NextRequest } from 'next/server';
import { db, follows } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { generateId, jsonResponse, errorResponse } from '@/src/lib/kernel/utils';
import { eq, and } from 'drizzle-orm';
import { withLogger } from '@imajin/logger';

/**
 * POST /api/follow - Follow a DID
 */
export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const body = await request.json();
    const { did } = body;

    if (!did) {
      return errorResponse('Missing did');
    }

    if (did === identity.id) {
      return errorResponse('Cannot follow yourself');
    }

    await db.insert(follows).values({
      id: generateId('follow'),
      followerDid: identity.id,
      followedDid: did,
    }).onConflictDoNothing();

    return jsonResponse({ followed: true });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to follow');
    return errorResponse('Failed to follow', 500);
  }
});

/**
 * DELETE /api/follow - Unfollow a DID
 */
export const DELETE = withLogger('kernel', async (request: NextRequest, { log }) => {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const body = await request.json();
    const { did } = body;

    if (!did) {
      return errorResponse('Missing did');
    }

    await db.delete(follows).where(
      and(
        eq(follows.followerDid, identity.id),
        eq(follows.followedDid, did),
      )
    );

    return jsonResponse({ unfollowed: true });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to unfollow');
    return errorResponse('Failed to unfollow', 500);
  }
});
