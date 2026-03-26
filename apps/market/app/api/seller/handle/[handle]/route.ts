import { NextRequest } from 'next/server';
import { db, listings, sellerSettings } from '@/db';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq, and, desc } from 'drizzle-orm';

const PROFILE_SERVICE_URL =
  process.env.PROFILE_SERVICE_URL || 'http://localhost:3005';

/**
 * GET /api/seller/handle/:handle — Resolve handle → DID → listings
 * Server-side profile lookup so the client doesn't need cross-service calls.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { handle: string } }
) {
  const { handle } = params;

  if (!handle) {
    return errorResponse('handle is required');
  }

  try {
    // Resolve handle to profile via profile service (server-side)
    const profileRes = await fetch(
      `${PROFILE_SERVICE_URL}/api/profile/${encodeURIComponent(handle)}`
    );
    if (!profileRes.ok) {
      return errorResponse('Seller not found', 404);
    }
    const profile = await profileRes.json();
    const did: string = profile?.did;
    if (!did) {
      return errorResponse('Seller not found', 404);
    }

    // Check seller settings
    const [settings] = await db
      .select()
      .from(sellerSettings)
      .where(eq(sellerSettings.did, did));

    if (!settings || !settings.showMarketItems) {
      return jsonResponse({
        seller: { handle: profile.handle, displayName: profile.displayName },
        listings: [],
        enabled: false,
      });
    }

    // Fetch active listings
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
      .limit(100);

    return jsonResponse({
      seller: { handle: profile.handle, displayName: profile.displayName, did },
      listings: rows,
      enabled: true,
    });
  } catch (error) {
    console.error('Failed to fetch seller by handle:', error);
    return errorResponse('Failed to fetch seller listings', 500);
  }
}
