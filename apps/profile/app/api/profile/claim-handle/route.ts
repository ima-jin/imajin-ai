import { NextRequest } from 'next/server';
import { db, profiles } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, isValidHandle } from '@/lib/utils';
import { eq } from 'drizzle-orm';

/**
 * POST /api/profile/claim-handle - Claim a handle for your profile
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
    const { handle } = body;

    // Validate handle
    if (!handle) {
      return errorResponse('handle is required');
    }

    if (!isValidHandle(handle)) {
      return errorResponse('Handle must be 3-30 characters, lowercase alphanumeric and underscores only');
    }

    // Check if profile exists
    const profile = await db.query.profiles.findFirst({
      where: (profiles, { eq }) => eq(profiles.did, identity.id),
    });

    if (!profile) {
      return errorResponse('Profile not found. Create a profile first.', 404);
    }

    // Check if handle is already taken
    const existing = await db.query.profiles.findFirst({
      where: (profiles, { eq }) => eq(profiles.handle, handle),
    });

    if (existing && existing.did !== identity.id) {
      return errorResponse('Handle is already taken', 409);
    }

    // Update handle
    const [updated] = await db
      .update(profiles)
      .set({ 
        handle,
        updatedAt: new Date(),
      })
      .where(eq(profiles.did, identity.id))
      .returning();

    return jsonResponse({ 
      success: true, 
      handle: updated.handle,
      profile: updated,
    });
  } catch (error) {
    console.error('Failed to claim handle:', error);
    return errorResponse('Failed to claim handle', 500);
  }
}
