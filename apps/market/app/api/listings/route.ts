import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
const log = createLogger('market');
import { db, listings } from '@/db';
import { requireAuth, getSession , resolveActingDid } from '@imajin/auth';
import { generateId, jsonResponse, errorResponse } from '@/lib/utils';
import { resolveMediaRef } from '@imajin/media';
import { getNodeSelf, getForestScopeConfig } from '@imajin/config';
import { buildFairManifest } from '@imajin/fair';
import { publish } from '@imajin/bus';
import { eq, ilike, and, desc, asc, sql, ne } from 'drizzle-orm';

const VALID_SELLER_TIERS = ['public_offplatform', 'public_onplatform', 'trust_gated'] as const;

function parseListingsQuery(searchParams: URLSearchParams) {
  const page = Math.max(1, Number.parseInt(searchParams.get('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, Number.parseInt(searchParams.get('limit') || '20', 10)));
  return {
    category: searchParams.get('category'),
    status: searchParams.get('status') || 'active',
    currency: searchParams.get('currency'),
    sellerTier: searchParams.get('seller_tier'),
    sellerDid: searchParams.get('seller_did'),
    exclude: searchParams.get('exclude'),
    sort: searchParams.get('sort') || 'newest',
    page,
    limit,
    offset: (page - 1) * limit,
  };
}

function buildOwnerOrPublicStatusConditions(
  searchParams: URLSearchParams,
  status: string,
  sellerDid: string | null,
  authSellerDid: string | null
) {
  const conditions = [];
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
  return conditions;
}

function buildListingsWhereConditions(params: {
  searchParams: URLSearchParams;
  status: string;
  sellerDid: string | null;
  authSellerDid: string | null;
  hasSession: boolean;
  exclude: string | null;
  category: string | null;
  currency: string | null;
  sellerTier: string | null;
}) {
  const { searchParams, status, sellerDid, authSellerDid, hasSession, exclude, category, currency, sellerTier } = params;

  const conditions = buildOwnerOrPublicStatusConditions(searchParams, status, sellerDid, authSellerDid);

  // Filter out trust_gated listings for unauthenticated users
  if (!hasSession) {
    conditions.push(sql`${listings.sellerTier} != 'trust_gated'`);
  }

  // Exclude a specific listing ID (e.g. for 'other items by seller' queries)
  if (exclude) {
    conditions.push(ne(listings.id, exclude));
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

  return conditions;
}

function resolveListingsSortOrder(sort: string) {
  if (sort === 'price_asc') return asc(listings.price);
  if (sort === 'price_desc') return desc(listings.price);
  return desc(listings.createdAt);
}

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
      type,
      showContactInfo,
      expiresAt,
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

    const did = resolveActingDid(identity);

    // Load node config (via the registry, #2000) and optional scope config for fair
    // manifest (via the profile service's public forest route, #2001)
    const nodeSelf = await getNodeSelf();
    const scopeDid = identity.actingAs || null;
    let scopeFeeBps: number | null = null;
    if (scopeDid) {
      const forestConfig = await getForestScopeConfig(scopeDid);
      scopeFeeBps = forestConfig?.scopeFeeBps ?? null;
    }
    const listingId = generateId('lst');
    const fairManifest = buildFairManifest({
      creatorDid: did,
      contentDid: listingId,
      contentType: 'listing',
      scopeDid,
      scopeFeeBps,
      nodeFeeBps: nodeSelf?.nodeFeeBps ?? undefined,
      buyerCreditBps: nodeSelf?.buyerCreditBps ?? undefined,
      nodeOperatorDid: nodeSelf?.nodeOperatorDid ?? undefined,
    });

    const [listing] = await db.insert(listings).values({
      id: listingId,
      sellerDid: did,
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
      type: type || 'sale',
      showContactInfo: showContactInfo ?? false,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      fairManifest,
    }).returning();

    publish('listing.create', {
      issuer: did,
      subject: did,
      scope: 'market',
      payload: { listingId: listing.id, title, price },
    }).catch(() => {});

    // Fire and forget — never block the response
    publish('listing.created', {
      issuer: identity.id,
      subject: identity.id,
      scope: 'market',
      payload: {
        context_id: listing.id,
        context_type: 'market',
        title,
        price,
        currency: listing.currency ?? 'CAD',
        interestDids: [identity.id],
      },
    }).catch((err) => log.error({ err: String(err) }, 'Attestation emit error'));

    return jsonResponse(listing, 201);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to create listing');
    return errorResponse('Failed to create listing', 500);
  }
}

/**
 * GET /api/listings — Browse/search listings
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const query = parseListingsQuery(searchParams);

    // Check if requester is the seller (can see all their own statuses)
    const session = await getSession();
    const authSellerDid = session ? resolveActingDid(session) : null;

    const conditions = buildListingsWhereConditions({
      searchParams,
      status: query.status,
      sellerDid: query.sellerDid,
      authSellerDid,
      hasSession: !!session,
      exclude: query.exclude,
      category: query.category,
      currency: query.currency,
      sellerTier: query.sellerTier,
    });

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const orderBy = resolveListingsSortOrder(query.sort);

    const [rows, countResult] = await Promise.all([
      db.select().from(listings).where(whereClause).orderBy(orderBy).limit(query.limit).offset(query.offset),
      db.select({ count: sql<number>`count(*)` }).from(listings).where(whereClause),
    ]);

    const total = Number(countResult[0]?.count ?? 0);

    // Resolve asset IDs to full URLs so consumers don't need to know about media internals
    const resolved = rows.map((row) => ({
      ...row,
      images: Array.isArray(row.images)
        ? (row.images as string[]).map((ref) => resolveMediaRef(ref, 'card'))
        : row.images,
    }));

    return jsonResponse({
      listings: resolved,
      total,
      page: query.page,
      limit: query.limit,
      hasMore: query.offset + rows.length < total,
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch listings');
    return errorResponse('Failed to fetch listings', 500);
  }
}
