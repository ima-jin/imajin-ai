import { NextRequest } from 'next/server';
import { db, surveyResponses } from '@/db';
import { getSession } from '@/lib/auth';
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
 * GET /api/surveys/:id/responses/check - Check if current user has responded
 * 
 * Auth modes:
 *   - Session cookie → finds response by respondentDid
 *   - ?did=xxx → finds by DID (used server-side by events service)
 *   - ?responseId=xxx → finds by response ID (anonymous localStorage fallback)
 * 
 * Add ?include=answers to also return the submitted answers.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const cors = corsHeaders(request);
  const { id } = params;
  const didParam = request.nextUrl.searchParams.get('did');
  const responseIdParam = request.nextUrl.searchParams.get('responseId');
  const includeAnswers = request.nextUrl.searchParams.get('include') === 'answers';
  const skipDid = request.nextUrl.searchParams.get('skipDid') === 'true';

  try {
    let existing: any = null;

    // Priority 1: session cookie (most secure) — skip when ticket-scoped to avoid cross-ticket matches
    const session = await getSession();
    if (session?.id && !skipDid) {
      existing = await db.query.surveyResponses.findFirst({
        where: (r, { eq, and }) => and(eq(r.surveyId, id), eq(r.respondentDid, session.id)),
        columns: includeAnswers ? { id: true, answers: true } : { id: true },
      });
    }

    // Priority 2: responseId param (anonymous users with localStorage)
    if (!existing && responseIdParam) {
      existing = await db.query.surveyResponses.findFirst({
        where: (r, { eq, and }) => and(eq(r.surveyId, id), eq(r.id, responseIdParam)),
        columns: includeAnswers ? { id: true, answers: true } : { id: true },
      });
    }

    // Priority 3: DID param (server-to-server calls from events service)
    if (!existing && didParam) {
      existing = await db.query.surveyResponses.findFirst({
        where: (r, { eq, and }) => and(eq(r.surveyId, id), eq(r.respondentDid, didParam)),
        columns: includeAnswers ? { id: true, answers: true } : { id: true },
      });
    }

    const result: any = { completed: !!existing };
    if (existing && includeAnswers && existing.answers) {
      result.answers = existing.answers;
      result.responseId = existing.id;
    }

    return jsonResponse(result, 200, cors);
  } catch (error) {
    console.error('Failed to check survey response:', error);
    return errorResponse('Failed to check response', 500, cors);
  }
}
