import { NextRequest } from 'next/server';
import { resolveWsToken } from '../route';
import { jsonResponse, errorResponse } from '@/lib/utils';

/**
 * POST /api/ws-token/validate - Validate a WS auth token (internal use by ws-server)
 * Body: { token: string }
 */
export async function POST(request: NextRequest) {
  try {
    const { token } = await request.json();
    if (!token) {
      return errorResponse('token is required', 400);
    }

    const did = resolveWsToken(token);
    if (!did) {
      return errorResponse('Invalid or expired token', 401);
    }

    return jsonResponse({ did });
  } catch {
    return errorResponse('Invalid request', 400);
  }
}
