import { NextRequest } from 'next/server';
import { db, profiles } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse } from '@/src/lib/kernel/utils';
import { eq } from 'drizzle-orm';

/**
 * POST /api/profile/inference - Toggle inference (AI presence) for the authenticated user
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  let body: { enabled?: boolean };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  if (typeof body.enabled !== 'boolean') {
    return errorResponse('enabled (boolean) is required');
  }

  const { enabled } = body;

  // Fetch profile once (needed for both seeding and merge)
  const existing = await db.query.profiles.findFirst({
    where: (profiles, { eq }) => eq(profiles.did, identity.id),
  });

  // Before enabling, fire-and-forget presence seed in media service
  if (enabled) {
    const mediaUrl = process.env.MEDIA_SERVICE_URL;
    const mediaKey = process.env.MEDIA_INTERNAL_API_KEY;
    if (mediaUrl && mediaKey) {
      fetch(`${mediaUrl}/api/seed/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mediaKey}` },
        body: JSON.stringify({ did: identity.id, handle: existing?.handle || undefined }),
      }).catch(err => console.error('[Presence] Seed failed (non-fatal):', err));
    }
  }

  // Merge inference_enabled into feature_toggles
  const result = await db
    .update(profiles)
    .set({ featureToggles: { ...(existing?.featureToggles ?? {}), inference_enabled: enabled } })
    .where(eq(profiles.did, identity.id))
    .returning();

  const updated = Array.isArray(result) ? result[0] : result;
  if (!updated) {
    return errorResponse('Profile not found', 404);
  }

  return jsonResponse(updated);
}
