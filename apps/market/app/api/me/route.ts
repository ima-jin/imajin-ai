import { NextRequest } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { jsonResponse } from '@/lib/utils';

/**
 * GET /api/me — Returns current authenticated user's identity, or null.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return jsonResponse({ did: null });
  }
  const { identity } = authResult;
  return jsonResponse({ did: identity.id });
}
