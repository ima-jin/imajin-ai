import { NextRequest } from 'next/server';
import { db, linkPages } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, generateId, themePresets } from '@/lib/utils';

/**
 * POST /api/pages/auto-create - Auto-create a links page from profile data
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    // Check if page already exists
    const existing = await db.query.linkPages.findFirst({
      where: (pages, { eq }) => eq(pages.did, identity.id),
    });

    if (existing) {
      return errorResponse('You already have a links page', 409);
    }

    // Use identity data to create the page
    const handle = identity.handle || identity.id.slice(-12);
    const title = identity.name || handle;

    // Create page
    const [page] = await db.insert(linkPages).values({
      id: generateId('page'),
      did: identity.id,
      handle,
      title,
      bio: null,
      avatar: null,
      theme: themePresets.dark,
      socialLinks: {},
      isPublic: true,
    }).returning();

    return jsonResponse(page, 201);
  } catch (error) {
    console.error('Failed to auto-create links page:', error);
    return errorResponse('Failed to create links page', 500);
  }
}
