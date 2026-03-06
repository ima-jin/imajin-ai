import { NextRequest } from 'next/server';
import { db, surveys, surveyResponses } from '@/db';
import { getSession } from '@/lib/auth';
import { jsonResponse, errorResponse, generateId, corsHeaders, corsOptions } from '@/lib/utils';
import { eq } from 'drizzle-orm';

interface RouteParams {
  params: { id: string };
}

/**
 * OPTIONS /api/surveys/:id/respond - CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * POST /api/surveys/:id/respond - Submit a response to a survey
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
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
    const { answers } = body;

    if (!answers || typeof answers !== 'object') {
      return errorResponse('answers object is required', 400, cors);
    }

    // Get optional session (for authenticated responses)
    const session = await getSession();

    // Validate answers against fields (support both legacy and SurveyJS formats)
    const surveyFields = survey.fields as any;
    const fields = surveyFields?.elements || (Array.isArray(surveyFields) ? surveyFields : []);

    for (const field of fields) {
      // Support both SurveyJS (name, title, isRequired) and legacy (id, label, required)
      const fieldName = field.name || field.id;
      const fieldLabel = field.title || field.label;
      const isRequired = field.isRequired || field.required;

      // Skip validation for conditionally visible fields whose condition isn't met
      // SurveyJS handles client-side validation; server just does basic checks
      if (field.visibleIf && isRequired) {
        // Simple check: extract the referenced field from visibleIf (e.g. "{dietary} = \"Other\"")
        const match = field.visibleIf.match(/\{(\w+)\}/);
        if (match) {
          const depField = match[1];
          const depValue = answers[depField];
          // If the dependency field doesn't match the condition, skip this field
          if (!field.visibleIf.includes(`"${depValue}"`) && !field.visibleIf.includes(`'${depValue}'`)) {
            continue;
          }
        }
      }

      if (isRequired && !answers[fieldName]) {
        return errorResponse(`Field "${fieldLabel}" is required`, 400, cors);
      }
    }

    // Create response
    const [response] = await db.insert(surveyResponses).values({
      id: generateId('response'),
      surveyId: survey.id,
      respondentDid: session?.id || null,
      answers,
    }).returning();

    return jsonResponse({ message: 'Response submitted successfully', response }, 201, cors);
  } catch (error) {
    console.error('Failed to submit response:', error);
    return errorResponse('Failed to submit response', 500, cors);
  }
}
