import { NextRequest } from 'next/server';
import { db, linkPages, links } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, isValidUrl, generateId } from '@/lib/utils';
import { eq, max } from 'drizzle-orm';

interface RouteParams {
  params: { handle: string };
}

/**
 * POST /api/pages/:handle/links - Add links to page (owner only)
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { handle } = params;

  // Require authentication
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    // Fetch page
    const page = await db.query.linkPages.findFirst({
      where: (pages, { eq }) => eq(pages.handle, handle),
    });

    if (!page) {
      return errorResponse('Links page not found', 404);
    }

    // Check ownership
    if (page.did !== identity.id) {
      return errorResponse('Not authorized to add links to this page', 403);
    }

    const body = await request.json();
    const { links: newLinks } = body;

    if (!newLinks || !Array.isArray(newLinks) || newLinks.length === 0) {
      return errorResponse('links array is required');
    }

    // Get current max position
    const maxPosResult = await db
      .select({ maxPos: max(links.position) })
      .from(links)
      .where(eq(links.pageId, page.id));
    
    let currentPos = (maxPosResult[0]?.maxPos || 0) + 1;

    // Validate and prepare links
    const linksToInsert = [];
    for (const link of newLinks) {
      if (!link.title) {
        return errorResponse('Each link must have a title');
      }
      if (!link.url || !isValidUrl(link.url)) {
        return errorResponse(`Invalid URL: ${link.url}`);
      }

      linksToInsert.push({
        id: generateId('link'),
        pageId: page.id,
        title: link.title,
        url: link.url,
        icon: link.icon || null,
        thumbnail: link.thumbnail || null,
        position: link.position !== undefined ? link.position : currentPos++,
        isActive: link.isActive !== false,
      });
    }

    // Insert links
    const inserted = await db.insert(links).values(linksToInsert).returning();

    return jsonResponse({ links: inserted }, 201);
  } catch (error) {
    console.error('Failed to add links:', error);
    return errorResponse('Failed to add links', 500);
  }
}
