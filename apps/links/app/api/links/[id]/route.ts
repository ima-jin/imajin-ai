import { NextRequest } from 'next/server';
import { db, linkPages, links } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, isValidUrl } from '@/lib/utils';
import { eq } from 'drizzle-orm';

interface RouteParams {
  params: { id: string };
}

/**
 * PUT /api/links/:id - Update a single link (owner only)
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
    // Fetch link with page
    const link = await db.query.links.findFirst({
      where: (links, { eq }) => eq(links.id, id),
    });

    if (!link) {
      return errorResponse('Link not found', 404);
    }

    // Fetch page to check ownership
    const page = await db.query.linkPages.findFirst({
      where: (pages, { eq }) => eq(pages.id, link.pageId),
    });

    if (!page || page.did !== identity.id) {
      return errorResponse('Not authorized to update this link', 403);
    }

    const body = await request.json();
    const { title, url, icon, thumbnail, position, isActive } = body;

    // Validate URL if provided
    if (url && !isValidUrl(url)) {
      return errorResponse('Invalid URL');
    }

    // Build update object
    const updates: Record<string, any> = {
      updatedAt: new Date(),
    };

    if (title !== undefined) updates.title = title;
    if (url !== undefined) updates.url = url;
    if (icon !== undefined) updates.icon = icon;
    if (thumbnail !== undefined) updates.thumbnail = thumbnail;
    if (position !== undefined) updates.position = position;
    if (isActive !== undefined) updates.isActive = isActive;

    // Update link
    const [updated] = await db
      .update(links)
      .set(updates)
      .where(eq(links.id, id))
      .returning();

    return jsonResponse(updated);
  } catch (error) {
    console.error('Failed to update link:', error);
    return errorResponse('Failed to update link', 500);
  }
}

/**
 * DELETE /api/links/:id - Delete a link (owner only)
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
    // Fetch link with page
    const link = await db.query.links.findFirst({
      where: (links, { eq }) => eq(links.id, id),
    });

    if (!link) {
      return errorResponse('Link not found', 404);
    }

    // Fetch page to check ownership
    const page = await db.query.linkPages.findFirst({
      where: (pages, { eq }) => eq(pages.id, link.pageId),
    });

    if (!page || page.did !== identity.id) {
      return errorResponse('Not authorized to delete this link', 403);
    }

    // Delete link
    await db.delete(links).where(eq(links.id, id));

    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error('Failed to delete link:', error);
    return errorResponse('Failed to delete link', 500);
  }
}
