import { NextRequest } from 'next/server';
import { requireAuth } from '@/src/lib/chat/auth';
import { jsonResponse, errorResponse, corsHeaders, corsOptions } from '@/src/lib/chat/utils';
import { createWsToken } from '@/src/lib/chat/ws-tokens';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * GET /api/ws-token - Get a short-lived token for WebSocket authentication
 * Uses httpOnly session cookie (same-origin request from chat page)
 */
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status, cors);
  }

  const { identity } = authResult;
  const effectiveDid = identity.actingAs || identity.id;
  const token = createWsToken(effectiveDid);

  return jsonResponse({ token }, 200, cors);
}
