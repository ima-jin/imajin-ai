import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
const log = createLogger('dykil');
import { db, surveys } from '@/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse, corsHeaders, corsOptions } from '@/lib/utils';

/**
 * OPTIONS /api/surveys/mine - CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * GET /api/surveys/mine - Get current user's surveys
 * Optional: ?dids=did1,did2,did3 — return surveys owned by any of those DIDs
 * (used by events edit form to show forms from all organizers)
 */
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status, cors);
  }

  const { identity } = authResult;
  const { searchParams } = new URL(request.url);
  const didsParam = searchParams.get('dids');

  try {
    let ownerDids: string[];

    if (didsParam) {
      // Return surveys for specified DIDs (caller must be one of them)
      ownerDids = didsParam.split(',').map(d => d.trim()).filter(Boolean);
      // Always include the current user
      if (!ownerDids.includes(identity.id)) {
        ownerDids.push(identity.id);
      }
    } else {
      ownerDids = [identity.id];
    }

    const userSurveys = await db.query.surveys.findMany({
      where: (surveys, { inArray }) => inArray(surveys.did, ownerDids),
      orderBy: (surveys, { desc }) => [desc(surveys.createdAt)],
    });

    return jsonResponse({ surveys: userSurveys }, 200, cors);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch surveys');
    return errorResponse('Failed to fetch surveys', 500, cors);
  }
}
