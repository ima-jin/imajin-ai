import { NextRequest } from 'next/server';
import { db, profiles } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
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

  // Before enabling, fire-and-forget presence seed in media service
  if (enabled) {
    const mediaUrl = process.env.MEDIA_SERVICE_URL;
    const mediaKey = process.env.MEDIA_INTERNAL_API_KEY;
    if (mediaUrl && mediaKey) {
      const profile = await db.query.profiles.findFirst({
        where: (profiles, { eq }) => eq(profiles.did, identity.id),
      });
      fetch(`${mediaUrl}/api/seed/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mediaKey}` },
        body: JSON.stringify({ did: identity.id, handle: profile?.handle || undefined }),
      }).catch(err => console.error('[Presence] Seed failed (non-fatal):', err));
    }
  }

  // Update inference_enabled on the profile row
  const result = await db
    .update(profiles)
    .set({ inferenceEnabled: enabled })
    .where(eq(profiles.did, identity.id))
    .returning();

  const updated = Array.isArray(result) ? result[0] : result;
  if (!updated) {
    return errorResponse('Profile not found', 404);
  }

  return jsonResponse(updated);
}
