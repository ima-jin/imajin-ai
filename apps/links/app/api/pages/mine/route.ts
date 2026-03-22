import { NextRequest } from 'next/server';
import { db, linkPages, links } from '@/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq, asc } from 'drizzle-orm';

/**
 * GET /api/pages/mine - Get current user's links page with all links
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const page = await db.query.linkPages.findFirst({
      where: eq(linkPages.did, identity.id),
    });

    if (!page) {
      return jsonResponse({ page: null });
    }

    // Get links for this page
    const pageLinks = await db
      .select()
      .from(links)
      .where(eq(links.pageId, page.id))
      .orderBy(asc(links.position));

    return jsonResponse({
      ...page,
      links: pageLinks,
    });
  } catch (error) {
    console.error('Failed to fetch my links page:', error);
    return errorResponse('Failed to fetch links page', 500);
  }
}
