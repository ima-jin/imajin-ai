import { NextRequest } from 'next/server';
import { db, surveyResponses } from '@/db';
import { jsonResponse, errorResponse, corsHeaders, corsOptions } from '@/lib/utils';
import { eq, and } from 'drizzle-orm';

interface RouteParams {
  params: { id: string };
}

/**
 * OPTIONS /api/surveys/:id/responses/check - CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * GET /api/surveys/:id/responses/check?did=xxx - Check if a DID has responded to a survey
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const cors = corsHeaders(request);
  const { id } = params;
  const did = request.nextUrl.searchParams.get('did');

  if (!did) {
    return jsonResponse({ completed: false }, 200, cors);
  }

  try {
    const existing = await db.query.surveyResponses.findFirst({
      where: (responses, { eq, and }) =>
        and(
          eq(responses.surveyId, id),
          eq(responses.respondentDid, did)
        ),
      columns: { id: true },
    });

    return jsonResponse({ completed: !!existing }, 200, cors);
  } catch (error) {
    console.error('Failed to check survey response:', error);
    return errorResponse('Failed to check response', 500, cors);
  }
}
