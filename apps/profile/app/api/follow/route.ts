import { NextRequest } from 'next/server';
import { db, follows } from '@/db';
import { requireAuth } from '@/lib/auth';
import { generateId, jsonResponse, errorResponse } from '@/lib/utils';
import { eq, and } from 'drizzle-orm';

/**
 * POST /api/follow - Follow a DID
 */
export async function POST(request: NextRequest) {
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
    console.error('Failed to follow:', error);
    return errorResponse('Failed to follow', 500);
  }
}

/**
 * DELETE /api/follow - Unfollow a DID
 */
export async function DELETE(request: NextRequest) {
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
    console.error('Failed to unfollow:', error);
    return errorResponse('Failed to unfollow', 500);
  }
}
