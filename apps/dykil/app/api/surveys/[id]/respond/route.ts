import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
const log = createLogger('dykil');
import { db, surveyResponses } from '@/db';
import { getSession } from '@imajin/auth';
import { jsonResponse, errorResponse, generateId, corsHeaders, corsOptions } from '@/lib/utils';
import { eq } from 'drizzle-orm';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * OPTIONS /api/surveys/:id/respond - CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/** Loosely-typed survey answers payload, keyed by field name */
type SurveyAnswers = Record<string, any>;

/** Extract the fields array from a survey's fields column (SurveyJS or legacy format) */
function extractSurveyFields(survey: { fields: unknown }) {
  const surveyFields = survey.fields as any;
  return surveyFields?.elements || (Array.isArray(surveyFields) ? surveyFields : []);
}

/**
 * Determine whether a conditionally-visible field's `visibleIf` condition is met,
 * given the submitted answers. Fields without a `visibleIf` are always considered visible.
 */
function isFieldConditionMet(visibleIf: string | undefined, answers: SurveyAnswers): boolean {
  if (!visibleIf) return true;

  // Simple check: extract the referenced field from visibleIf (e.g. "{dietary} = \"Other\"")
  const match = /\{(\w+)\}/.exec(visibleIf);
  if (!match) return true;

  const depField = match[1];
  const depValue = answers[depField];
  // If the dependency field doesn't match the condition, it's not visible
  return visibleIf.includes(`"${depValue}"`) || visibleIf.includes(`'${depValue}'`);
}

/**
 * Validate submitted answers against a survey's field definitions (support both legacy
 * and SurveyJS formats). Returns an error message for the first missing required field,
 * or null if all required fields are satisfied.
 */
function findMissingRequiredField(fields: any[], answers: SurveyAnswers): string | null {
  for (const field of fields) {
    // Support both SurveyJS (name, title, isRequired) and legacy (id, label, required)
    const fieldName = field.name || field.id;
    const fieldLabel = field.title || field.label;
    const isRequired = field.isRequired || field.required;

    // Skip validation for conditionally visible fields whose condition isn't met
    // SurveyJS handles client-side validation; server just does basic checks
    if (isRequired && field.visibleIf && !isFieldConditionMet(field.visibleIf, answers)) {
      continue;
    }

    if (isRequired && !answers[fieldName]) {
      return `Field "${fieldLabel}" is required`;
    }
  }

  return null;
}

/**
 * Find an existing response for this survey (upsert lookup). Skip upsert when `forceNew`
 * is set (ticket-scoped: each ticket gets its own response). Ticket-scoped lookup takes
 * priority over session-based lookup.
 */
async function findExistingResponse(
  surveyId: string,
  session: { id: string } | null,
  forceNew: boolean,
  ticketId: string | null
) {
  if (ticketId) {
    return db.query.surveyResponses.findFirst({
      where: (r, { eq, and }) => and(eq(r.surveyId, surveyId), eq(r.ticketId, ticketId)),
    });
  }

  if (session?.id && !forceNew) {
    return db.query.surveyResponses.findFirst({
      where: (r, { eq, and }) => and(eq(r.surveyId, surveyId), eq(r.respondentDid, session.id)),
    });
  }

  return null;
}

/**
 * POST /api/surveys/:id/respond - Submit a response to a survey
 */
export async function POST(request: NextRequest, props: RouteParams) {
  const params = await props.params;
  const cors = corsHeaders(request);
  const { id } = params;

  try {
    // Get survey
    const survey = await db.query.surveys.findFirst({
      where: (surveys, { eq }) => eq(surveys.id, id),
    });

    if (!survey) {
      return errorResponse('Survey not found', 404, cors);
    }

    if (survey.status !== 'published') {
      return errorResponse('This survey is not currently accepting responses', 403, cors);
    }

    const body = await request.json();
    const { answers, forceNew, ticketId } = body;

    if (!answers || typeof answers !== 'object') {
      return errorResponse('answers object is required', 400, cors);
    }

    // Get optional session (for authenticated responses)
    const session = await getSession();

    // Validate answers against fields (support both legacy and SurveyJS formats)
    const fields = extractSurveyFields(survey);
    const missingFieldError = findMissingRequiredField(fields, answers);
    if (missingFieldError) {
      return errorResponse(missingFieldError, 400, cors);
    }

    // Check for existing response (upsert: update if exists, create if not)
    const existing = await findExistingResponse(survey.id, session, !!forceNew, ticketId);

    if (existing) {
      // Update existing response
      const [response] = await db.update(surveyResponses)
        .set({ answers })
        .where(eq(surveyResponses.id, existing.id))
        .returning();
      return jsonResponse({ message: 'Response updated successfully', response }, 200, cors);
    }

    // Validate ticketId format if provided
    if (ticketId && !ticketId.startsWith('tkt_')) {
      return errorResponse('Invalid ticketId format', 400, cors);
    }

    // Create new response
    const [response] = await db.insert(surveyResponses).values({
      id: generateId('response'),
      surveyId: survey.id,
      respondentDid: session?.id || null,
      ticketId: ticketId || null,
      answers,
    }).returning();

    return jsonResponse({ message: 'Response submitted successfully', response }, 201, cors);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to submit response');
    return errorResponse('Failed to submit response', 500, cors);
  }
}
