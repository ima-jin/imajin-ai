import { NextRequest } from 'next/server';
import { db, surveys, surveyResponses } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq } from 'drizzle-orm';

interface RouteParams {
  params: { id: string };
}

/**
 * GET /api/surveys/:id/responses - Get all responses for a survey (owner only)
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    // Get survey and check ownership
    const survey = await db.query.surveys.findFirst({
      where: (surveys, { eq }) => eq(surveys.id, id),
    });

    if (!survey) {
      return errorResponse('Survey not found', 404);
    }

    if (survey.did !== identity.id) {
      return errorResponse('Not authorized to view responses', 403);
    }

    // Get all responses
    const responses = await db.query.surveyResponses.findMany({
      where: (surveyResponses, { eq }) => eq(surveyResponses.surveyId, id),
      orderBy: (surveyResponses, { desc }) => [desc(surveyResponses.createdAt)],
    });

    return jsonResponse({ responses, total: responses.length });
  } catch (error) {
    console.error('Failed to fetch responses:', error);
    return errorResponse('Failed to fetch responses', 500);
  }
}
