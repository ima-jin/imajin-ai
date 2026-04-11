import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
const log = createLogger('coffee');
import { db, coffeePages } from '@/db';
import { requireAuth } from '@imajin/auth';
import { getClient } from '@imajin/db';
import { buildFairManifest } from '@imajin/fair';
import { jsonResponse, errorResponse, isValidHandle, generateId } from '@/lib/utils';

/**
 * POST /api/pages - Create a new tip page
 */
export async function POST(request: NextRequest) {
  // Require authentication
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;
  const did = identity.actingAs || identity.id;

  try {
    const body = await request.json();
    const {
      handle,
      title,
      bio,
      avatar,
      avatarAssetId,
      theme,
      paymentMethods,
      presets,
      allowCustomAmount,
      allowMessages,
      thankYouContent,
    } = body;

    // Validate required fields
    if (!handle) {
      return errorResponse('handle is required');
    }

    if (!title) {
      return errorResponse('title is required');
    }

    if (!isValidHandle(handle)) {
      return errorResponse('Handle must be 3-30 characters, lowercase alphanumeric and underscores only');
    }

    // Validate payment methods
    if (!paymentMethods || (!paymentMethods.stripe && !paymentMethods.solana)) {
      return errorResponse('At least one payment method (stripe or solana) is required');
    }

    // Check if page already exists for this DID
    const existingDid = await db.query.coffeePages.findFirst({
      where: (pages, { eq }) => eq(pages.did, did),
    });

    if (existingDid) {
      return errorResponse('You already have a coffee page', 409);
    }

    // Check handle uniqueness
    const existingHandle = await db.query.coffeePages.findFirst({
      where: (pages, { eq }) => eq(pages.handle, handle),
    });

    if (existingHandle) {
      return errorResponse('Handle is already taken', 409);
    }

    // Load node config and optional scope config for fair manifest
    const rawSql = getClient();
    const [relayRow] = await rawSql`
      SELECT node_fee_bps, buyer_credit_bps, node_operator_did
      FROM relay.relay_config
      WHERE id = 'singleton'
      LIMIT 1
    `;
    const scopeDid = identity.actingAs || null;
    let scopeFeeBps: number | null = null;
    if (scopeDid) {
      const [forestRow] = await rawSql`
        SELECT scope_fee_bps
        FROM profile.forest_config
        WHERE group_did = ${scopeDid}
        LIMIT 1
      `;
      scopeFeeBps = forestRow?.scope_fee_bps ?? null;
    }
    const fairManifest = buildFairManifest({
      creatorDid: did,
      contentDid: did,
      contentType: 'coffee_page',
      scopeDid,
      scopeFeeBps,
      nodeFeeBps: relayRow?.node_fee_bps ?? undefined,
      buyerCreditBps: relayRow?.buyer_credit_bps ?? undefined,
      nodeOperatorDid: relayRow?.node_operator_did ?? undefined,
    });

    // Create page
    const [page] = await db.insert(coffeePages).values({
      id: generateId('page'),
      did,
      handle,
      title,
      bio: bio || null,
      avatar: avatar || null,
      avatarAssetId: avatarAssetId || null,
      theme: theme || {},
      paymentMethods,
      presets: presets || [100, 500, 1000],
      thankYouContent: thankYouContent || null,
      allowCustomAmount: allowCustomAmount !== false,
      allowMessages: allowMessages !== false,
      isPublic: true,
      fairManifest,
    }).returning();

    return jsonResponse(page, 201);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to create coffee page');
    return errorResponse('Failed to create coffee page', 500);
  }
}
