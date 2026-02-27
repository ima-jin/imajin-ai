import { NextRequest } from 'next/server';
import { db, linkPages, links } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq, asc } from 'drizzle-orm';

interface RouteParams {
  params: { handle: string };
}

/**
 * GET /api/pages/:handle - Get links page with all links
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { handle } = params;

  try {
    const page = await db.query.linkPages.findFirst({
      where: (pages, { eq }) => eq(pages.handle, handle),
    });

    if (!page) {
      return errorResponse('Links page not found', 404);
    }

    if (!page.isPublic) {
      return errorResponse('This page is private', 403);
    }

    // Get links for this page
    const pageLinks = await db.query.links.findMany({
      where: (links, { eq, and }) => and(
        eq(links.pageId, page.id),
        eq(links.isActive, true)
      ),
      orderBy: (links, { asc }) => [asc(links.position)],
    });

    return jsonResponse({
      ...page,
      links: pageLinks,
    });
  } catch (error) {
    console.error('Failed to fetch links page:', error);
    return errorResponse('Failed to fetch links page', 500);
  }
}

/**
 * PUT /api/pages/:handle - Update links page (owner only)
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  const { handle } = params;

  // Require authentication
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    // Fetch existing page
    const existing = await db.query.linkPages.findFirst({
      where: (pages, { eq }) => eq(pages.handle, handle),
    });

    if (!existing) {
      return errorResponse('Links page not found', 404);
    }

    // Check ownership
    if (existing.did !== identity.id) {
      return errorResponse('Not authorized to update this page', 403);
    }

    const body = await request.json();
    const { title, bio, avatar, theme, socialLinks, isPublic } = body;

    // Build update object
    const updates: Record<string, any> = {
      updatedAt: new Date(),
    };

    if (title !== undefined) updates.title = title;
    if (bio !== undefined) updates.bio = bio;
    if (avatar !== undefined) updates.avatar = avatar;
    if (theme !== undefined) updates.theme = theme;
    if (socialLinks !== undefined) updates.socialLinks = socialLinks;
    if (isPublic !== undefined) updates.isPublic = isPublic;

    // Update page
    const [updated] = await db
      .update(linkPages)
      .set(updates)
      .where(eq(linkPages.id, existing.id))
      .returning();

    return jsonResponse(updated);
  } catch (error) {
    console.error('Failed to update links page:', error);
    return errorResponse('Failed to update links page', 500);
  }
}

/**
 * DELETE /api/pages/:handle - Delete links page (owner only)
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { handle } = params;

  // Require authentication
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    // Fetch existing page
    const existing = await db.query.linkPages.findFirst({
      where: (pages, { eq }) => eq(pages.handle, handle),
    });

    if (!existing) {
      return errorResponse('Links page not found', 404);
    }

    // Check ownership
    if (existing.did !== identity.id) {
      return errorResponse('Not authorized to delete this page', 403);
    }

    // Delete page (links cascade)
    await db.delete(linkPages).where(eq(linkPages.id, existing.id));

    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error('Failed to delete links page:', error);
    return errorResponse('Failed to delete links page', 500);
  }
}
