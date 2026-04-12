import { NextRequest } from 'next/server';
import { db, profiles } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse, isValidHandle } from '@/src/lib/kernel/utils';
import { withLogger } from '@imajin/logger';

/**
 * POST /api/profile - Create a new profile
 */
export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  // Require authentication
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const body = await request.json();
    const { displayName, avatar, avatarAssetId, bio, handle, metadata, email, phone, optInUpdates } = body;

    // Validate required fields
    if (!displayName) {
      return errorResponse('displayName is required');
    }

    // Validate handle format if provided
    if (handle && !isValidHandle(handle)) {
      return errorResponse('Handle must be 3-30 characters, lowercase alphanumeric and underscores only');
    }

    // Check if profile already exists for this DID
    const existing = await db.query.profiles.findFirst({
      where: (profiles, { eq }) => eq(profiles.did, identity.id),
    });

    if (existing) {
      return errorResponse('Profile already exists for this identity', 409);
    }

    // Check handle uniqueness if provided
    if (handle) {
      const handleTaken = await db.query.profiles.findFirst({
        where: (profiles, { eq }) => eq(profiles.handle, handle),
      });

      if (handleTaken) {
        return errorResponse('Handle is already taken', 409);
      }
    }

    // Create profile
    const result = await db.insert(profiles).values({
      did: identity.id,
      displayName,
      avatar: avatar || null,
      avatarAssetId: avatarAssetId || null,
      bio: bio || null,
      handle: handle || null,
      contactEmail: email || null,
      phone: phone || null,
      metadata: {
        ...(metadata || {}),
        ...(optInUpdates !== undefined ? { optInUpdates } : {}),
      },
    }).returning();

    const profile = Array.isArray(result) ? result[0] : result;
    return jsonResponse(profile, 201);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to create profile');
    return errorResponse('Failed to create profile', 500);
  }
});
