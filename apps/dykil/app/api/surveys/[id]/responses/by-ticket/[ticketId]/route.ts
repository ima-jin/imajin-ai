import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
const log = createLogger('dykil');
import { db, surveyResponses } from '@/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse, corsHeaders, corsOptions } from '@/lib/utils';
import { eq, and } from 'drizzle-orm';

interface RouteParams {
  params: { id: string; ticketId: string };
}

/**
 * OPTIONS /api/surveys/:id/responses/by-ticket/:ticketId - CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * GET /api/surveys/:id/responses/by-ticket/:ticketId
 *
 * Returns the survey response for a specific ticket, if one exists.
 * Auth: survey owner only.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const cors = corsHeaders(request);
  const { id: surveyId, ticketId } = params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status, cors);
  }

  const { identity } = authResult;
  const did = identity.actingAs || identity.id;

  try {
    // Verify survey ownership
    const survey = await db.query.surveys.findFirst({
      where: (surveys, { eq }) => eq(surveys.id, surveyId),
    });

    if (!survey) {
      return errorResponse('Survey not found', 404, cors);
    }

    if (survey.did !== did) {
      return errorResponse('Not authorized', 403, cors);
    }

    // Look up response by surveyId + ticketId
    const response = await db.query.surveyResponses.findFirst({
      where: (r, { eq, and }) =>
        and(eq(r.surveyId, surveyId), eq(r.ticketId, ticketId)),
    });

    if (!response) {
      return jsonResponse({ found: false }, 200, cors);
    }

    return jsonResponse(
      {
        found: true,
        response: {
          id: response.id,
          surveyId: response.surveyId,
          ticketId: response.ticketId,
          respondentDid: response.respondentDid,
          answers: response.answers,
          createdAt: response.createdAt,
        },
      },
      200,
      cors
    );
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch response by ticket');
    return errorResponse('Failed to fetch response', 500, cors);
  }
}
