import { NextRequest } from 'next/server';
import { db, links, linkClicks } from '@/db';
import { jsonResponse, errorResponse, extractDomain, generateId } from '@/lib/utils';
import { eq, sql } from 'drizzle-orm';

interface RouteParams {
  params: { id: string };
}

/**
 * POST /api/links/:id/click - Record a link click
 * 
 * Privacy-preserving: only stores referrer domain and optional country
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = params;

  try {
    // Verify link exists
    const link = await db.query.links.findFirst({
      where: (links, { eq }) => eq(links.id, id),
    });

    if (!link) {
      return errorResponse('Link not found', 404);
    }

    // Extract referrer domain (not full URL for privacy)
    const referrer = request.headers.get('referer');
    const referrerDomain = extractDomain(referrer);

    // Get country from header if provided by reverse proxy / CDN
    const country = request.headers.get('cf-ipcountry') ||
                    request.headers.get('x-country') ||
                    null;

    // Record click (minimal data)
    await db.insert(linkClicks).values({
      id: generateId('click'),
      linkId: id,
      referrer: referrerDomain,
      country,
    });

    // Increment click counter
    await db
      .update(links)
      .set({ clicks: sql`${links.clicks} + 1` })
      .where(eq(links.id, id));

    return jsonResponse({ recorded: true });
  } catch (error) {
    console.error('Failed to record click:', error);
    // Don't fail the user experience if click tracking fails
    return jsonResponse({ recorded: false });
  }
}
