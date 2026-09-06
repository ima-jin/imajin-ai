import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
const log = createLogger('coffee');
import { db, coffeePages } from '@/db';
import { requireAuth , resolveActingDid } from '@imajin/auth';
import { getNodeSelf, getForestScopeConfig } from '@imajin/config';
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
  const did = resolveActingDid(identity);

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

    // Load node config (via the registry, #2000) and optional scope config for fair
    // manifest (via the profile service's public forest route, #2001)
    const nodeSelf = await getNodeSelf();
    const scopeDid = identity.actingAs || null;
    let scopeFeeBps: number | null = null;
    if (scopeDid) {
      const forestConfig = await getForestScopeConfig(scopeDid);
      scopeFeeBps = forestConfig?.scopeFeeBps ?? null;
    }
    const fairManifest = buildFairManifest({
      creatorDid: did,
      contentDid: did,
      contentType: 'coffee_page',
      scopeDid,
      scopeFeeBps,
      nodeFeeBps: nodeSelf?.nodeFeeBps ?? undefined,
      buyerCreditBps: nodeSelf?.buyerCreditBps ?? undefined,
      nodeOperatorDid: nodeSelf?.nodeOperatorDid ?? undefined,
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
