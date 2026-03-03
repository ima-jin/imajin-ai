import { NextRequest } from 'next/server';
import { db, surveys, surveyResponses } from '@/db';
import { jsonResponse, errorResponse, corsHeaders, corsOptions } from '@/lib/utils';
import { eq, and, sql } from 'drizzle-orm';

interface RouteParams {
  params: { eventId: string };
}

/**
 * OPTIONS /api/surveys/event/:eventId - CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * GET /api/surveys/event/:eventId - Get surveys linked to an event
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const cors = corsHeaders(request);
  const { eventId } = params;

  try {
    // Get all surveys for this event
    const eventSurveys = await db.query.surveys.findMany({
      where: (surveys, { eq, and }) =>
        and(
          eq(surveys.eventId, eventId),
          eq(surveys.status, 'published')
        ),
      orderBy: (surveys, { asc }) => [asc(surveys.createdAt)],
    });

    // Get response counts for each survey
    const surveysWithCounts = await Promise.all(
      eventSurveys.map(async (survey) => {
        const [countResult] = await db
          .select({ count: sql<number>`count(*)` })
          .from(surveyResponses)
          .where(eq(surveyResponses.surveyId, survey.id));

        return {
          id: survey.id,
          title: survey.title,
          description: survey.description,
          type: survey.type,
          handle: survey.handle,
          responseCount: Number(countResult?.count || 0),
        };
      })
    );

    return jsonResponse({ surveys: surveysWithCounts }, 200, cors);
  } catch (error) {
    console.error('Failed to fetch event surveys:', error);
    return errorResponse('Failed to fetch event surveys', 500, cors);
  }
}
