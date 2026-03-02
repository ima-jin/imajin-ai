import { NextRequest } from 'next/server';
import { db, surveys, surveyResponses } from '@/db';
import { getSession } from '@/lib/auth';
import { jsonResponse, errorResponse, generateId } from '@/lib/utils';
import { eq } from 'drizzle-orm';

interface RouteParams {
  params: { id: string };
}

/**
 * POST /api/surveys/:id/respond - Submit a response to a survey
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = params;

  try {
    // Get survey
    const survey = await db.query.surveys.findFirst({
      where: (surveys, { eq }) => eq(surveys.id, id),
    });

    if (!survey) {
      return errorResponse('Survey not found', 404);
    }

    if (survey.status !== 'published') {
      return errorResponse('This survey is not currently accepting responses', 403);
    }

    const body = await request.json();
    const { answers } = body;

    if (!answers || typeof answers !== 'object') {
      return errorResponse('answers object is required');
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

      if (isRequired && !answers[fieldName]) {
        return errorResponse(`Field "${fieldLabel}" is required`);
      }
    }

    // Create response
    const [response] = await db.insert(surveyResponses).values({
      id: generateId('response'),
      surveyId: survey.id,
      respondentDid: session?.id || null,
      answers,
    }).returning();

    return jsonResponse({ message: 'Response submitted successfully', response }, 201);
  } catch (error) {
    console.error('Failed to submit response:', error);
    return errorResponse('Failed to submit response', 500);
  }
}
