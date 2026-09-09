import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
const log = createLogger('market');
import { db, listings } from '@/db';
import type { Listing } from '@/db';
import { requireAuth, getSession , resolveActingDid } from '@imajin/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { resolveMediaRef } from '@imajin/media';
import { buildFairManifest } from '@imajin/fair';
import type { FairFeeManifest } from '@imajin/fair';
import { getNodeSelf, getForestScopeConfig } from '@imajin/config';
import { publish } from '@imajin/bus';
import { eq } from 'drizzle-orm';

const STATUS_TRANSITIONS: Record<string, string[]> = {
  active:      ['paused', 'sold', 'rented', 'unavailable'],
  paused:      ['active', 'removed'],
  unavailable: ['active', 'removed'],
  sold:        ['removed'],
  rented:      ['removed'],
  removed:     [],
};

function validateStatusTransition(currentStatus: string, nextStatus: string): string | null {
  const validNext = STATUS_TRANSITIONS[currentStatus] ?? [];
  if (validNext.includes(nextStatus)) return null;
  return `Cannot transition listing from '${currentStatus}' to '${nextStatus}'. Allowed: ${validNext.join(', ') || 'none'}`;
}

const UPDATABLE_LISTING_FIELDS = [
  'title',
  'description',
  'price',
  'currency',
  'category',
  'images',
  'imageAssetIds',
  'quantity',
  'sellerTier',
  'contactInfo',
  'rangeKm',
  'metadata',
  'status',
  'type',
  'showContactInfo',
] as const;

type ListingPatchBody = Partial<{
  title: string;
  description: string;
  price: number;
  currency: string;
  category: string;
  images: string[];
  imageAssetIds: string[];
  quantity: number;
  sellerTier: string;
  contactInfo: Record<string, unknown>;
  rangeKm: number;
  metadata: Record<string, unknown>;
  status: string;
  type: string;
  showContactInfo: boolean;
  expiresAt: string;
}>;

function buildListingUpdates(body: ListingPatchBody) {
  const updates: Record<string, any> = { updatedAt: new Date() };
  for (const field of UPDATABLE_LISTING_FIELDS) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }
  if (body.expiresAt !== undefined) {
    updates.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  }
  return updates;
}

async function recalculateFairManifest(params: {
  did: string;
  listing: Listing;
  listingId: string;
  price?: number;
  sellerTier?: string;
  actingAs?: string | null;
}): Promise<FairFeeManifest | undefined> {
  const { did, listing, listingId, price, sellerTier, actingAs } = params;
  const priceChanged = price !== undefined && price !== listing.price;
  const tierChanged = sellerTier !== undefined && sellerTier !== listing.sellerTier;
  const sellerDidChanged = did !== listing.sellerDid;

  if (!priceChanged && !tierChanged && !sellerDidChanged) {
    return undefined;
  }

  try {
    const nodeSelf = await getNodeSelf();
    const scopeDid = listing.sellerDid === did ? (actingAs || null) : null;
    let scopeFeeBps: number | null = null;
    if (scopeDid) {
      const forestConfig = await getForestScopeConfig(scopeDid);
      scopeFeeBps = forestConfig?.scopeFeeBps ?? null;
    }
    return buildFairManifest({
      creatorDid: did,
      contentDid: listingId,
      contentType: 'listing',
      scopeDid,
      scopeFeeBps,
      nodeFeeBps: nodeSelf?.nodeFeeBps ?? undefined,
      buyerCreditBps: nodeSelf?.buyerCreditBps ?? undefined,
      nodeOperatorDid: nodeSelf?.nodeOperatorDid ?? undefined,
    });
  } catch (manifestErr) {
    log.warn({ err: String(manifestErr) }, 'Failed to recalculate .fair manifest (non-fatal)');
    return undefined;
  }
}

/**
 * GET /api/listings/:id — Single listing detail
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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
export async function PATCH(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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

    const did = resolveActingDid(identity);
    if (listing.sellerDid !== did) {
      return errorResponse('Forbidden', 403);
    }

    const body = await request.json();
    const { price, sellerTier, images, status } = body;

    // Validate status transition
    if (status !== undefined) {
      const transitionError = validateStatusTransition(listing.status ?? 'active', status);
      if (transitionError) {
        return errorResponse(transitionError);
      }
    }

    if (images !== undefined && (!Array.isArray(images) || images.length > 8)) {
      return errorResponse('images must be an array with at most 8 items');
    }

    const updates = buildListingUpdates(body);

    // Recalculate .fair manifest if price, sellerTier, or seller DID changes
    const fairManifest = await recalculateFairManifest({
      did,
      listing,
      listingId: params.id,
      price,
      sellerTier,
      actingAs: identity.actingAs,
    });
    if (fairManifest !== undefined) {
      updates.fairManifest = fairManifest;
    }

    const [updated] = await db.update(listings).set(updates).where(eq(listings.id, params.id)).returning();

    publish('listing.update', {
      issuer: did,
      subject: did,
      scope: 'market',
      payload: { listingId: params.id },
    }).catch(() => {});

    return jsonResponse(updated);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to update listing');
    return errorResponse('Failed to update listing', 500);
  }
}

/**
 * DELETE /api/listings/:id — Soft delete (seller only)
 */
export async function DELETE(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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

    const did = resolveActingDid(identity);
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
