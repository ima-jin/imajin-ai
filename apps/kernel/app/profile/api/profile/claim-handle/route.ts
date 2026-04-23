import { NextRequest } from 'next/server';
import { db, profiles, identities } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { jsonResponse, errorResponse } from '@/src/lib/kernel/utils';
import { isValidHandle, HANDLE_ERROR } from '@imajin/config';
import { checkPreliminaryEligibility } from '@/src/lib/kernel/verification';
import { eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

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
      return errorResponse(HANDLE_ERROR);
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

    // Update handle on profile
    const [updated] = await db
      .update(profiles)
      .set({
        handle,
        updatedAt: new Date(),
      })
      .where(eq(profiles.did, identity.id))
      .returning();

    // Record when the handle was claimed on the identity
    const now = new Date();
    await db
      .update(identities)
      .set({ handle, handleClaimedAt: now, updatedAt: now })
      .where(eq(identities.id, identity.id));

    // Fire and forget — never block the response
    publish('handle.claimed', {
      issuer: identity.id,
      subject: identity.id,
      scope: 'profile',
      payload: { handle, context_id: handle, context_type: 'profile' },
    }).catch((err) => log.error({ err: String(err) }, 'Attestation emit error'));

    // Check preliminary eligibility for this DID — fire-and-forget
    checkPreliminaryEligibility(identity.id)
      .catch((err) => log.error({ err: String(err) }, '[verification] preliminary check error'));

    return jsonResponse({
      success: true,
      handle: updated.handle,
      profile: updated,
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to claim handle');
    return errorResponse('Failed to claim handle', 500);
  }
}
