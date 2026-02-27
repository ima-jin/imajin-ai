import { NextRequest } from 'next/server';
import { db, coffeePages } from '@/db';
import { requireAuth } from '@/lib/auth';
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

  try {
    const body = await request.json();
    const { 
      handle, 
      title, 
      bio, 
      avatar, 
      theme,
      paymentMethods,
      presets,
      allowCustomAmount,
      allowMessages,
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
      where: (pages, { eq }) => eq(pages.did, identity.id),
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

    // Create page
    const [page] = await db.insert(coffeePages).values({
      id: generateId('page'),
      did: identity.id,
      handle,
      title,
      bio: bio || null,
      avatar: avatar || null,
      theme: theme || {},
      paymentMethods,
      presets: presets || [100, 500, 1000],
      allowCustomAmount: allowCustomAmount !== false,
      allowMessages: allowMessages !== false,
      isPublic: true,
    }).returning();

    return jsonResponse(page, 201);
  } catch (error) {
    console.error('Failed to create coffee page:', error);
    return errorResponse('Failed to create coffee page', 500);
  }
}
