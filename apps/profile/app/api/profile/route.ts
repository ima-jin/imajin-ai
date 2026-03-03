import { NextRequest } from 'next/server';
import { db, profiles } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, isValidHandle } from '@/lib/utils';

/**
 * POST /api/profile - Create a new profile
 */
export async function POST(request: NextRequest) {
  // Require authentication
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const body = await request.json();
    const { displayName, displayType, avatar, bio, handle, metadata } = body;

    // Validate required fields
    if (!displayName) {
      return errorResponse('displayName is required');
    }

    if (!displayType || !['human', 'agent', 'presence'].includes(displayType)) {
      return errorResponse('displayType must be human, agent, or presence');
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
      displayType,
      identityTier: identity.tier || 'hard', // use tier from authenticated identity
      avatar: avatar || null,
      bio: bio || null,
      handle: handle || null,
      metadata: metadata || {},
    }).returning();

    const profile = Array.isArray(result) ? result[0] : result;
    return jsonResponse(profile, 201);
  } catch (error) {
    console.error('Failed to create profile:', error);
    return errorResponse('Failed to create profile', 500);
  }
}
