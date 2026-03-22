import { NextRequest } from 'next/server';
import { db } from '@/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';

/**
 * GET /api/pages/mine - Get current user's coffee page
 */
export async function GET(request: NextRequest) {
  // Require authentication
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const page = await db.query.coffeePages.findFirst({
      where: (pages, { eq }) => eq(pages.did, identity.id),
    });

    if (!page) {
      return errorResponse('No coffee page found', 404);
    }

    return jsonResponse(page);
  } catch (error) {
    console.error('Failed to fetch user coffee page:', error);
    return errorResponse('Failed to fetch coffee page', 500);
  }
}
