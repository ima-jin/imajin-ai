import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
const log = createLogger('dykil');
import { db, surveys } from '@/db';
import { requireAuth , resolveActingDid } from '@imajin/auth';
import { jsonResponse, errorResponse, generateId } from '@/lib/utils';

type NormalizedFields = { elements: any[] };

/**
 * Accept both SurveyJS format { elements: [...] } and legacy array format, normalizing
 * to SurveyJS shape. Returns an error message on invalid input, or the normalized fields.
 */
function normalizeSurveyFields(fields: any): { error: string } | { fields: NormalizedFields } {
  if (fields && typeof fields === 'object' && 'elements' in fields) {
    // Already in SurveyJS format
    const elements = fields.elements;
    if (!elements || !Array.isArray(elements) || elements.length === 0) {
      return { error: 'fields.elements array is required' };
    }
    // Validate SurveyJS elements
    for (const element of elements) {
      if (!element.name || !element.type || !element.title) {
        return { error: 'Each field must have name, type, and title' };
      }
    }
    return { fields: fields as NormalizedFields };
  }

  if (Array.isArray(fields)) {
    // Legacy format - convert to SurveyJS
    if (fields.length === 0) {
      return { error: 'fields array is required' };
    }
    // Wrap in SurveyJS structure
    return { fields: { elements: fields } };
  }

  return { error: 'fields must be an array or SurveyJS schema' };
}

/**
 * POST /api/surveys - Create a new survey
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;
  const did = resolveActingDid(identity);

  try {
    const body = await request.json();
    const { title, description, fields, settings, status, type } = body;

    if (!title) {
      return errorResponse('title is required');
    }

    // Accept both SurveyJS format { elements: [...] } and legacy array format
    const normalized = normalizeSurveyFields(fields);
    if ('error' in normalized) {
      return errorResponse(normalized.error);
    }
    const surveyFields = normalized.fields;

    const [survey] = await db.insert(surveys).values({
      id: generateId('survey'),
      did,
      handle: identity.handle || null,
      title,
      description: description || null,
      fields: surveyFields,
      settings: settings || {},

      type: type || 'survey',
      status: status || 'draft',
    }).returning();

    return jsonResponse(survey, 201);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to create survey');
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
  const ownerDid = resolveActingDid(identity);

  try {
    const userSurveys = await db.query.surveys.findMany({
      where: (surveys, { eq }) => eq(surveys.did, ownerDid),
      orderBy: (surveys, { desc }) => [desc(surveys.createdAt)],
    });

    return jsonResponse({ surveys: userSurveys });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch surveys');
    return errorResponse('Failed to fetch surveys', 500);
  }
}
