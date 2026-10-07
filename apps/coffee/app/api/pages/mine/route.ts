import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
const log = createLogger('coffee');
import { db } from '@/db';
import { requireAuth, requireSessionOrAppToken, resolveActingDid } from '@imajin/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';

// Reference adoption (#1069 Phase 1) of the session-or-app-token adapter:
// when SESSION_COOKIE_SCOPE=host is set for THIS app's own environment,
// callers may authenticate with a scoped app token (Authorization: Bearer,
// minted via POST {kernel}/auth/api/tokens/app) instead of the shared
// session cookie. Off by default — falls back to the pre-existing
// requireAuth() cookie path, unchanged. See docs/security/cookie-isolation.md.
const USE_TOKEN_ADAPTER = process.env.SESSION_COOKIE_SCOPE === 'host';

// Audience = coffee's registry slug, never its host (#2706): the host is shared
// by every path-routed app, and the registry's `token_audiences` holds slugs.
// `IMAJIN_APP_AUD` overrides it (read inside @imajin/auth).
const APP_SLUG = 'coffee';

/**
 * GET /api/pages/mine - Get current user's coffee page
 */
export async function GET(request: NextRequest) {
  let did: string;

  if (USE_TOKEN_ADAPTER) {
    const authResult = await requireSessionOrAppToken(request, { slug: APP_SLUG });
    if ('error' in authResult) {
      return errorResponse(authResult.error, authResult.status);
    }
    did = authResult.auth.did;
  } else {
    // Require authentication
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return errorResponse(authResult.error, authResult.status);
    }
    did = resolveActingDid(authResult.identity);
  }

  try {
    const page = await db.query.coffeePages.findFirst({
      where: (pages, { eq }) => eq(pages.did, did),
    });

    if (!page) {
      return errorResponse('No coffee page found', 404);
    }

    return jsonResponse(page);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch user coffee page');
    return errorResponse('Failed to fetch coffee page', 500);
  }
}
