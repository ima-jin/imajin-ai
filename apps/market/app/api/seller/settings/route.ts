import { NextRequest } from 'next/server';
import { db, sellerSettings } from '@/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq } from 'drizzle-orm';

/**
 * GET /api/seller/settings — Get settings for authenticated seller
 * Creates default row if none exists.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    let [settings] = await db
      .select()
      .from(sellerSettings)
      .where(eq(sellerSettings.did, identity.id));

    if (!settings) {
      [settings] = await db
        .insert(sellerSettings)
        .values({ did: identity.id, showMarketItems: false })
        .returning();
    }

    return jsonResponse({ showMarketItems: settings.showMarketItems });
  } catch (error) {
    console.error('Failed to fetch seller settings:', error);
    return errorResponse('Failed to fetch settings', 500);
  }
}

/**
 * PATCH /api/seller/settings — Update settings for authenticated seller
 * Body: { showMarketItems: boolean }
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const body = await request.json();
    const { showMarketItems } = body;

    if (typeof showMarketItems !== 'boolean') {
      return errorResponse('showMarketItems must be a boolean');
    }

    const [settings] = await db
      .insert(sellerSettings)
      .values({ did: identity.id, showMarketItems, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: sellerSettings.did,
        set: { showMarketItems, updatedAt: new Date() },
      })
      .returning();

    return jsonResponse({ showMarketItems: settings.showMarketItems });
  } catch (error) {
    console.error('Failed to update seller settings:', error);
    return errorResponse('Failed to update settings', 500);
  }
}
