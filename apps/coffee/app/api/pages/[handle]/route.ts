import { NextRequest } from 'next/server';
import { db, coffeePages } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq } from 'drizzle-orm';

interface RouteParams {
  params: { handle: string };
}

/**
 * GET /api/pages/:handle - Get coffee page by handle
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { handle } = params;

  try {
    const page = await db.query.coffeePages.findFirst({
      where: (pages, { eq }) => eq(pages.handle, handle),
    });

    if (!page) {
      return errorResponse('Coffee page not found', 404);
    }

    if (!page.isPublic) {
      return errorResponse('This page is private', 403);
    }

    return jsonResponse(page);
  } catch (error) {
    console.error('Failed to fetch coffee page:', error);
    return errorResponse('Failed to fetch coffee page', 500);
  }
}

/**
 * PUT /api/pages/:handle - Update coffee page (owner only)
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
    const existing = await db.query.coffeePages.findFirst({
      where: (pages, { eq }) => eq(pages.handle, handle),
    });

    if (!existing) {
      return errorResponse('Coffee page not found', 404);
    }

    // Check ownership
    if (existing.did !== identity.id) {
      return errorResponse('Not authorized to update this page', 403);
    }

    const body = await request.json();
    const { 
      title, 
      bio, 
      avatar, 
      theme,
      paymentMethods,
      presets,
      allowCustomAmount,
      allowMessages,
      isPublic,
    } = body;

    // Build update object
    const updates: Record<string, any> = {
      updatedAt: new Date(),
    };

    if (title !== undefined) updates.title = title;
    if (bio !== undefined) updates.bio = bio;
    if (avatar !== undefined) updates.avatar = avatar;
    if (theme !== undefined) updates.theme = theme;
    if (paymentMethods !== undefined) updates.paymentMethods = paymentMethods;
    if (presets !== undefined) updates.presets = presets;
    if (allowCustomAmount !== undefined) updates.allowCustomAmount = allowCustomAmount;
    if (allowMessages !== undefined) updates.allowMessages = allowMessages;
    if (isPublic !== undefined) updates.isPublic = isPublic;

    // Update page
    const [updated] = await db
      .update(coffeePages)
      .set(updates)
      .where(eq(coffeePages.id, existing.id))
      .returning();

    return jsonResponse(updated);
  } catch (error) {
    console.error('Failed to update coffee page:', error);
    return errorResponse('Failed to update coffee page', 500);
  }
}

/**
 * DELETE /api/pages/:handle - Delete coffee page (owner only)
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
    const existing = await db.query.coffeePages.findFirst({
      where: (pages, { eq }) => eq(pages.handle, handle),
    });

    if (!existing) {
      return errorResponse('Coffee page not found', 404);
    }

    // Check ownership
    if (existing.did !== identity.id) {
      return errorResponse('Not authorized to delete this page', 403);
    }

    // Delete page
    await db.delete(coffeePages).where(eq(coffeePages.id, existing.id));

    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error('Failed to delete coffee page:', error);
    return errorResponse('Failed to delete coffee page', 500);
  }
}
