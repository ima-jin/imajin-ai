import { NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, corsHeaders, corsOptions } from '@/lib/utils';
import { randomBytes } from 'crypto';

/**
 * Short-lived WS auth tokens.
 * Token → DID mapping, expires after 30 seconds.
 */
const tokenStore = new Map<string, { did: string; expires: number }>();

// Clean up expired tokens periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tokenStore) {
    if (entry.expires < now) tokenStore.delete(token);
  }
}, 60000);

export function resolveWsToken(token: string): string | null {
  const entry = tokenStore.get(token);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    tokenStore.delete(token);
    return null;
  }
  tokenStore.delete(token); // one-time use
  return entry.did;
}

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
  const token = randomBytes(32).toString('hex');

  tokenStore.set(token, {
    did: identity.id,
    expires: Date.now() + 30000, // 30 seconds
  });

  return jsonResponse({ token }, 200, cors);
}
