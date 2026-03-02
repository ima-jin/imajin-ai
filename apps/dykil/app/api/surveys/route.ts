import { NextRequest } from 'next/server';
import { db, surveys } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, generateId } from '@/lib/utils';
import { eq } from 'drizzle-orm';

/**
 * POST /api/surveys - Create a new survey
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const body = await request.json();
    const { title, description, fields, settings, eventId, status, type } = body;

    if (!title) {
      return errorResponse('title is required');
    }

    // Accept both SurveyJS format { elements: [...] } and legacy array format
    let surveyFields = fields;
    if (fields && typeof fields === 'object' && 'elements' in fields) {
      // Already in SurveyJS format
      if (!fields.elements || !Array.isArray(fields.elements) || fields.elements.length === 0) {
        return errorResponse('fields.elements array is required');
      }
      // Validate SurveyJS elements
      for (const element of fields.elements) {
        if (!element.name || !element.type || !element.title) {
          return errorResponse('Each field must have name, type, and title');
        }
      }
    } else if (Array.isArray(fields)) {
      // Legacy format - convert to SurveyJS
      if (fields.length === 0) {
        return errorResponse('fields array is required');
      }
      // Wrap in SurveyJS structure
      surveyFields = { elements: fields };
    } else {
      return errorResponse('fields must be an array or SurveyJS schema');
    }

    const [survey] = await db.insert(surveys).values({
      id: generateId('survey'),
      did: identity.id,
      handle: identity.handle || null,
      title,
      description: description || null,
      fields: surveyFields,
      settings: settings || {},
      eventId: eventId || null,
      type: type || 'survey',
      status: status || 'draft',
    }).returning();

    return jsonResponse(survey, 201);
  } catch (error) {
    console.error('Failed to create survey:', error);
    return errorResponse('Failed to create survey', 500);
  }
}

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
