import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
const log = createLogger('market');
import { db, listings, sellerSettings } from '@/db';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq, and, desc } from 'drizzle-orm';

/**
 * GET /api/seller/:did/profile-listings — Public profile listings endpoint
 * No auth required. Returns active listings only if seller has enabled profile integration.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { did: string } }
) {
  const { did } = params;

  if (!did) {
    return errorResponse('did is required');
  }

  try {
    const [settings] = await db
      .select()
      .from(sellerSettings)
      .where(eq(sellerSettings.did, did));

    if (!settings || !settings.showMarketItems) {
      return jsonResponse({ listings: [], enabled: false });
    }

    const rows = await db
      .select({
        id: listings.id,
        title: listings.title,
        price: listings.price,
        currency: listings.currency,
        images: listings.images,
        category: listings.category,
        sellerTier: listings.sellerTier,
        createdAt: listings.createdAt,
      })
      .from(listings)
      .where(and(eq(listings.sellerDid, did), eq(listings.status, 'active')))
      .orderBy(desc(listings.createdAt))
      .limit(8);

    return jsonResponse({ listings: rows, enabled: true });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch profile listings');
    return errorResponse('Failed to fetch profile listings', 500);
  }
}
