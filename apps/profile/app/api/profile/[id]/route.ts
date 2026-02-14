import { NextRequest } from 'next/server';
import { db, profiles } from '@/db';
import { requireAuth, extractToken, validateToken } from '@/lib/auth';
import { jsonResponse, errorResponse, isValidHandle } from '@/lib/utils';
import { eq, or } from 'drizzle-orm';

interface RouteParams {
  params: { id: string };
}

/**
 * GET /api/profile/:id - Get profile by DID or handle
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = params;

  try {
    // Look up by DID or handle
    const profile = await db.query.profiles.findFirst({
      where: (profiles, { eq, or }) => 
        or(eq(profiles.did, id), eq(profiles.handle, id)),
    });

    if (!profile) {
      return errorResponse('Profile not found', 404);
    }

    return jsonResponse(profile);
  } catch (error) {
    console.error('Failed to fetch profile:', error);
    return errorResponse('Failed to fetch profile', 500);
  }
}

/**
 * PUT /api/profile/:id - Update profile (owner only)
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  const { id } = params;

  // Require authentication
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    // Fetch existing profile
    const existing = await db.query.profiles.findFirst({
      where: (profiles, { eq, or }) => 
        or(eq(profiles.did, id), eq(profiles.handle, id)),
    });

    if (!existing) {
      return errorResponse('Profile not found', 404);
    }

    // Check ownership
    if (existing.did !== identity.id) {
      return errorResponse('Not authorized to update this profile', 403);
    }

    const body = await request.json();
    const { displayName, displayType, avatar, bio, metadata } = body;

    // Build update object
    const updates: Record<string, any> = {
      updatedAt: new Date(),
    };

    if (displayName !== undefined) updates.displayName = displayName;
    if (displayType !== undefined) {
      if (!['human', 'agent', 'presence'].includes(displayType)) {
        return errorResponse('displayType must be human, agent, or presence');
      }
      updates.displayType = displayType;
    }
    if (avatar !== undefined) updates.avatar = avatar;
    if (bio !== undefined) updates.bio = bio;
    if (metadata !== undefined) updates.metadata = metadata;

    // Update profile
    const [updated] = await db
      .update(profiles)
      .set(updates)
      .where(eq(profiles.did, existing.did))
      .returning();

    return jsonResponse(updated);
  } catch (error) {
    console.error('Failed to update profile:', error);
    return errorResponse('Failed to update profile', 500);
  }
}

/**
 * DELETE /api/profile/:id - Delete profile (owner only)
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { id } = params;

  // Require authentication
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    // Fetch existing profile
    const existing = await db.query.profiles.findFirst({
      where: (profiles, { eq, or }) => 
        or(eq(profiles.did, id), eq(profiles.handle, id)),
    });

    if (!existing) {
      return errorResponse('Profile not found', 404);
    }

    // Check ownership
    if (existing.did !== identity.id) {
      return errorResponse('Not authorized to delete this profile', 403);
    }

    // Delete profile
    await db.delete(profiles).where(eq(profiles.did, existing.did));

    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error('Failed to delete profile:', error);
    return errorResponse('Failed to delete profile', 500);
  }
}
