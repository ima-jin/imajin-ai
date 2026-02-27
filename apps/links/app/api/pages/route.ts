import { NextRequest } from 'next/server';
import { db, linkPages } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, isValidHandle, generateId, themePresets } from '@/lib/utils';

/**
 * POST /api/pages - Create a new links page
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
    const { handle, title, bio, avatar, theme, themePreset, socialLinks } = body;

    // Validate required fields
    if (!handle) {
      return errorResponse('handle is required');
    }

    if (!title) {
      return errorResponse('title is required');
    }

    if (!isValidHandle(handle)) {
      return errorResponse('Handle must be 3-30 characters, lowercase alphanumeric and underscores only');
    }

    // Check if page already exists for this DID
    const existingDid = await db.query.linkPages.findFirst({
      where: (pages, { eq }) => eq(pages.did, identity.id),
    });

    if (existingDid) {
      return errorResponse('You already have a links page', 409);
    }

    // Check handle uniqueness
    const existingHandle = await db.query.linkPages.findFirst({
      where: (pages, { eq }) => eq(pages.handle, handle),
    });

    if (existingHandle) {
      return errorResponse('Handle is already taken', 409);
    }

    // Resolve theme (preset or custom)
    const resolvedTheme = themePreset && themePresets[themePreset as keyof typeof themePresets]
      ? themePresets[themePreset as keyof typeof themePresets]
      : theme || themePresets.dark;

    // Create page
    const [page] = await db.insert(linkPages).values({
      id: generateId('page'),
      did: identity.id,
      handle,
      title,
      bio: bio || null,
      avatar: avatar || null,
      theme: resolvedTheme,
      socialLinks: socialLinks || {},
      isPublic: true,
    }).returning();

    return jsonResponse(page, 201);
  } catch (error) {
    console.error('Failed to create links page:', error);
    return errorResponse('Failed to create links page', 500);
  }
}
