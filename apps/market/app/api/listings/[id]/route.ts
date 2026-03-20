import { NextRequest } from 'next/server';
import { db, listings } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq } from 'drizzle-orm';

/**
 * GET /api/listings/:id — Single listing detail
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const [listing] = await db.select().from(listings).where(eq(listings.id, params.id));

    if (!listing) {
      return errorResponse('Listing not found', 404);
    }

    return jsonResponse(listing);
  } catch (error) {
    console.error('Failed to fetch listing:', error);
    return errorResponse('Failed to fetch listing', 500);
  }
}

/**
 * PATCH /api/listings/:id — Update listing (seller only)
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const [listing] = await db.select().from(listings).where(eq(listings.id, params.id));

    if (!listing) {
      return errorResponse('Listing not found', 404);
    }

    if (listing.sellerDid !== identity.id) {
      return errorResponse('Forbidden', 403);
    }

    if (listing.status === 'sold' || listing.status === 'removed') {
      return errorResponse(`Cannot update a listing with status '${listing.status}'`);
    }

    const body = await request.json();
    const {
      title,
      description,
      price,
      currency,
      category,
      images,
      quantity,
      sellerTier,
      contactInfo,
      rangeKm,
      metadata,
      status,
    } = body;

    // Validate status transition
    if (status !== undefined && status !== 'active' && status !== 'paused') {
      return errorResponse("status can only be set to 'active' or 'paused'");
    }

    if (images !== undefined && (!Array.isArray(images) || images.length > 8)) {
      return errorResponse('images must be an array with at most 8 items');
    }

    const updates: Record<string, any> = { updatedAt: new Date() };

    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (price !== undefined) updates.price = price;
    if (currency !== undefined) updates.currency = currency;
    if (category !== undefined) updates.category = category;
    if (images !== undefined) updates.images = images;
    if (quantity !== undefined) updates.quantity = quantity;
    if (sellerTier !== undefined) updates.sellerTier = sellerTier;
    if (contactInfo !== undefined) updates.contactInfo = contactInfo;
    if (rangeKm !== undefined) updates.rangeKm = rangeKm;
    if (metadata !== undefined) updates.metadata = metadata;
    if (status !== undefined) updates.status = status;

    const [updated] = await db.update(listings).set(updates).where(eq(listings.id, params.id)).returning();

    return jsonResponse(updated);
  } catch (error) {
    console.error('Failed to update listing:', error);
    return errorResponse('Failed to update listing', 500);
  }
}

/**
 * DELETE /api/listings/:id — Soft delete (seller only)
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const [listing] = await db.select().from(listings).where(eq(listings.id, params.id));

    if (!listing) {
      return errorResponse('Listing not found', 404);
    }

    if (listing.sellerDid !== identity.id) {
      return errorResponse('Forbidden', 403);
    }

    await db.update(listings)
      .set({ status: 'removed', updatedAt: new Date() })
      .where(eq(listings.id, params.id));

    return jsonResponse({ success: true });
  } catch (error) {
    console.error('Failed to delete listing:', error);
    return errorResponse('Failed to delete listing', 500);
  }
}
