import { NextRequest } from 'next/server';
import { db, listings } from '@/db';
import { requireAuth, getSession } from '@imajin/auth';
import { generateId, jsonResponse, errorResponse } from '@/lib/utils';
import { eq, ilike, and, desc, asc, sql } from 'drizzle-orm';

const VALID_SELLER_TIERS = ['public_offplatform', 'public_onplatform', 'trust_gated'] as const;

/**
 * POST /api/listings — Create listing
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
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
      trustThreshold,
      rangeKm,
      metadata,
      imageAssetIds,
    } = body;

    // Validate required fields
    if (!title) {
      return errorResponse('title is required');
    }

    if (!price || price <= 0) {
      return errorResponse('price must be greater than 0');
    }

    if (images && (!Array.isArray(images) || images.length > 8)) {
      return errorResponse('images must be an array with at most 8 items');
    }

    if (sellerTier && !VALID_SELLER_TIERS.includes(sellerTier)) {
      return errorResponse(`sellerTier must be one of: ${VALID_SELLER_TIERS.join(', ')}`);
    }

    // Tier 1 requires contact info
    if (sellerTier === 'public_offplatform' || !sellerTier) {
      const hasContact = contactInfo && (contactInfo.phone || contactInfo.email || contactInfo.whatsapp);
      if (!hasContact) {
        return errorResponse('contactInfo must include at least one of: phone, email, whatsapp for public_offplatform tier');
      }
    }

    const [listing] = await db.insert(listings).values({
      id: generateId('lst'),
      sellerDid: identity.id,
      title,
      description: description || null,
      price,
      currency: currency || 'CAD',
      category: category || null,
      images: images || [],
      imageAssetIds: imageAssetIds || [],
      quantity: quantity ?? 1,
      sellerTier: sellerTier || 'public_offplatform',
      contactInfo: contactInfo || null,
      trustThreshold: trustThreshold || null,
      rangeKm: rangeKm ?? 50,
      metadata: metadata || {},
    }).returning();

    return jsonResponse(listing, 201);
  } catch (error) {
    console.error('Failed to create listing:', error);
    return errorResponse('Failed to create listing', 500);
  }
}

/**
 * GET /api/listings — Browse/search listings
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category');
    const status = searchParams.get('status') || 'active';
    const currency = searchParams.get('currency');
    const sellerTier = searchParams.get('seller_tier');
    const sellerDid = searchParams.get('seller_did');
    const sort = searchParams.get('sort') || 'newest';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)));
    const offset = (page - 1) * limit;

    // Check if requester is the seller (can see all their own statuses)
    let authSellerDid: string | null = null;
    const session = await getSession();
    if (session) {
      authSellerDid = session.id;
    }

    // Build where conditions
    const conditions = [];

    // Status filter: sellers see all their own listings, others only see active
    if (sellerDid && sellerDid === authSellerDid) {
      // Authenticated seller viewing their own — respect explicit status filter if provided
      if (searchParams.has('status')) {
        conditions.push(eq(listings.status, status));
      }
      conditions.push(eq(listings.sellerDid, sellerDid));
    } else {
      conditions.push(eq(listings.status, status));
      if (sellerDid) {
        conditions.push(eq(listings.sellerDid, sellerDid));
      }
    }

    if (category) {
      conditions.push(ilike(listings.category, `%${category}%`));
    }

    if (currency) {
      conditions.push(eq(listings.currency, currency.toUpperCase()));
    }

    if (sellerTier) {
      conditions.push(eq(listings.sellerTier, sellerTier));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Sort order
    let orderBy;
    if (sort === 'price_asc') {
      orderBy = asc(listings.price);
    } else if (sort === 'price_desc') {
      orderBy = desc(listings.price);
    } else {
      orderBy = desc(listings.createdAt);
    }

    const [rows, countResult] = await Promise.all([
      db.select().from(listings).where(whereClause).orderBy(orderBy).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(listings).where(whereClause),
    ]);

    const total = Number(countResult[0]?.count ?? 0);

    return jsonResponse({
      listings: rows,
      total,
      page,
      limit,
      hasMore: offset + rows.length < total,
    });
  } catch (error) {
    console.error('Failed to fetch listings:', error);
    return errorResponse('Failed to fetch listings', 500);
  }
}
