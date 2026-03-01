import { NextRequest } from 'next/server';
import { db, surveys } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';

/**
 * GET /api/surveys/mine - Get current user's surveys
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const userSurveys = await db.query.surveys.findMany({
      where: (surveys, { eq }) => eq(surveys.did, identity.id),
      orderBy: (surveys, { desc }) => [desc(surveys.createdAt)],
    });

    return jsonResponse({ surveys: userSurveys });
  } catch (error) {
    console.error('Failed to fetch surveys:', error);
    return errorResponse('Failed to fetch surveys', 500);
  }
}
