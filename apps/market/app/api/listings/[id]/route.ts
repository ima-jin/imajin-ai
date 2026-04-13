import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { createEmitter } from '@imajin/emit';
const log = createLogger('market');
const marketEvents = createEmitter('market');
import { db, listings } from '@/db';
import { requireAuth, getSession } from '@imajin/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { resolveMediaRef } from '@imajin/media';
import { eq } from 'drizzle-orm';

/**
 * GET /api/listings/:id — Single listing detail
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const [listing] = await db.select().from(listings).where(eq(listings.id, params.id));

    if (!listing) {
      return errorResponse('Listing not found', 404);
    }

    // Trust-gated listings require a valid session
    if (listing.sellerTier === 'trust_gated') {
      const session = await getSession();
      if (!session) {
        return Response.json(
          { error: 'This listing is only available to verified members', gated: true },
          { status: 403 }
        );
      }
    }

    // Resolve asset IDs to full URLs at multiple sizes for display
    const rawImages = Array.isArray(listing.images) ? listing.images as string[] : [];
    const resolvedImages = rawImages.map((ref) => resolveMediaRef(ref, 'detail'));

    return jsonResponse({
      ...listing,
      price: Number(listing.price),
      images: resolvedImages,
      imageRefs: rawImages,
      // sellerDid is included via spread — client resolves seller profile from this
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch listing');
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

    const did = identity.actingAs || identity.id;
    if (listing.sellerDid !== did) {
      return errorResponse('Forbidden', 403);
    }

    const body = await request.json();
    const {
      title,
      description,
      price,
      currency,
      category,
      images,
      imageAssetIds,
      quantity,
      sellerTier,
      contactInfo,
      rangeKm,
      metadata,
      status,
      type,
      showContactInfo,
      expiresAt,
    } = body;

    // Validate status transition
    if (status !== undefined) {
      const currentStatus = listing.status ?? 'active';
      const allowed: Record<string, string[]> = {
        active:      ['paused', 'sold', 'rented', 'unavailable'],
        paused:      ['active', 'removed'],
        unavailable: ['active', 'removed'],
        sold:        ['removed'],
        rented:      ['removed'],
        removed:     [],
      };
      const validNext = allowed[currentStatus] ?? [];
      if (!validNext.includes(status)) {
        return errorResponse(
          `Cannot transition listing from '${currentStatus}' to '${status}'. Allowed: ${validNext.join(', ') || 'none'}`
        );
      }
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
    if (imageAssetIds !== undefined) updates.imageAssetIds = imageAssetIds;
    if (quantity !== undefined) updates.quantity = quantity;
    if (sellerTier !== undefined) updates.sellerTier = sellerTier;
    if (contactInfo !== undefined) updates.contactInfo = contactInfo;
    if (rangeKm !== undefined) updates.rangeKm = rangeKm;
    if (metadata !== undefined) updates.metadata = metadata;
    if (status !== undefined) updates.status = status;
    if (type !== undefined) updates.type = type;
    if (showContactInfo !== undefined) updates.showContactInfo = showContactInfo;
    if (expiresAt !== undefined) updates.expiresAt = expiresAt ? new Date(expiresAt) : null;

    const [updated] = await db.update(listings).set(updates).where(eq(listings.id, params.id)).returning();

    marketEvents.emit({ action: 'listing.update', did, payload: { listingId: params.id } });

    return jsonResponse(updated);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to update listing');
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

    const did = identity.actingAs || identity.id;
    if (listing.sellerDid !== did) {
      return errorResponse('Forbidden', 403);
    }

    await db.update(listings)
      .set({ status: 'removed', updatedAt: new Date() })
      .where(eq(listings.id, params.id));

    return jsonResponse({ success: true });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to delete listing');
    return errorResponse('Failed to delete listing', 500);
  }
}
