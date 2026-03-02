import { NextRequest } from 'next/server';
import { db, surveys } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, corsHeaders, corsOptions } from '@/lib/utils';

/**
 * OPTIONS /api/surveys/mine - CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * GET /api/surveys/mine - Get current user's surveys
 */
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status, cors);
  }

  const { identity } = authResult;

  try {
    const userSurveys = await db.query.surveys.findMany({
      where: (surveys, { eq }) => eq(surveys.did, identity.id),
      orderBy: (surveys, { desc }) => [desc(surveys.createdAt)],
    });

    return jsonResponse({ surveys: userSurveys }, 200, cors);
  } catch (error) {
    console.error('Failed to fetch surveys:', error);
    return errorResponse('Failed to fetch surveys', 500, cors);
  }
}
